from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class AgentMessage(BaseModel):
    message_id: str
    source_agent: str
    target_agent: str
    action: str
    payload: dict[str, Any] = Field(default_factory=dict)
    status: Literal["pending", "running", "success", "failed"] = "pending"
    timestamp: datetime
    error: str | None = None
