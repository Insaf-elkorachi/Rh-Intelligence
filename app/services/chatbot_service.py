"""Chatbot RH outille pour agir sur MongoDB apres confirmation.

Le service expose une couche agentique simple et deterministe: il interprete
la demande en langage naturel, choisit un outil MongoDB interne, prepare une
confirmation pour les operations sensibles, puis execute l'action uniquement
via /chatbot/confirm. Les memes outils pourront etre branches plus tard a un
LLM avec function calling sans changer la couche persistence.
"""
import re
from datetime import datetime
from typing import Any

from app.db.collections import AUDIT_LOGS, EMPLOYES
from app.db.mongo import get_database
from app.models.common import new_id, now_utc
from app.repositories.job_repository import JobRepository
from app.services.vector_store_service import vector_store_service

STATUS_WORDS = {
    "ouverte": "open", "ouvert": "open", "ouvrir": "open",
    "pause": "paused", "suspendre": "paused", "suspendue": "paused",
    "cloturee": "closed", "cloture": "closed", "fermer": "closed", "fermee": "closed",
}

EMPLOYEE_FIELD_ALIASES = {
    "statut": ["statut", "status"],
    "status": ["statut", "status"],
    "departement": ["departement", "department", "direction", "service"],
    "department": ["departement", "department", "direction", "service"],
    "poste": ["poste", "fonction", "job_title"],
    "fonction": ["poste", "fonction", "job_title"],
    "salaire": ["salaire", "salary", "remuneration"],
    "email": ["email", "mail"],
    "telephone": ["telephone", "phone", "tel"],
    "phone": ["telephone", "phone", "tel"],
}

SAFE_EMPLOYEE_FIELDS = {
    "matricule", "nom", "prenom", "nom_complet", "full_name", "name",
    "departement", "department", "direction", "service", "poste", "fonction",
    "job_title", "statut", "status", "email", "mail", "telephone", "phone",
    "tel", "salaire", "salary", "remuneration", "type_contrat", "created_at",
    "updated_at", "deleted_at",
}

CONFIRM_WORDS = {"oui", "ok", "confirme", "confirmer", "valide", "validÃƒÆ’Ã‚Â©", "yes"}
CANCEL_WORDS = {"non", "annule", "annuler", "stop", "cancel"}


