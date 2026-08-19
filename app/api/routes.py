from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.core.security import require_admin_role, require_read_role, require_rh_role, require_user
from app.db.collections import CANDIDATS, CV_DOCUMENTS, EMPLOYES, JOBS
from app.db.mongo import get_database
from app.schemas.auth import LoginRequest, LoginResponse
from app.schemas.chatbot import ChatRequest, ChatResponse
from app.schemas.job import JobCreate, JobListResponse, JobResponse, JobStatus, JobUpdate
from app.services.auth_service import authenticate_user
from app.services.job_service import JobService
from app.services.orchestrator import orchestrator
from app.services.agent_runtime_service import agent_runtime_service
from app.services.chatbot_service import chatbot_service
from app.services.vector_store_service import vector_store_service

router = APIRouter()


@router.post("/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest) -> dict:
    """Authentification reelle: verifie le mot de passe (hache en base) et
    renvoie un jeton JWT. Les routes RH exigent ensuite ce jeton
    (Authorization: Bearer ...) au lieu d'un simple en-tete declaratif."""
    return await authenticate_user(payload.username, payload.password)


def _safe_upload_path(filename: str) -> Path:
    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(filename).name.replace(" ", "_")
    return upload_dir / safe_name


async def _save_upload(file: UploadFile) -> str:
    target = _safe_upload_path(file.filename or "upload.bin")
    content = await file.read()
    target.write_bytes(content)
    return str(target)


def get_job_service() -> JobService:
    return JobService()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(_: str = Depends(require_read_role)) -> str:
    db = get_database()
    employes_count = await db[EMPLOYES].count_documents({})
    candidats_count = await db[CANDIDATS].count_documents({})
    cv_count = await db[CV_DOCUMENTS].count_documents({})
    open_jobs_count = await db[JOBS].count_documents({"status": "open", "deleted_at": None})
    latest = (
        await db[CV_DOCUMENTS]
        .find({}, {"_id": 0, "candidate_id": 1, "file_name": 1, "scoring": 1, "created_at": 1})
        .sort("created_at", -1)
        .limit(10)
        .to_list(length=10)
    )
    rows = "".join(
        f"<tr><td>{item.get('candidate_id')}</td><td>{item.get('file_name')}</td>"
        f"<td>{item.get('scoring', {}).get('score', '')}</td>"
        f"<td>{item.get('scoring', {}).get('recommendation', '')}</td></tr>"
        for item in latest
    )

    return f"""
    <!doctype html>
    <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Dashboard RH SONASID</title>
      <style>
        body {{ font-family: Arial, sans-serif; margin: 0; background: #f6f7f9; color: #17202a; }}
        header {{ background: #12355b; color: white; padding: 20px 32px; }}
        main {{ padding: 24px 32px; }}
        .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }}
        .card {{ background: white; border: 1px solid #dde2e8; border-radius: 8px; padding: 16px; }}
        .metric {{ font-size: 32px; font-weight: 700; }}
        form {{ display: grid; gap: 12px; max-width: 720px; }}
        input, button {{ padding: 10px; font-size: 14px; }}
        button {{ background: #1f6feb; color: white; border: 0; border-radius: 6px; cursor: pointer; }}
        table {{ width: 100%; border-collapse: collapse; background: white; }}
        th, td {{ padding: 10px; border-bottom: 1px solid #dde2e8; text-align: left; }}
      </style>
    </head>
    <body>
      <header>
        <h1>Dashboard RH SONASID</h1>
        <p>Acces interne RH - depot et analyse des CV</p>
      </header>
      <main>
        <section class="grid">
          <div class="card"><div>Offres ouvertes</div><div class="metric">{open_jobs_count}</div></div>
          <div class="card"><div>Employes</div><div class="metric">{employes_count}</div></div>
          <div class="card"><div>Candidats</div><div class="metric">{candidats_count}</div></div>
          <div class="card"><div>CV analyses</div><div class="metric">{cv_count}</div></div>
        </section>

        <section class="card" style="margin-top: 20px;">
          <h2>Depot CV par le service RH</h2>
          <form method="post" action="/api/v1/rh/cv" enctype="multipart/form-data">
            <input name="nom" placeholder="Nom" required />
            <input name="prenom" placeholder="Prenom" required />
            <input name="email" placeholder="Email" />
            <input name="telephone" placeholder="Telephone" />
            <input name="poste_souhaite" placeholder="Poste souhaite" />
            <input name="file" type="file" accept=".pdf,.docx" required />
            <button type="submit">Importer et analyser</button>
          </form>
        </section>

        <section style="margin-top: 20px;">
          <h2>Derniers CV traites</h2>
          <table>
            <thead><tr><th>Candidat</th><th>Fichier</th><th>Score</th><th>Recommendation</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </section>
      </main>
    </body>
    </html>
    """


@router.post("/chatbot/message", response_model=ChatResponse)
async def chatbot_message(payload: ChatRequest, user: dict = Depends(require_user("admin", "rh"))) -> dict:
    result = await chatbot_service.answer(payload.message, user, payload.context)
    chatbot_service.remember(user, result.get("context"))
    return {
        "answer": result["reply"],
        "requires_confirmation": result["pending_action"] is not None,
        "action_preview": result["pending_action"],
        "context": result.get("context"),
    }


@router.post("/chatbot/confirm", response_model=ChatResponse)
async def chatbot_confirm(payload: dict = Body(...), user: dict = Depends(require_user("admin", "rh"))) -> dict:
    """Execute une action proposee par le chatbot UNIQUEMENT si le service RH
    la confirme explicitement ici. Rien n'est jamais modifie depuis
    /chatbot/message seul."""
    try:
        result = await chatbot_service.confirm(payload.get("action_preview"), user)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    context = dict(payload.get("context") or {})
    context.pop("pending_action", None)
    chatbot_service.remember(user, context)
    return {"answer": result["reply"], "requires_confirmation": False, "action_preview": None, "context": context}


@router.post("/agents/run")
async def run_agents_backend(
    payload: dict | None = Body(default=None),
    _: str = Depends(require_rh_role),
) -> dict:
    try:
        agent_id = (payload or {}).get("agent_id")
        return agent_runtime_service.run_agents(agent_id=agent_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/rh/cv/analyze")
async def analyze_cv_files_backend(
    files: list[UploadFile] = File(...),
    job_id: str | None = Form(default=None),
    _: str = Depends(require_rh_role),
) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier CV re?u.")
    return await agent_runtime_service.analyze_cv_files(files=files, job_id=job_id)


@router.post("/jobs", response_model=JobResponse, status_code=201)
async def create_job(
    payload: JobCreate,
    role: str = Depends(require_rh_role),
    service: JobService = Depends(get_job_service),
) -> dict:
    return await service.create_job(payload, created_by=role)


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    status: JobStatus | None = None,
    department: str | None = None,
    search: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    _: str = Depends(require_read_role),
    service: JobService = Depends(get_job_service),
) -> dict:
    return await service.list_jobs(status, department, search, limit, skip)


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: str,
    _: str = Depends(require_read_role),
    service: JobService = Depends(get_job_service),
) -> dict:
    return await service.get_job(job_id)


