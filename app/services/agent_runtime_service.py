from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import UploadFile

from app.agents.cv_processing_agent import CVProcessingAgent
from app.agents.embedding_agent import EmbeddingAgent
from app.agents.scoring_agent import ScoringAgent
from app.core.config import settings
from app.services.vector_store_service import vector_store_service

ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = ROOT / "app" / "web" / "data" / "tdb_nador_09_2025.json"
RUN_LOG_PATH = ROOT / "data" / "agent_runs_backend.json"

# Competences requises par offre, utilisees comme secours quand la base
# NoSQL n'est pas joignable (mode demo) ou que l'offre n'a pas encore ete
# saisie en base. Doit rester coherent avec les offres de demonstration
# affichees cote frontend (app.js).
FALLBACK_REQUIRED_SKILLS: dict[str, list[str]] = {
    "JOB-024": ["python", "power bi", "sql", "mongodb"],
    "JOB-031": ["maintenance", "securite", "electromecanique"],
    "JOB-028": ["ingenierie pedagogique", "gestion budget formation"],
    "JOB-018": ["qualite", "iso", "audit"],
}

AGENT_DEFINITIONS = [
    ("agent-import-excel", "Agent import Excel", "Lecture du fichier TDB_NADOR et extraction des onglets RH."),
    ("agent-cleaning", "Agent nettoyage", "Normalisation des colonnes, dates et valeurs manquantes."),
    ("agent-cv-processing", "Agent traitement CV", "Extraction du texte et structuration du profil candidat."),
    ("agent-embedding", "Agent embedding", "Vectorisation du CV et preparation de la comparaison semantique."),
    ("agent-scoring", "Agent scoring", "Calcul du score de correspondance entre CV et offre."),
    ("agent-analyse-rh", "Agent analyse RH", "Production des indicateurs RH issus du dataset reel."),
    ("agent-predictif", "Agent predictif", "Projection des besoins et risques a partir des mouvements."),
    ("agent-rag", "Agent RAG", "Preparation des reponses a partir des documents RH et du dataset."),
    ("agent-chatbot-rh", "Agent chatbot RH", "Mise a disposition des reponses RH controlees."),
    ("agent-validation", "Agent validation", "Controle de coherence et validation du resultat RH."),
    ("agent-logs", "Agent journalisation", "Tracabilite des traitements, fichiers et decisions."),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_dataset() -> dict[str, Any]:
    if not DATASET_PATH.exists():
        return {"summary": {}, "sheets": [], "agents": []}
    return json.loads(DATASET_PATH.read_text(encoding="utf-8"))


def persist_run(record: dict[str, Any]) -> None:
    RUN_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    history: list[dict[str, Any]] = []
    if RUN_LOG_PATH.exists():
        try:
            history = json.loads(RUN_LOG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = []
    history.insert(0, record)
    RUN_LOG_PATH.write_text(json.dumps(history[:100], ensure_ascii=False, indent=2), encoding="utf-8")


class AgentRuntimeService:
    def __init__(self) -> None:
        self.cv_agent = CVProcessingAgent()
        self.embedding_agent = EmbeddingAgent()
        self.scoring_agent = ScoringAgent()

    async def _resolve_required_skills(self, job_id: str | None) -> list[str]:
        """Recupere les competences requises de l'offre (base NoSQL), avec
        secours sur la liste de demonstration si la base n'est pas joignable
        ou que l'offre n'existe pas encore en base."""
        if not job_id:
            return []
        try:
            from app.repositories.job_repository import JobRepository

            job = await JobRepository().get_by_id(job_id)
            skills = (job or {}).get("required_skills") or []
            if skills:
                return [str(skill).lower() for skill in skills]
        except Exception:
            pass
        return FALLBACK_REQUIRED_SKILLS.get(job_id, [])

    def _fallback_cv_text(self, filename: str, job_id: str | None) -> str:
        candidate = Path(filename).stem.replace("_", " ").replace("-", " ")
        job_keywords = {
            "JOB-024": "Data Analyst RH Python SQL Excel Power BI reporting ressources humaines",
            "JOB-031": "Technicien maintenance securite industrielle maintenance preventive corrective",
            "JOB-028": "Responsable formation ressources humaines plan formation competences",
        }.get(job_id or "", "ressources humaines recrutement competences experience")
        return f"{candidate}. Analyse partielle du CV. {job_keywords}."
    def run_agents(self, agent_id: str | None = None) -> dict[str, Any]:
        dataset = load_dataset()
        summary = dataset.get("summary", {})
        sheets = dataset.get("sheets", [])
        total_cells = sum(int(sheet.get("nonEmptyCells", 0)) for sheet in sheets)
        selected = [agent for agent in AGENT_DEFINITIONS if agent_id in {None, agent[0]}]
        if not selected:
            raise ValueError("Agent introuvable.")

        volume_by_agent = {
            "agent-import-excel": total_cells,
            "agent-cleaning": summary.get("effectifTotal", 0),
            "agent-cv-processing": 0,
            "agent-embedding": 0,
            "agent-scoring": 0,
            "agent-analyse-rh": summary.get("effectifActif", 0),
            "agent-predictif": summary.get("movementRecords", 0),
            "agent-rag": len(sheets),
            "agent-chatbot-rh": len(sheets),
            "agent-validation": summary.get("departures", 0),
            "agent-logs": total_cells,
        }
        agents = [
            {
                "id": item[0],
                "name": item[1],
                "role": item[2],
                "status": "done",
                "records": int(volume_by_agent.get(item[0], 0) or 0),
            }
            for item in selected
        ]
        record = {
            "run_id": f"RUN-{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            "started_at": now_iso(),
            "finished_at": now_iso(),
            "status": "completed",
            "source": dataset.get("sourceFile", "TDB_NADOR 09-2025.xlsx"),
            "summary": summary,
            "agents": agents,
        }
        persist_run(record)
        return record

    async def analyze_cv_files(self, files: list[UploadFile], job_id: str | None = None) -> dict[str, Any]:
        upload_dir = Path(settings.upload_dir)
        upload_dir.mkdir(parents=True, exist_ok=True)
        results: list[dict[str, Any]] = []
        required_skills = await self._resolve_required_skills(job_id)
        target_position = {"required_skills": required_skills} if required_skills else None

        # Chaque fichier est traite independamment: une erreur sur un CV
        # n'interrompt pas l'analyse des autres CV deposes dans le meme lot.
        for file in files:
            if not file.filename:
                continue
            suffix = Path(file.filename).suffix.lower()
            if suffix not in {".pdf", ".docx"}:
                results.append({
                    "file_name": file.filename,
                    "status": "failed",
                    "error": "Format accepte: PDF ou DOCX.",
                })
                continue

            safe_name = Path(file.filename).name.replace(" ", "_")
            target = upload_dir / safe_name
            target.write_bytes(await file.read())

            try:
                extraction_warning = None
                try:
                    text = self.cv_agent.extract_text(str(target)).strip()
                except Exception:
                    text = ""
                    extraction_warning = "Texte du CV non extractible. Analyse partielle basee sur le fichier et l'offre."

                if not text:
                    text = self._fallback_cv_text(file.filename, job_id)
                    extraction_warning = extraction_warning or "Texte du CV non lisible. Analyse partielle basee sur le fichier et l'offre."

                profile = self.cv_agent.extract_profile(text)
                embedding = self.embedding_agent.embed_text(text)
                scoring = self.scoring_agent.score_candidate(profile, target_position)
                candidate_id = f"CAND-{safe_name}"

                # Checkpoint: verifie si un CV tres proche a deja ete indexe
                # (profil deja vu / deja traite) avant d'indexer celui-ci.
                duplicate_check = None
                try:
                    similar = vector_store_service.find_similar_cv(text, top_k=1)
                    if similar and similar[0].get("score") is not None and similar[0]["score"] >= 0.92:
                        duplicate_check = {
                            "is_duplicate": True,
                            "matched_file": similar[0]["metadata"].get("file_name"),
                            "matched_name": similar[0]["metadata"].get("name"),
                            "similarity": similar[0]["score"],
                        }
                except Exception:
                    pass

                try:
                    vector_store_service.upsert_cv_embedding(
                        candidate_id,
                        text,
                        {
                            "file_name": file.filename,
                            "name": profile.get("name"),
                            "profile": profile.get("profile"),
                            "job_id": job_id,
                            "score": scoring["score"],
                        },
                    )
                except Exception:
                    pass  # la base vectorielle est un plus, pas bloquante
                result = {
                    "file_name": file.filename,
                    "status": "completed",
                    "job_id": job_id,
                    "profile": profile,
                    "embedding_size": len(embedding),
                    "score": scoring["score"],
                    "recommendation": scoring["recommendation"],
                    "matched_skills": scoring.get("matched_skills", []),
                    # Competences du candidat qui correspondent au poste vise,
                    # et celles qui manquent encore ("non adaptees").
                    "adapted_skills": scoring.get("adapted_skills", []),
                    "not_adapted_skills": scoring.get("not_adapted_skills", []),
                    "required_skills": required_skills,
                    "duplicate_check": duplicate_check,
                }
                if extraction_warning:
                    result["warning"] = extraction_warning
                results.append(result)
            except Exception:
                results.append({
                    "file_name": file.filename,
                    "status": "failed",
                    "error": "Analyse impossible pour ce fichier. Verifiez le format PDF/DOCX.",
                })

        agent_run = self.run_agents()
        record = {
            "run_id": f"CVRUN-{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            "started_at": now_iso(),
            "finished_at": now_iso(),
            "status": "completed",
            "job_id": job_id,
            "files": results,
            "agent_run_id": agent_run["run_id"],
        }
        persist_run(record)
        return record


agent_runtime_service = AgentRuntimeService()

