from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

import ctranslate2
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.responses import FileResponse

from .database import ConflictError, Database, NotFoundError
from .models import AbortRequest, SegmentCreate, SessionCreate, StateUpdate
from .transcription import TranscriptionService, TranscriptionSettings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@dataclass(frozen=True)
class Settings:
    recordings_root: Path
    api_token: str
    model_cache: Path
    live_model: str
    final_model: str
    final_revision: str
    language: str
    cuda_device: int
    compute_type: str

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            recordings_root=Path(
                os.getenv(
                    "RECORDINGS_ROOT", "/home/simon/discord-transcriber/recordings"
                )
            ).resolve(),
            api_token=os.getenv("WORKER_API_TOKEN", ""),
            model_cache=Path(
                os.getenv("WHISPER_CACHE_DIR", "/home/simon/whisper/models")
            ).resolve(),
            live_model=os.getenv("WHISPER_LIVE_MODEL", "KBLab/kb-whisper-small"),
            final_model=os.getenv("WHISPER_FINAL_MODEL", "KBLab/kb-whisper-large"),
            # "strict" is currently broken with CTranslate2 4.8.x (json type_error).
            final_revision=os.getenv("WHISPER_FINAL_REVISION", "main"),
            language=os.getenv("WHISPER_LANGUAGE", "sv"),
            cuda_device=int(os.getenv("CUDA_DEVICE", "0")),
            # Default int8_float16 so Large Strict fits next to llama-server on 12 GB.
            compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8_float16"),
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_environment()
    if not settings.api_token:
        raise RuntimeError("WORKER_API_TOKEN must be set")
    settings.recordings_root.mkdir(parents=True, exist_ok=True)
    database = Database(settings.recordings_root / "transcriptions.sqlite3")
    service = TranscriptionService(
        database,
        TranscriptionSettings(
            recordings_root=settings.recordings_root,
            model_cache=settings.model_cache,
            live_model=settings.live_model,
            final_model=settings.final_model,
            final_revision=settings.final_revision,
            language=settings.language,
            cuda_device=settings.cuda_device,
            compute_type=settings.compute_type,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        service.start()
        yield
        service.stop()

    application = FastAPI(
        title="Local Discord Transcription Worker",
        version="1.0.0",
        lifespan=lifespan,
    )
    application.state.database = database
    application.state.service = service
    application.state.settings = settings

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        scheme, _, supplied = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            supplied, settings.api_token
        ):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    protected = Depends(authorize)

    @application.get("/health")
    def health(_authorized: None = protected) -> dict[str, Any]:
        return {
            "ok": True,
            "cuda_devices": ctranslate2.get_cuda_device_count(),
            "cuda_compute_types": sorted(ctranslate2.get_supported_compute_types("cuda")),
            **service.health(),
        }

    @application.post("/sessions", status_code=status.HTTP_201_CREATED)
    def create_session(data: SessionCreate, _authorized: None = protected) -> dict[str, Any]:
        try:
            return database.create_session(data)
        except ConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.post("/sessions/{session_id}/segments", status_code=status.HTTP_202_ACCEPTED)
    def add_segment(
        session_id: str, data: SegmentCreate, _authorized: None = protected
    ) -> dict[str, Any]:
        validate_audio_path(settings.recordings_root, data.relative_path)
        try:
            inserted = database.add_segment(session_id, data)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if inserted:
            service.enqueue_live(session_id, data.segment_id)
        return {"accepted": True, "duplicate": not inserted}

    @application.patch("/sessions/{session_id}/state")
    def update_state(
        session_id: str, data: StateUpdate, _authorized: None = protected
    ) -> dict[str, str]:
        try:
            database.set_state(session_id, data.state)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"state": data.state.value}

    @application.post("/sessions/{session_id}/finalize", status_code=status.HTTP_202_ACCEPTED)
    def finalize(session_id: str, _authorized: None = protected) -> dict[str, Any]:
        try:
            inserted = database.begin_finalization(session_id)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if inserted:
            service.enqueue_final(session_id)
        return {"accepted": True, "already_requested": not inserted}

    @application.post("/sessions/{session_id}/abort")
    def abort(
        session_id: str, data: AbortRequest, _authorized: None = protected
    ) -> dict[str, str]:
        try:
            database.abort_session(session_id, data.reason)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return {"state": "aborted"}

    @application.get("/sessions/{session_id}/status")
    def session_status(session_id: str, _authorized: None = protected) -> dict[str, Any]:
        try:
            return {**database.status(session_id), "worker": service.health()}
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/sessions/latest/{guild_id}")
    def latest_session(guild_id: str, _authorized: None = protected) -> dict[str, Any]:
        try:
            return {**database.latest_session(guild_id), "worker": service.health()}
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/sessions/{session_id}/results")
    def results(
        session_id: str,
        after: Annotated[int, Query(ge=0)] = 0,
        _authorized: None = protected,
    ) -> dict[str, Any]:
        try:
            return database.result_page(session_id, after)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/sessions/{session_id}/transcript")
    def transcript(session_id: str, _authorized: None = protected) -> FileResponse:
        try:
            session = database.get_session(session_id)
        except NotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        if session["state"] != "completed" or not session["transcript_path"]:
            raise HTTPException(status_code=409, detail="transcript is not complete")
        path = Path(session["transcript_path"]).resolve()
        if settings.recordings_root not in path.parents or not path.is_file():
            raise HTTPException(status_code=500, detail="transcript file is missing")
        return FileResponse(
            path,
            media_type="text/plain; charset=utf-8",
            filename=f"{session_id}.txt",
        )

    return application


def validate_audio_path(root: Path, relative_path: str) -> Path:
    if Path(relative_path).is_absolute():
        raise HTTPException(status_code=400, detail="audio path must be relative")
    candidate = (root / relative_path).resolve()
    if root not in candidate.parents or candidate.suffix.lower() != ".ogg":
        raise HTTPException(status_code=400, detail="invalid audio path")
    if not candidate.is_file():
        raise HTTPException(status_code=400, detail="audio file does not exist")
    return candidate


app = create_app()
