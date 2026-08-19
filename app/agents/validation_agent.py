from app.agents.base import BaseAgent


class ValidationAgent(BaseAgent):
    name = "validation_agent"

    def require_confirmation(self, action: str, payload: dict) -> dict:
        return {
            "requires_confirmation": True,
            "action": action,
            "payload": payload,
            "message": "Confirmation RH requise avant modification.",
        }
