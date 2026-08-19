from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

JobStatus = Literal["draft", "open", "paused", "closed", "archived"]


class JobBase(BaseModel):
    reference: str = Field(min_length=2, max_length=80)
    title: str = Field(min_length=2, max_length=160)
    department: str = Field(min_length=2, max_length=120)
    description: str = Field(min_length=10)
    responsibilities: list[str] = Field(default_factory=list)
    required_skills: list[str] = Field(default_factory=list)
    preferred_skills: list[str] = Field(default_factory=list)
    minimum_experience_years: float = Field(default=0, ge=0)
    education_level: str | None = None
    languages: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    contract_type: str | None = None
    location: str | None = None
    number_of_positions: int = Field(default=1, ge=1)
    opening_date: date | None = None
    closing_date: date | None = None
    status: JobStatus = "draft"


class JobCreate(JobBase):
    pass


class JobUpdate(BaseModel):
    reference: str | None = Field(default=None, min_length=2, max_length=80)
    title: str | None = Field(default=None, min_length=2, max_length=160)
    department: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, min_length=10)
    responsibilities: list[str] | None = None
    required_skills: list[str] | None = None
    preferred_skills: list[str] | None = None
    minimum_experience_years: float | None = Field(default=None, ge=0)
    education_level: str | None = None
    languages: list[str] | None = None
    certifications: list[str] | None = None
    contract_type: str | None = None
    location: str | None = None
    number_of_positions: int | None = Field(default=None, ge=1)
    opening_date: date | None = None
    closing_date: date | None = None
    status: JobStatus | None = None


class JobResponse(JobBase):
    job_id: str
    normalized_text: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class JobListResponse(BaseModel):
    items: list[JobResponse]
    total: int
