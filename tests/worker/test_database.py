from pathlib import Path

import pytest

from worker.database import ConflictError, Database
from worker.models import Participant, SegmentCreate, SessionCreate, SessionState


def session(session_id: str = "2026-07-15_11-30-00") -> SessionCreate:
    return SessionCreate(
        session_id=session_id,
        guild_id="guild",
        voice_channel_id="voice",
        voice_channel_name="voice-general",
        text_channel_id="text",
        started_at="2026-07-15T11:30:00Z",
        participants=[Participant(user_id="1", speaker="Simon")],
    )


def segment() -> SegmentCreate:
    return SegmentCreate(
        segment_id="segment-1",
        sequence=0,
        user_id="1",
        speaker="Simon",
        relative_start_ms=124_100,
        relative_end_ms=127_000,
        relative_path="2026-07-15_11-30-00/raw/1/00000000_124100.ogg",
    )


def test_segment_delivery_is_idempotent(tmp_path: Path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    database.create_session(session())
    assert database.add_segment(session().session_id, segment()) is True
    assert database.add_segment(session().session_id, segment()) is False
    status = database.status(session().session_id)
    assert status["segments"]["total"] == 1
    assert status["participants"] == [{"user_id": "1", "speaker": "Simon"}]


def test_only_one_system_wide_session_can_be_active(tmp_path: Path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    database.create_session(session())
    with pytest.raises(ConflictError):
        database.create_session(session("2026-07-15_12-00-00"))


def test_session_identifier_cannot_be_reused(tmp_path: Path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    database.create_session(session())
    with pytest.raises(ConflictError):
        database.create_session(session())


def test_pause_resume_and_finalize_close_segment_ingest(tmp_path: Path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    database.create_session(session())
    database.set_state(session().session_id, SessionState.PAUSED)
    database.set_state(session().session_id, SessionState.RECORDING)
    assert database.begin_finalization(session().session_id) is True
    with pytest.raises(ConflictError):
        database.add_segment(session().session_id, segment())
