from collections.abc import Callable
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Header, HTTPException, status

from app.core.config import settings

RoleDependency = Callable[..., str]

ROLES = {"admin", "rh", "manager", "candidate"}
WRITE_ROLES = {"admin", "rh"}
ADMIN_ROLES = {"admin"}
READ_ROLES = {"admin", "rh", "manager"}
CANDIDATE_ROLES = {"candidate"}


def hash_password(password: str) -> str:
    # bcrypt utilise directement (sans passlib, dont la derniere version
    # publiee est incompatible avec les versions recentes de la librairie
    # bcrypt et provoque un plantage au demarrage lors de la creation des
    # comptes de demonstration).
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def create_access_token(username: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expires_minutes)
    payload = {"sub": username, "role": role, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expiree, reconnectez-vous.") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Jeton d'authentification invalide.") from exc


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentification requise. Connectez-vous pour continuer.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization.split(" ", 1)[1].strip()


def require_roles(*allowed_roles: str) -> RoleDependency:
    """Verifie un vrai jeton JWT (obtenu via /auth/login) au lieu de faire
    confiance a un en-tete declaratif comme X-User-Role, qui pouvait etre
    falsifie par n'importe quel appelant pour obtenir un role admin."""

    async def dependency(authorization: str | None = Header(default=None)) -> str:
        token = _extract_bearer_token(authorization)
        payload = decode_access_token(token)
        role = payload.get("role")
        if role not in ROLES or role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Action non autorisee pour ce role.",
            )
        return role

    return dependency



def require_user(*allowed_roles: str) -> Callable[..., dict]:
    """Retourne l'utilisateur JWT complet pour les actions auditees."""

    async def dependency(authorization: str | None = Header(default=None)) -> dict:
        token = _extract_bearer_token(authorization)
        payload = decode_access_token(token)
        role = payload.get("role")
        if role not in ROLES or role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Action non autorisee pour ce role.",
            )
        return {"username": payload.get("sub"), "role": role}

    return dependency

require_rh_role = require_roles(*WRITE_ROLES)
require_read_role = require_roles(*READ_ROLES)
require_admin_role = require_roles(*ADMIN_ROLES)
require_candidate_role = require_roles(*CANDIDATE_ROLES)

