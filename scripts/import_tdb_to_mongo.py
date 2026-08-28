from __future__ import annotations

import math
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from pymongo import MongoClient


MONGO_URI = "mongodb://localhost:27017"
DB_NAME = "sonasid_rh"
SOURCE_PATH = Path(r"C:\Users\LENOVO\Downloads\TDB_NADOR 09-2025.xlsx")


def clean_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None
    if hasattr(value, "to_pydatetime"):
        return value.to_pydatetime()
    return value


def clean_key(value: Any, index: int) -> str:
    key = str(value).strip()
    if not key or key.lower().startswith("unnamed:"):
        return f"col_{index + 1}"
    key = key.replace("\n", " ").replace("\r", " ")
    key = re.sub(r"\s+", " ", key)
    return key


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = value.replace("�", "e")
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return value.strip("_") or "sheet"


def as_date(value: Any) -> date | None:
    value = clean_value(value)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed.date()


def calculate_age(birth_value: Any, reference_value: Any = None) -> tuple[int | None, float | None]:
    birth = as_date(birth_value)
    if birth is None:
        return None, None
    reference = as_date(reference_value) or date.today()
    years = reference.year - birth.year - ((reference.month, reference.day) < (birth.month, birth.day))
    decimal_years = round((reference - birth).days / 365.25, 2)
    return max(years, 0), max(decimal_years, 0)


def frame_to_records(df: pd.DataFrame, source_file: str, sheet_name: str) -> list[dict[str, Any]]:
    columns = [clean_key(column, index) for index, column in enumerate(df.columns)]
    records: list[dict[str, Any]] = []
    imported_at = datetime.utcnow()
    for row_index, row in df.iterrows():
        document = {
            columns[column_index]: clean_value(value)
            for column_index, value in enumerate(row.tolist())
        }
        document["source_file"] = source_file
        document["source_sheet"] = sheet_name
        document["source_row"] = int(row_index) + 2
        document["imported_at"] = imported_at
        if sheet_name.strip().upper() == "EFFECTIF":
            matricule = clean_value(document.get("MATRICULE") or document.get("Matricule"))
            nom = clean_value(document.get("NOM") or document.get("Nom"))
            prenom = clean_value(document.get("PRENOM") or document.get("Prenom"))
            departement = clean_value(document.get("Lieu de travail") or document.get("affectation"))
            college = clean_value(document.get("Coll�ge") or document.get("College"))
            actif = clean_value(document.get("Toujours � la sonasid la sonasid"))
            document["matricule"] = str(matricule).strip() if matricule is not None else f"ROW-{int(row_index) + 2}"
            document["nom"] = str(nom).strip() if nom is not None else ""
            document["prenom"] = str(prenom).strip() if prenom is not None else ""
            document["nom_complet"] = " ".join(part for part in (document["prenom"], document["nom"]) if part).strip()
            document["departement"] = str(departement).strip() if departement is not None else ""
            document["college"] = str(college).strip() if college is not None else ""
            document["statut"] = "actif" if actif == 1 else "inactif"
            age_years, age_decimal = calculate_age(
                document.get("Date de naissance"),
                document.get("Date de d�part") or document.get("Date de départ"),
            )
            if age_years is not None:
                document["Âge"] = age_years
                document["age"] = age_years
                document["age_decimal"] = age_decimal
        records.append(document)
    return records


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE_PATH
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        return 1

    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[DB_NAME]

    excel = pd.ExcelFile(path)
    imported: list[tuple[str, str, int]] = []

    for sheet_name in excel.sheet_names:
        df = pd.read_excel(path, sheet_name=sheet_name)
        records = frame_to_records(df, path.name, sheet_name)
        collection_name = "employees" if sheet_name.strip().upper() == "EFFECTIF" else f"tdb_{slugify(sheet_name)}"
        db[collection_name].delete_many({"source_file": path.name})
        if records:
            db[collection_name].insert_many(records)
        imported.append((sheet_name, collection_name, len(records)))

    db["imports"].insert_one({
        "source_file": path.name,
        "source_path": str(path),
        "sheets": [{"sheet": sheet, "collection": collection, "rows": rows} for sheet, collection, rows in imported],
        "imported_at": datetime.utcnow(),
    })

    for sheet, collection, rows in imported:
        print(f"{sheet} -> {collection}: {rows} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
