from pathlib import Path
from typing import Any

import pandas as pd

from app.agents.base import BaseAgent
from app.agents.cleaning_agent import CleaningAgent
from app.db.collections import EMPLOYES
from app.db.mongo import get_database
from app.models.common import now_utc


class ImportExcelAgent(BaseAgent):
    name = "import_excel_agent"

    def __init__(self) -> None:
        self.cleaning_agent = CleaningAgent()

    async def import_file(self, file_path: str, collection_name: str = EMPLOYES) -> dict[str, Any]:
        try:
            suffix = Path(file_path).suffix.lower()
            if suffix not in {".xlsx", ".xls", ".csv"}:
                raise ValueError("Format non supporte. Utilise .xlsx, .xls ou .csv.")

            if suffix == ".csv":
                df = pd.read_csv(file_path)
            else:
                df = pd.read_excel(file_path)

            raw_count = len(df)
            cleaned = self.cleaning_agent.clean_dataframe(df)
            records = cleaned.to_dict(orient="records")

            for record in records:
                record["source_file"] = Path(file_path).name
                record["imported_at"] = now_utc()

            db = get_database()
            if records:
                await db[collection_name].insert_many(records)

            result = {
                "collection": collection_name,
                "raw_rows": raw_count,
                "inserted_rows": len(records),
            }
            await self.save_run("import_excel", "success", result)
            return result
        except Exception as exc:
            await self.save_run("import_excel", "failed", error=str(exc))
            raise
