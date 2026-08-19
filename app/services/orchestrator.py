from pathlib import Path

from app.agents.cv_processing_agent import CVProcessingAgent
from app.agents.embedding_agent import EmbeddingAgent
from app.agents.import_excel_agent import ImportExcelAgent
from app.agents.scoring_agent import ScoringAgent
from app.db.collections import CANDIDATS, CV_DOCUMENTS, EMPLOYES
from app.db.mongo import get_database
from app.models.common import new_id, now_utc


class Orchestrator:
    def __init__(self) -> None:
        self.import_excel_agent = ImportExcelAgent()
        self.cv_processing_agent = CVProcessingAgent()
        self.embedding_agent = EmbeddingAgent()
        self.scoring_agent = ScoringAgent()

    async def run_excel_import(self, file_path: str, collection_name: str = EMPLOYES) -> dict:
        return await self.import_excel_agent.import_file(file_path, collection_name)

    async def run_rh_cv_upload(
        self,
        file_path: str,
        nom: str,
        prenom: str,
        email: str | None,
        telephone: str | None,
        poste_souhaite: str | None,
        uploaded_by_role: str,
    ) -> dict:
        db = get_database()
        candidate_id = new_id("CAND")
        cv_id = new_id("CV")

        text = self.cv_processing_agent.extract_text(file_path)
        profile = self.cv_processing_agent.extract_profile(text)
        embedding = self.embedding_agent.embed_text(text)
        scoring = self.scoring_agent.score_candidate(profile)

        candidate_document = {
            "candidate_id": candidate_id,
            "nom": nom,
            "prenom": prenom,
            "email": email,
            "telephone": telephone,
            "poste_souhaite": poste_souhaite,
            "source": "depot_rh",
            "status": "cv_analyse",
            "created_at": now_utc(),
            "updated_at": now_utc(),
        }
        cv_document = {
            "cv_id": cv_id,
            "candidate_id": candidate_id,
            "file_name": Path(file_path).name,
            "file_path": file_path,
            "text": text,
            "profile": profile,
            "embedding": embedding,
            "scoring": scoring,
            "uploaded_by_role": uploaded_by_role,
            "created_at": now_utc(),
        }

        await db[CANDIDATS].insert_one(candidate_document)
        await db[CV_DOCUMENTS].insert_one(cv_document)
        await self.cv_processing_agent.save_run(
            "rh_cv_upload",
            "success",
            {
                "candidate_id": candidate_id,
                "cv_id": cv_id,
                "score": scoring["score"],
            },
        )

        return {
            "candidate_id": candidate_id,
            "cv_id": cv_id,
            "status": "cv_analyse",
            "score": scoring["score"],
            "recommendation": scoring["recommendation"],
        }


orchestrator = Orchestrator()
