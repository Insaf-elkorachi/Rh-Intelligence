from typing import Any

from fastapi import HTTPException, status

from app.agents.embedding_agent import EmbeddingAgent
from app.db.collections import AUDIT_LOGS, NOTIFICATIONS
from app.db.mongo import get_database
from app.models.common import new_id, now_utc
from app.repositories.job_repository import JobRepository
from app.schemas.job import JobCreate, JobUpdate
from app.services.vector_store_service import vector_store_service


class JobService:
    def __init__(self) -> None:
        self.repository = JobRepository()
        self.embedding_agent = EmbeddingAgent()

    def build_normalized_text(self, document: dict[str, Any]) -> str:
        parts = [
            document.get("title"),
            document.get("department"),
            document.get("description"),
            " ".join(document.get("responsibilities") or []),
            " ".join(document.get("required_skills") or []),
            " ".join(document.get("preferred_skills") or []),
            document.get("education_level"),
            " ".join(document.get("languages") or []),
            " ".join(document.get("certifications") or []),
            document.get("contract_type"),
            document.get("location"),
        ]
        return "\n".join(str(part).strip() for part in parts if part)

    def _serialize(self, document: dict[str, Any]) -> dict[str, Any]:
        serialized = document.copy()
        for key in ("opening_date", "closing_date"):
            value = serialized.get(key)
            if value is not None and hasattr(value, "isoformat"):
                serialized[key] = value.isoformat()
        return serialized

    async def _audit(self, action: str, actor_role: str, target_id: str, payload: dict[str, Any] | None = None) -> None:
        db = get_database()
        await db[AUDIT_LOGS].insert_one(
            {
                "audit_id": new_id("AUDIT"),
                "action": action,
                "actor_role": actor_role,
                "target_type": "job",
                "target_id": target_id,
                "payload": payload or {},
                "created_at": now_utc(),
            }
        )

    async def _publish_event(self, event: str, data: dict[str, Any]) -> None:
        db = get_database()
        await db[NOTIFICATIONS].insert_one(
            {
                "notification_id": new_id("NOTIF"),
                "event": event,
                "data": data,
                "read": False,
                "created_at": now_utc(),
            }
        )

    async def create_job(self, payload: JobCreate, created_by: str) -> dict[str, Any]:
        existing = await self.repository.get_by_reference(payload.reference)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Une offre avec cette reference existe deja.",
            )

        document = self._serialize(payload.model_dump())
        document["job_id"] = new_id("JOB")
        document["created_by"] = created_by
        document["created_at"] = now_utc()
        document["updated_at"] = now_utc()
        document["deleted_at"] = None
        document["normalized_text"] = self.build_normalized_text(document)
        document["embedding"] = self.embedding_agent.embed_text(document["normalized_text"])

        created = await self.repository.create(document)
        try:
            vector_store_service.upsert_job_embedding(
                created["job_id"], document["normalized_text"], {"title": document.get("title"), "status": document.get("status")}
            )
        except Exception:
            pass
        await self._audit("job_created", created_by, created["job_id"], {"reference": created["reference"]})
        await self._publish_event("job_created", {"job_id": created["job_id"], "status": created["status"]})
        return created

    async def update_job(self, job_id: str, payload: JobUpdate, actor_role: str) -> dict[str, Any]:
        current = await self.repository.get_by_id(job_id)
        if not current:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offre introuvable.")

        changes = payload.model_dump(exclude_unset=True)
        changes = self._serialize(changes)
        if "reference" in changes and changes["reference"] != current["reference"]:
            existing = await self.repository.get_by_reference(changes["reference"])
            if existing:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reference deja utilisee.")

        merged = {**current, **changes}
        changes["normalized_text"] = self.build_normalized_text(merged)
        changes["embedding"] = self.embedding_agent.embed_text(changes["normalized_text"])
        changes["updated_at"] = now_utc()

        updated = await self.repository.update(job_id, changes)
        if not updated:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offre introuvable.")
        try:
            vector_store_service.upsert_job_embedding(
                job_id, changes["normalized_text"], {"title": updated.get("title"), "status": updated.get("status")}
            )
        except Exception:
            pass

        await self._audit("job_updated", actor_role, job_id, {"changes": list(changes.keys())})
        await self._publish_event("job_updated", {"job_id": job_id, "status": updated["status"]})
        return updated

    async def get_job(self, job_id: str) -> dict[str, Any]:
        job = await self.repository.get_by_id(job_id)
        if not job:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offre introuvable.")
        return job

    async def list_jobs(self, status_value: str | None, department: str | None, search: str | None, limit: int, skip: int) -> dict[str, Any]:
        items, total = await self.repository.list(
            {"status": status_value, "department": department, "search": search},
            limit=limit,
            skip=skip,
        )
        return {"items": items, "total": total}

    async def change_status(self, job_id: str, new_status: str, actor_role: str) -> dict[str, Any]:
        return await self.update_job(job_id, JobUpdate(status=new_status), actor_role)

    async def logical_delete(self, job_id: str, actor_role: str) -> dict[str, Any]:
        current = await self.repository.get_by_id(job_id)
        if not current:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offre introuvable.")
        updated = await self.repository.update(job_id, {"deleted_at": now_utc(), "updated_at": now_utc()})
        await self._audit("job_deleted", actor_role, job_id)
        await self._publish_event("job_deleted", {"job_id": job_id})
        return updated or current
