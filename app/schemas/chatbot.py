from typing import Any

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    confirm: bool = False
    context: dict[str, Any] | None = None


class ChatResponse(BaseModel):
    answer: str
    requires_confirmation: bool = False
    action_preview: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
