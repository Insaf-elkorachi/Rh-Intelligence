from pydantic import BaseModel, EmailStr, Field


class CandidateCreate(BaseModel):
    nom: str = Field(min_length=1)
    prenom: str = Field(min_length=1)
    email: EmailStr
    telephone: str | None = None
    poste_souhaite: str | None = None


class CandidateResponse(BaseModel):
    candidate_id: str
    status: str
