from typing import Any

from fastapi import HTTPException, status

from app.core.security import create_access_token, hash_password, verify_password
from app.db.collections import USERS
from app.db.mongo import get_database

# Comptes de demonstration crees automatiquement au premier demarrage si la
# collection "users" est vide. A changer/retirer en production reelle.
DEFAULT_USERS = [
    {"username": "rh.nador", "password": "sonasid2026", "role": "rh", "display_name": "Responsable RH"},
    {"username": "admin.nador", "password": "sonasid2026", "role": "admin", "display_name": "Administrateur"},
    {"username": "manager.nador", "password": "sonasid2026", "role": "manager", "display_name": "Manager"},
]


async def seed_default_users() -> None:
    db = get_database()
    existing = await db[USERS].count_documents({})
    if existing > 0:
        return
    documents = [
        {
            "username": user["username"],
            "password_hash": hash_password(user["password"]),
            "role": user["role"],
            "display_name": user["display_name"],
        }
        for user in DEFAULT_USERS
    ]
    await db[USERS].insert_many(documents)


async def authenticate_user(username: str, password: str) -> dict[str, Any]:
    db = get_database()
    user = await db[USERS].find_one({"username": username})
    if not user or not verify_password(password, user.get("password_hash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Identifiant ou mot de passe incorrect.",
        )
    token = create_access_token(username=user["username"], role=user["role"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user["role"],
        "display_name": user.get("display_name", user["username"]),
    }
