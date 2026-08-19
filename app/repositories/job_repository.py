from typing import Any

from app.db.collections import JOBS
from app.db.mongo import get_database


class JobRepository:
    def __init__(self) -> None:
        self.collection = get_database()[JOBS]

    async def create(self, document: dict[str, Any]) -> dict[str, Any]:
        await self.collection.insert_one(document)
        return document

    async def get_by_id(self, job_id: str, include_deleted: bool = False) -> dict[str, Any] | None:
        query: dict[str, Any] = {"job_id": job_id}
        if not include_deleted:
            query["deleted_at"] = None
        return await self.collection.find_one(query, {"_id": 0})

    async def get_by_reference(self, reference: str) -> dict[str, Any] | None:
        return await self.collection.find_one(
            {"reference": reference, "deleted_at": None},
            {"_id": 0},
        )

    async def list(self, filters: dict[str, Any], limit: int = 50, skip: int = 0) -> tuple[list[dict[str, Any]], int]:
        query: dict[str, Any] = {"deleted_at": None}
        if status := filters.get("status"):
            query["status"] = status
        if department := filters.get("department"):
            query["department"] = department
        if search := filters.get("search"):
            query["$or"] = [
                {"title": {"$regex": search, "$options": "i"}},
                {"reference": {"$regex": search, "$options": "i"}},
                {"department": {"$regex": search, "$options": "i"}},
            ]

        cursor = self.collection.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit)
        items = await cursor.to_list(length=limit)
        total = await self.collection.count_documents(query)
        return items, total

    async def update(self, job_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        await self.collection.update_one({"job_id": job_id, "deleted_at": None}, {"$set": changes})
        return await self.get_by_id(job_id)