class ChatbotService:
    def __init__(self) -> None:
        self.job_repository = JobRepository()
        self.sessions: dict[str, dict[str, Any]] = {}

    async def _load_dataset_summary(self) -> dict[str, Any]:
        from app.services.agent_runtime_service import load_dataset

        return load_dataset().get("summary", {})

    def _actor_key(self, actor: dict[str, Any] | str | None) -> str | None:
        if isinstance(actor, dict):
            return actor.get("username") or actor.get("role")
        return actor

    def _clean_context(self, context: dict[str, Any] | None, actor: dict[str, Any] | str | None = None) -> dict[str, Any]:
        key = self._actor_key(actor)
        stored = dict(self.sessions.get(key, {})) if key else {}
        stored.update(context or {})
        return stored

    def remember(self, actor: dict[str, Any] | str | None, context: dict[str, Any] | None) -> None:
        key = self._actor_key(actor)
        if key:
            self.sessions[key] = dict(context or {})

    def _serialize(self, value: Any) -> Any:
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, list):
            return [self._serialize(item) for item in value]
        if isinstance(value, dict):
            return {str(key): self._serialize(item) for key, item in value.items() if key != "_id"}
        return value

    def _employee_projection(self) -> dict[str, int]:
        return {"_id": 0}

    def _display_name(self, employee: dict[str, Any]) -> str:
        full = employee.get("nom_complet") or employee.get("full_name") or employee.get("name")
        if full:
            return str(full)
        return " ".join(str(employee.get(key, "")).strip() for key in ("prenom", "nom") if employee.get(key)) or "Employe"

    def _employee_key(self, employee: dict[str, Any]) -> dict[str, Any]:
        if employee.get("matricule"):
            return {"matricule": employee["matricule"]}
        for key in ("email", "mail"):
            if employee.get(key):
                return {key: employee[key]}
        return {"nom_complet": self._display_name(employee)}

    def _brief_employee(self, employee: dict[str, Any]) -> dict[str, Any]:
        return {
            "nom_complet": self._display_name(employee),
            "matricule": employee.get("matricule", "N/A"),
            "departement": employee.get("departement") or employee.get("department") or employee.get("direction") or employee.get("service") or "N/A",
            "poste": employee.get("poste") or employee.get("fonction") or employee.get("job_title") or "N/A",
            "statut": employee.get("statut") or employee.get("status") or "N/A",
            "email": employee.get("email") or employee.get("mail") or "N/A",
        }

    def _format_employee(self, employee: dict[str, Any]) -> str:
        brief = self._brief_employee(employee)
        return (
            f"{brief['nom_complet']}\n"
            f"Matricule: {brief['matricule']}\n"
            f"Departement: {brief['departement']}\n"
            f"Poste: {brief['poste']}\n"
            f"Statut: {brief['statut']}\n"
            f"Email: {brief['email']}"
        )

    def _format_employee_list(self, employees: list[dict[str, Any]]) -> str:
        lines = []
        for index, employee in enumerate(employees, start=1):
            brief = self._brief_employee(employee)
            lines.append(
                f"{index}. {brief['nom_complet']} | Matricule: {brief['matricule']} | "
                f"Departement: {brief['departement']} | Poste: {brief['poste']}"
            )
        return "\n".join(lines)

    def _extract_employee_search_term(self, message: str) -> str | None:
        clean = message.strip()
        matricule = re.search(r"\b[A-Z]{1,5}-?\d{2,8}\b", clean, flags=re.I)
        if matricule:
            return matricule.group(0)
        patterns = [
            r"(?:employe|employÃƒÆ’Ã‚Â©|salarie|salariÃƒÆ’Ã‚Â©|profil de|fiche de)\s+([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ '-]{2,80})",
            r"(?:cherche|recherche|trouve|affiche|modifie|modifier|supprime|supprimer)\s+(?:le profil de |l'employe |l'employÃƒÆ’Ã‚Â© |)?([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ '-]{2,80})",
        ]
        for pattern in patterns:
            match = re.search(pattern, clean, flags=re.I)
            if match:
                term = re.split(r"\b(?:et|puis|pour|statut|poste|departement|dÃƒÆ’Ã‚Â©partement|email|telephone|tÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©phone)\b", match.group(1), flags=re.I)[0]
                return term.strip(" .,'\"") or None
        words = [w for w in re.findall(r"[\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿'-]+", clean) if len(w) > 2]
        stop = {"modifie", "modifier", "profil", "employe", "employÃƒÆ’Ã‚Â©", "salarie", "salariÃƒÆ’Ã‚Â©", "statut", "poste", "departement", "dÃƒÆ’Ã‚Â©partement", "email", "telephone"}
        names = [w for w in words if w.lower() not in stop]
        return names[-1] if names else None

    async def _search_employees(self, term: str, limit: int = 8) -> list[dict[str, Any]]:
        db = get_database()
        escaped = re.escape(term.strip())
        query = {
            "deleted_at": {"$exists": False},
            "$or": [
                {"matricule": {"$regex": escaped, "$options": "i"}},
                {"nom": {"$regex": escaped, "$options": "i"}},
                {"prenom": {"$regex": escaped, "$options": "i"}},
                {"nom_complet": {"$regex": escaped, "$options": "i"}},
                {"full_name": {"$regex": escaped, "$options": "i"}},
                {"name": {"$regex": escaped, "$options": "i"}},
                {"email": {"$regex": escaped, "$options": "i"}},
                {"mail": {"$regex": escaped, "$options": "i"}},
            ],
        }
        return await db[EMPLOYES].find(query, self._employee_projection()).limit(limit).to_list(length=limit)

    async def _get_employee(self, key: dict[str, Any]) -> dict[str, Any] | None:
        db = get_database()
        query = {**key, "deleted_at": {"$exists": False}}
        return await db[EMPLOYES].find_one(query, self._employee_projection())

    def _resolve_field_name(self, employee: dict[str, Any], requested: str) -> str:
        aliases = EMPLOYEE_FIELD_ALIASES.get(requested, [requested])
        for field in aliases:
            if field in employee:
                return field
        return aliases[0]

    def _detect_status_change(self, message: str) -> dict[str, str] | None:
        lowered = message.lower()
        job_match = re.search(r"job-\d+", lowered)
        if not job_match:
            return None
        for word, status_value in STATUS_WORDS.items():
            if word in lowered:
                return {"job_id": job_match.group(0).upper(), "status": status_value}
        return None

    def _detect_employee_update(self, message: str, employee: dict[str, Any] | None) -> dict[str, Any] | None:
        lowered = message.lower()
        patterns = [
            ("statut", r"(?:statut|status).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ .'-]+)"),
            ("statut", r"passe\s+(?:son\s+)?statut\s+(?:a|ÃƒÆ’Ã‚Â |en|vers)\s+([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ .'-]+)"),
            ("departement", r"(?:departement|dÃƒÆ’Ã‚Â©partement|service|direction).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ .'-]+)"),
            ("poste", r"(?:poste|fonction).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([\wÃƒÆ’Ã¢â€šÂ¬-ÃƒÆ’Ã‚Â¿ .'-]+)"),
            ("email", r"(?:email|mail).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([\w.%-]+@[\w.-]+\.[A-Za-z]{2,})"),
            ("telephone", r"(?:telephone|tÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©phone|tel).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([+\d][\d .-]{5,})"),
            ("salaire", r"(?:salaire|salary|remuneration|rÃƒÆ’Ã‚Â©munÃƒÆ’Ã‚Â©ration).{0,20}(?:a|ÃƒÆ’Ã‚Â |=|en|vers)\s+([\d .,.]+)"),
        ]
        for requested_field, pattern in patterns:
            match = re.search(pattern, lowered, flags=re.I)
            if not match:
                continue
            value: Any = match.group(1).strip(" .,'\"")
            if requested_field == "salaire":
                numeric = re.sub(r"[^\d.,]", "", value).replace(",", ".")
                try:
                    value = float(numeric)
                except ValueError:
                    pass
            field = self._resolve_field_name(employee or {}, requested_field)
            return {"field": field, "value": value}
        return None

    def _detect_employee_delete(self, message: str) -> bool:
        lowered = message.lower()
        return any(word in lowered for word in ("supprime", "supprimer", "delete", "efface")) and any(word in lowered for word in ("employe", "employÃƒÆ’Ã‚Â©", "salarie", "salariÃƒÆ’Ã‚Â©", "profil"))

    def _detect_employee_create(self, message: str) -> dict[str, Any] | None:
        lowered = message.lower()
        if not any(word in lowered for word in ("cree", "crÃƒÆ’Ã‚Â©e", "creer", "crÃƒÆ’Ã‚Â©er", "ajoute", "ajouter")):
            return None
        if not any(word in lowered for word in ("employe", "employÃƒÆ’Ã‚Â©", "salarie", "salariÃƒÆ’Ã‚Â©")):
            return None
        data: dict[str, Any] = {}
        stop = r"(?=\s+(?:matricule|departement|dÃƒÂ©partement|service|poste|fonction|email|mail|telephone|tÃƒÂ©lÃƒÂ©phone|tel)\b|$)"
        name_match = re.search(rf"(?:employe|employÃƒÂ©|salarie|salariÃƒÂ©)\s+([\wÃƒâ‚¬-ÃƒÂ¿ '-]{{2,80}}?){stop}", message, flags=re.I)
        if name_match:
            data["nom_complet"] = name_match.group(1).strip(" .,'\"")
        for field, field_pattern in {
            "matricule": rf"matricule\s*(?:=|:|est)?\s*([\w-]+){stop}",
            "departement": rf"(?:departement|dÃƒÂ©partement|service)\s*(?:=|:|est)?\s*([\wÃƒâ‚¬-ÃƒÂ¿ '-]+?){stop}",
            "poste": rf"(?:poste|fonction)\s*(?:=|:|est)?\s*([\wÃƒâ‚¬-ÃƒÂ¿ '-]+?){stop}",
            "email": r"([\w.%-]+@[\w.-]+\.[A-Za-z]{2,})",
            "telephone": rf"(?:telephone|tÃƒÂ©lÃƒÂ©phone|tel)\s*(?:=|:|est)?\s*([+\d][\d .-]{{5,}}){stop}",
        }.items():
            match = re.search(field_pattern, message, flags=re.I)
            if match:
                data[field] = match.group(1).strip(" .,'\"")
        return data or None

    async def _prepare_employee_target(self, message: str, context: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any], str | None]:
        selected_key = context.get("selected_employee_key")
        if selected_key:
            employee = await self._get_employee(selected_key)
            if employee:
                return employee, context, None

        if context.get("selected_employee_key") is None and re.search(r"\b(?:son|sa|ses)\b", message, flags=re.I):
            return None, context, "Je dois d'abord identifier l'employe a modifier. Exemple: 'Modifie le profil de Mohamed'."

        term = self._extract_employee_search_term(message)
        if not term:
            return None, context, "Je dois d'abord identifier l'employe. Exemple: 'Modifie le profil de Mohamed' ou 'Matricule RH-0158'."

        matches = await self._search_employees(term)
        if not matches:
            return None, context, f"Je n'ai trouve aucun employe correspondant a '{term}' dans MongoDB."
        if len(matches) > 1:
            context["pending_employee_choices"] = [self._employee_key(item) for item in matches]
            return None, context, "J'ai trouve plusieurs employes. Choisissez le bon par numero ou matricule:\n" + self._format_employee_list(matches)

        context["selected_employee_key"] = self._employee_key(matches[0])
        context.pop("pending_employee_choices", None)
        return matches[0], context, None

    async def answer(self, message: str, actor: dict[str, Any] | str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        clean = (message or "").strip()
        lowered = clean.lower()
        ctx = self._clean_context(context, actor)
        if not clean:
            return {"reply": "Posez une question ou demandez une action RH.", "pending_action": None, "context": ctx}

        if lowered in CANCEL_WORDS:
            ctx.pop("pending_action", None)
            ctx.pop("pending_employee_choices", None)
            return {"reply": "Action annulee, aucune modification effectuee.", "pending_action": None, "context": ctx}

        choices = ctx.get("pending_employee_choices") or []
        if choices:
            selected_key = None
            number_match = re.search(r"\b(\d{1,2})\b", lowered)
            if number_match and 1 <= int(number_match.group(1)) <= len(choices):
                selected_key = choices[int(number_match.group(1)) - 1]
            else:
                for choice in choices:
                    matricule = str(choice.get("matricule", "")).lower()
                    if matricule and matricule in lowered:
                        selected_key = choice
                        break
            if selected_key:
                employee = await self._get_employee(selected_key)
                if employee:
                    ctx["selected_employee_key"] = selected_key
                    ctx.pop("pending_employee_choices", None)
                    return {"reply": "Employe selectionne:\n" + self._format_employee(employee), "pending_action": None, "context": ctx}
            return {"reply": "Je n'arrive pas a reconnaitre ce choix. Repondez avec le numero de la ligne ou le matricule.", "pending_action": None, "context": ctx}

        change = self._detect_status_change(clean)
        if change:
            job = await self.job_repository.get_by_id(change["job_id"])
            if not job:
                return {"reply": f"Je ne trouve pas l'offre {change['job_id']} en base.", "pending_action": None, "context": ctx}
            old_status = job.get("status")
            pending = {"type": "update_job_status", "job_id": change["job_id"], "field": "status", "old_value": old_status, "new_value": change["status"]}
            ctx["pending_action"] = pending
            return {
                "reply": f"Vous etes sur le point de modifier le statut de l'offre {change['job_id']} de '{old_status}' vers '{change['status']}'. Confirmez-vous cette modification ?",
                "pending_action": pending,
                "context": ctx,
            }

        create_data = self._detect_employee_create(clean)
        if create_data:
            pending = {"type": "create_employee", "data": create_data}
            ctx["pending_action"] = pending
            return {"reply": f"Vous etes sur le point de creer un employe avec ces informations: {create_data}. Confirmez-vous cette creation ?", "pending_action": pending, "context": ctx}

        wants_employee = any(word in lowered for word in ("employe", "employÃƒÆ’Ã‚Â©", "salarie", "salariÃƒÆ’Ã‚Â©", "profil", "fiche", "matricule", "statut", "poste", "departement", "dÃƒÆ’Ã‚Â©partement", "salaire", "email", "telephone", "tÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©phone"))
        update = self._detect_employee_update(clean, None)
        delete = self._detect_employee_delete(clean)
        if wants_employee or update or delete:
            employee, ctx, issue = await self._prepare_employee_target(clean, ctx)
            if issue:
                return {"reply": issue, "pending_action": None, "context": ctx}
            if not employee:
                return {"reply": "Employe introuvable.", "pending_action": None, "context": ctx}
            if delete:
                pending = {"type": "delete_employee", "employee_key": self._employee_key(employee), "employee_name": self._display_name(employee), "old_value": self._brief_employee(employee)}
                ctx["pending_action"] = pending
                return {"reply": f"Vous etes sur le point de supprimer le profil de {self._display_name(employee)} (Matricule {employee.get('matricule', 'N/A')}). Confirmez-vous cette suppression ?", "pending_action": pending, "context": ctx}
            update = self._detect_employee_update(clean, employee)
            if update:
                old_value = employee.get(update["field"])
                pending = {
                    "type": "update_employee",
                    "employee_key": self._employee_key(employee),
                    "employee_name": self._display_name(employee),
                    "field": update["field"],
                    "old_value": old_value,
                    "new_value": update["value"],
                }
                ctx["pending_action"] = pending
                return {
                    "reply": f"Vous etes sur le point de modifier {update['field']} de {self._display_name(employee)} (Matricule {employee.get('matricule', 'N/A')}) de '{old_value}' vers '{update['value']}'. Confirmez-vous cette modification ?",
                    "pending_action": pending,
                    "context": ctx,
                }
            return {"reply": "Voici la fiche trouvee dans MongoDB:\n" + self._format_employee(employee), "pending_action": None, "context": ctx}

        summary = await self._load_dataset_summary()
        if "turnover" in lowered:
            return {"reply": f"Le turnover du dataset TDB est {summary.get('turnover', 'non disponible')}.", "pending_action": None, "context": ctx}
        if "effectif" in lowered:
            return {"reply": f"L'effectif actif est {summary.get('effectifActif', 'N/A')} sur {summary.get('effectifTotal', 'N/A')} lignes.", "pending_action": None, "context": ctx}
        if "depart" in lowered:
            return {"reply": f"Le dataset indique {summary.get('departures', 'N/A')} departs.", "pending_action": None, "context": ctx}
        if "recrut" in lowered:
            return {"reply": f"Le dataset indique {summary.get('recruitments', 'N/A')} recrutements sur la periode.", "pending_action": None, "context": ctx}

        job_match = re.search(r"job-\d+", lowered)
        if job_match:
            job = await self.job_repository.get_by_id(job_match.group(0).upper())
            if job:
                return {"reply": f"L'offre {job['job_id']} ({job.get('title','')}) est actuellement au statut '{job.get('status')}'.", "pending_action": None, "context": ctx}
            return {"reply": f"Je ne trouve pas l'offre {job_match.group(0).upper()} en base.", "pending_action": None, "context": ctx}

        if vector_store_service.is_available():
            matches = vector_store_service.search_jobs_for_candidate(clean, top_k=3)
            if matches:
                lines = "; ".join(f"{m['metadata'].get('title', m['id'])} (pertinence {m['score']})" for m in matches if m.get("metadata"))
                if lines:
                    return {"reply": f"Voici les offres les plus proches de votre question : {lines}.", "pending_action": None, "context": ctx}

        return {
            "reply": "Je peux rechercher un employe, afficher sa fiche, creer/modifier/supprimer un profil apres confirmation, ou repondre sur les indicateurs RH et les offres.",
            "pending_action": None,
            "context": ctx,
        }

    async def confirm(self, pending_action: dict[str, Any], actor: dict[str, Any] | str) -> dict[str, Any]:
        if not pending_action:
            raise ValueError("Action de confirmation inconnue ou expiree.")

        actor_username = actor.get("username") if isinstance(actor, dict) else None
        actor_role = actor.get("role") if isinstance(actor, dict) else actor
        db = get_database()
        action_type = pending_action.get("type")

        if action_type == "update_job_status":
            job_id = pending_action["job_id"]
            job = await self.job_repository.get_by_id(job_id)
            if not job:
                raise ValueError(f"Offre {job_id} introuvable.")
            old_value = job.get("status")
            new_value = pending_action["new_value"]
            updated = await self.job_repository.update(job_id, {"status": new_value, "updated_at": now_utc()})
            await self._audit(actor_username, actor_role, "update", "job", job_id, "status", old_value, new_value)
            return {"reply": f"Modification effectuee avec succes. Nouveau statut de {job_id}: '{new_value}'.", "job": updated}

        if action_type == "update_employee":
            employee = await self._get_employee(pending_action["employee_key"])
            if not employee:
                raise ValueError("Employe introuvable.")
            field = pending_action["field"]
            if field not in SAFE_EMPLOYEE_FIELDS:
                raise ValueError(f"Champ non autorise: {field}")
            old_value = employee.get(field)
            new_value = pending_action["new_value"]
            await db[EMPLOYES].update_one({**pending_action["employee_key"], "deleted_at": {"$exists": False}}, {"$set": {field: new_value, "updated_at": now_utc()}})
            updated = await self._get_employee(pending_action["employee_key"])
            await self._audit(actor_username, actor_role, "update", "employee", self._display_name(employee), field, old_value, new_value)
            return {"reply": "Modification effectuee avec succes.\n" + self._format_employee(updated or employee), "employee": self._serialize(updated)}

        if action_type == "create_employee":
            document = {**pending_action.get("data", {}), "created_at": now_utc(), "updated_at": now_utc()}
            if "matricule" not in document:
                document["matricule"] = new_id("RH")
            await db[EMPLOYES].insert_one(document)
            created = await self._get_employee({"matricule": document["matricule"]})
            await self._audit(actor_username, actor_role, "create", "employee", document["matricule"], None, None, self._brief_employee(created or document))
            return {"reply": "Employe cree avec succes.\n" + self._format_employee(created or document), "employee": self._serialize(created)}

        if action_type == "delete_employee":
            employee = await self._get_employee(pending_action["employee_key"])
            if not employee:
                raise ValueError("Employe introuvable.")
            await db[EMPLOYES].update_one({**pending_action["employee_key"], "deleted_at": {"$exists": False}}, {"$set": {"deleted_at": now_utc(), "updated_at": now_utc()}})
            await self._audit(actor_username, actor_role, "delete", "employee", self._display_name(employee), "deleted_at", None, "soft_deleted")
            return {"reply": f"Suppression effectuee avec succes pour {self._display_name(employee)}."}

        raise ValueError("Action de confirmation inconnue ou expiree.")

    async def _audit(self, actor_username: str | None, actor_role: str | None, action: str, target_type: str, target_id: str, field: str | None, old_value: Any, new_value: Any) -> None:
        db = get_database()
        await db[AUDIT_LOGS].insert_one({
            "audit_id": new_id("AUDIT"),
            "source": "chatbot_agent",
            "action": action,
            "type_modification": f"{target_type}.{field}" if field else target_type,
            "actor_username": actor_username,
            "actor_role": actor_role,
            "target_type": target_type,
            "target_id": target_id,
            "field": field,
            "old_value": self._serialize(old_value),
            "new_value": self._serialize(new_value),
            "created_at": now_utc(),
        })


chatbot_service = ChatbotService()
