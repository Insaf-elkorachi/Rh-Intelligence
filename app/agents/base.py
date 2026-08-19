from typing import Any

from app.db.collections import AGENT_RUNS, LOGS
from app.db.mongo import get_database
from app.models.common import new_id, now_utc


class BaseAgent:
    name = "base_agent"

    async def log(self, action: str, status: str, payload: dict[str, Any] | None = None, error: str | None = None) -> None:
        db = get_database()
        document = {
            "log_id": new_id("LOG"),
            "agent": self.name,
            "action": action,
            "status": status,
            "payload": payload or {},
            "error": error,
            "created_at": now_utc(),
        }
        await db[LOGS].insert_one(document)

    async def save_run(self, action: str, status: str, result: dict[str, Any] | None = None, error: str | None = None) -> str:
        db = get_database()
        run_id = new_id("RUN")
        await db[AGENT_RUNS].insert_one(
            {
                "run_id": run_id,
                "agent": self.name,
                "action": action,
                "status": status,
                "result": result or {},
                "error": error,
                "created_at": now_utc(),
            }
        )
        return run_id
