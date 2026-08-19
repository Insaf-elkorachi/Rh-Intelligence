from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.core.config import settings
from app.core.security import require_rh_role
from app.services.agent_runtime_service import agent_runtime_service
from app.services.auth_service import seed_default_users


app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix=settings.api_prefix)

WEB_DIR = Path(__file__).resolve().parent / "web"
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.on_event("startup")
async def on_startup() -> None:
    # Cree les comptes de demonstration (rh.nador / admin.nador / manager.nador,
    # mot de passe "sonasid2026") si la collection users est vide.
    await seed_default_users()


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "app": settings.app_name,
        "status": "running",
        "docs": "/docs",
        "site": "/app",
    }


@app.get("/app", response_class=FileResponse)
async def web_app() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/candidate", response_class=FileResponse)
async def candidate_app() -> FileResponse:
    return FileResponse(WEB_DIR / "candidate.html")



@app.post("/rh/cv/analyze")
async def analyze_cv_files_direct(
    files: list[UploadFile] = File(...),
    job_id: str | None = Form(default=None),
    _: str = Depends(require_rh_role),
) -> dict:
    return await agent_runtime_service.analyze_cv_files(files=files, job_id=job_id)


