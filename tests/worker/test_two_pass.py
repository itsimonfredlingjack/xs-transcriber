from pathlib import Path
from types import SimpleNamespace

from worker.database import Database
from worker.models import Participant, SegmentCreate, SessionCreate
from worker.transcription import TranscriptionService, TranscriptionSettings


class FakeWhisper:
    def transcribe(self, _path: str, **options):
        assert options["language"] == "sv"
        assert options["condition_on_previous_text"] is False
        text = "Slutlig text." if options["beam_size"] == 5 else "Preliminär text."
        return iter([SimpleNamespace(start=0.25, end=1.5, text=text)]), SimpleNamespace()


def test_preliminary_then_final_replaces_text_and_writes_export(tmp_path: Path) -> None:
    session_id = "2026-07-15_11-30-00"
    relative_path = f"{session_id}/raw/1/00000000_2000.ogg"
    audio = tmp_path / relative_path
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"fake-ogg-for-mocked-model")

    database = Database(tmp_path / "db.sqlite3")
    database.create_session(
        SessionCreate(
            session_id=session_id,
            guild_id="guild",
            voice_channel_id="voice",
            voice_channel_name="voice-general",
            text_channel_id="text",
            started_at="2026-07-15T11:30:00Z",
            participants=[Participant(user_id="1", speaker="Simon")],
        )
    )
    database.add_segment(
        session_id,
        SegmentCreate(
            segment_id="segment-1",
            sequence=0,
            user_id="1",
            speaker="Simon",
            relative_start_ms=2_000,
            relative_end_ms=4_000,
            relative_path=relative_path,
        ),
    )
    service = TranscriptionService(
        database,
        TranscriptionSettings(
            recordings_root=tmp_path,
            model_cache=tmp_path / "models",
            live_model="live",
            final_model="final",
            final_revision="strict",
            language="sv",
            cuda_device=0,
        ),
    )
    service._ensure_model = lambda _kind: FakeWhisper()  # type: ignore[method-assign]

    service._run_live(session_id, "segment-1")
    page = database.result_page(session_id, 0)
    assert page["lines"][0]["text"] == "Preliminär text."

    database.begin_finalization(session_id)
    service._run_final(session_id)
    status = database.status(session_id)
    assert status["state"] == "completed"
    assert (tmp_path / session_id / "transcript.txt").read_text() == (
        "Discord Call Transcription\n"
        f"Session: {session_id}\n"
        "Channel: voice-general\n"
        "Participants: Simon\n"
        "[00:00:02] Simon: Slutlig text.\n"
    )
