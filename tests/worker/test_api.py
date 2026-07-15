import os
from pathlib import Path

from fastapi.testclient import TestClient

os.environ.setdefault("WORKER_API_TOKEN", "test-token")

from worker.main import Settings, create_app  # noqa: E402


def settings(tmp_path: Path) -> Settings:
    return Settings(
        recordings_root=tmp_path,
        api_token="test-token",
        model_cache=tmp_path / "models",
        live_model="unused-live",
        final_model="unused-final",
        final_revision="strict",
        language="sv",
        cuda_device=0,
    )


def test_worker_requires_bearer_token(tmp_path: Path) -> None:
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.get("/health").status_code == 401
        response = client.get("/health", headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 200
        assert response.json()["ok"] is True


def test_segment_path_cannot_escape_recordings_root(tmp_path: Path) -> None:
    with TestClient(create_app(settings(tmp_path))) as client:
        headers = {"Authorization": "Bearer test-token"}
        created = client.post(
            "/sessions",
            headers=headers,
            json={
                "session_id": "2026-07-15_11-30-00",
                "guild_id": "guild",
                "voice_channel_id": "voice",
                "voice_channel_name": "voice-general",
                "text_channel_id": "text",
                "started_at": "2026-07-15T11:30:00Z",
                "participants": [],
            },
        )
        assert created.status_code == 201
        response = client.post(
            "/sessions/2026-07-15_11-30-00/segments",
            headers=headers,
            json={
                "segment_id": "bad",
                "sequence": 0,
                "user_id": "1",
                "speaker": "Simon",
                "relative_start_ms": 0,
                "relative_end_ms": 10,
                "relative_path": "../outside.ogg",
            },
        )
        assert response.status_code == 400
