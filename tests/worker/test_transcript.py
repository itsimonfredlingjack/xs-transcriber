from worker.transcription import format_relative_timestamp, render_transcript


def test_exact_transcript_format_and_overlap_order() -> None:
    content = render_transcript(
        session_id="2026-07-15_11-30-00",
        channel="voice-general",
        participants=["Simon", "Anna"],
        lines=[
            {"start_ms": 124_999, "speaker": "Simon", "text": "Det här är det vi behöver lösa först."},
            {"start_ms": 128_000, "speaker": "Anna", "text": "Ja, jag håller med."},
        ],
    )
    assert content == (
        "Discord Call Transcription\n"
        "Session: 2026-07-15_11-30-00\n"
        "Channel: voice-general\n"
        "Participants: Simon, Anna\n"
        "[00:02:04] Simon: Det här är det vi behöver lösa först.\n"
        "[00:02:08] Anna: Ja, jag håller med.\n"
    )


def test_timestamp_does_not_round_forward() -> None:
    assert format_relative_timestamp(3_599_999) == "00:59:59"
    assert format_relative_timestamp(3_600_000) == "01:00:00"
