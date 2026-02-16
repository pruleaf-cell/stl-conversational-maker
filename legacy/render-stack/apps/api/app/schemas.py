from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

SessionStatus = Literal[
    "collecting",
    "questions_ready",
    "ready_to_build",
    "building",
    "completed",
    "failed",
]
InputType = Literal["select", "number", "text"]
ObjectClass = Literal["earring", "pendant", "ring", "fidget_token", "fidget_spinner"]
Shape = Literal["heart", "circle", "star", "rounded_square", "custom_outline"]
PrinterProfile = Literal["A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"]
BuildStatus = Literal["queued", "running", "completed", "failed"]


class CreateSessionRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)


class ClarificationQuestion(BaseModel):
    id: str
    label: str
    inputType: InputType
    required: bool = True
    options: Optional[List[str]] = None
    unit: Optional[Literal["mm"]] = None


class ModelSpec(BaseModel):
    objectClass: ObjectClass
    shape: Shape
    dimensionsMm: Dict[str, float]
    featureFlags: Dict[str, bool]
    printerProfile: PrinterProfile


class AutoAdjustment(BaseModel):
    field: str
    from_value: Union[float, str] = Field(alias="from")
    to: Union[float, str]
    reason: str

    model_config = {
        "populate_by_name": True,
    }


class SessionState(BaseModel):
    sessionId: str
    status: SessionStatus
    summary: str
    questions: List[ClarificationQuestion] = Field(default_factory=list)
    modelSpec: Optional[ModelSpec] = None
    adjustments: List[AutoAdjustment] = Field(default_factory=list)


class AnswersPayload(BaseModel):
    answers: Dict[str, Union[str, float, int]] = Field(default_factory=dict)


class PatchSpecPayload(BaseModel):
    dimensionsMm: Dict[str, float]


class BuildRequest(BaseModel):
    sessionId: str
    printerProfile: PrinterProfile


class BuildResult(BaseModel):
    jobId: str
    status: BuildStatus
    stlUrl: Optional[str] = None
    project3mfUrl: Optional[str] = None
    reportUrl: Optional[str] = None


class SessionRecord(SessionState):
    prompt: str
    answers: Dict[str, Union[str, float, int]] = Field(default_factory=dict)
    createdAt: datetime
    expiresAt: datetime


class JobRecord(BuildResult):
    sessionId: str
    stage: Optional[str] = None
    error: Optional[str] = None
    token: str
    createdAt: datetime
    expiresAt: datetime
    stlPath: Optional[str] = None
    project3mfPath: Optional[str] = None
    reportPath: Optional[str] = None
