from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class SessionState(StrEnum):
    RECORDING = "recording"
    PAUSED = "paused"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"


class Participant(BaseModel):
    user_id: str
    speaker: str = Field(min_length=1, max_length=128)


class SessionCreate(BaseModel):
    session_id: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")
    guild_id: str
    voice_channel_id: str
    voice_channel_name: str = Field(min_length=1, max_length=128)
    text_channel_id: str
    started_at: str
    participants: list[Participant] = Field(default_factory=list)


class SegmentCreate(BaseModel):
    segment_id: str = Field(min_length=1, max_length=128)
    sequence: int = Field(ge=0)
    user_id: str
    speaker: str = Field(min_length=1, max_length=128)
    relative_start_ms: int = Field(ge=0)
    relative_end_ms: int = Field(ge=0)
    relative_path: str = Field(min_length=1, max_length=1024)


class StateUpdate(BaseModel):
    state: SessionState


class AbortRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class TranscriptLine(BaseModel):
    id: int
    start: int
    end: int
    user_id: str
    speaker: str
    text: str


class ResultPage(BaseModel):
    cursor: int
    lines: list[TranscriptLine]