@router.patch("/jobs/{job_id}", response_model=JobResponse)
async def update_job(
    job_id: str,
    payload: JobUpdate,
    role: str = Depends(require_rh_role),
    service: JobService = Depends(get_job_service),
) -> dict:
    return await service.update_job(job_id, payload, role)


@router.post("/jobs/{job_id}/open", response_model=JobResponse)
async def open_job(job_id: str, role: str = Depends(require_rh_role), service: JobService = Depends(get_job_service)) -> dict:
    return await service.change_status(job_id, "open", role)


@router.post("/jobs/{job_id}/close", response_model=JobResponse)
async def close_job(job_id: str, role: str = Depends(require_rh_role), service: JobService = Depends(get_job_service)) -> dict:
    return await service.change_status(job_id, "closed", role)


@router.post("/jobs/{job_id}/archive", response_model=JobResponse)
async def archive_job(job_id: str, role: str = Depends(require_rh_role), service: JobService = Depends(get_job_service)) -> dict:
    return await service.change_status(job_id, "archived", role)


@router.delete("/jobs/{job_id}", response_model=JobResponse)
async def delete_job(
    job_id: str,
    role: str = Depends(require_admin_role),
    service: JobService = Depends(get_job_service),
) -> dict:
    return await service.logical_delete(job_id, role)


@router.post("/import/excel")
async def import_excel(
    file: UploadFile = File(...),
    collection_name: str = Form(default=EMPLOYES),
    _: str = Depends(require_rh_role),
) -> dict:
    path = await _save_upload(file)
    return await orchestrator.run_excel_import(path, collection_name)


@router.post("/rh/cv")
async def upload_cv_by_rh(
    nom: str = Form(...),
    prenom: str = Form(...),
    email: str | None = Form(default=None),
    telephone: str | None = Form(default=None),
    poste_souhaite: str | None = Form(default=None),
    file: UploadFile = File(...),
    role: str = Depends(require_rh_role),
) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Fichier CV manquant.")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".pdf", ".docx"}:
        raise HTTPException(status_code=400, detail="Format accepte: PDF ou DOCX.")

    path = await _save_upload(file)
    return await orchestrator.run_rh_cv_upload(
        file_path=path,
        nom=nom,
        prenom=prenom,
        email=email,
        telephone=telephone,
        poste_souhaite=poste_souhaite,
        uploaded_by_role=role,
    )


@router.get("/rh/candidats")
async def list_candidates(_: str = Depends(require_read_role)) -> list[dict]:
    db = get_database()
    return await db[CANDIDATS].find({}, {"_id": 0}).sort("created_at", -1).limit(100).to_list(length=100)

