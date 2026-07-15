from __future__ import annotations

import gc
import itertools
import logging
import queue
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from faster_whisper import WhisperModel

from .database import Database
from .models import SessionState

LOGGER = logging.getLogger(__name__)


@dataclass(order=True)
class Job:
    priority: int
    order: int
    kind: Literal["live", "final", "shutdown"] = field(compare=False)
    session_id: str = field(compare=False)
    segment_id: str | None = field(default=None, compare=False)


@dataclass(frozen=True)
class TranscriptionSettings:
    recordings_root: Path
    model_cache: Path
    live_model: str
    final_model: str
    final_revision: str
    language: str
    cuda_device: int
    # Preferred CTranslate2 compute type. On a 12 GB card shared with other
    # processes (e.g. llama-server), float16 for Large often OOMs; we fall back.
    compute_type: str = "float16"


class TranscriptionService:
    """Owns the only GPU consumer and never runs work on FastAPI's event loop."""

    def __init__(self, database: Database, settings: TranscriptionSettings):
        self.database = database
        self.settings = settings
        self.jobs: queue.PriorityQueue[Job] = queue.PriorityQueue()
        self._counter = itertools.count()
        self._thread = threading.Thread(
            target=self._run, name="gpu-transcription-worker", daemon=True
        )
        self._model: WhisperModel | None = None
        self._model_kind: Literal["live", "final"] | None = None
        self._current_job: Job | None = None
        self._stopping = threading.Event()

    def start(self) -> None:
        self._thread.start()

    def stop(self, timeout: float = 30) -> None:
        self._stopping.set()
        self.jobs.put(Job(-100, next(self._counter), "shutdown", "shutdown"))
        self._thread.join(timeout=timeout)
        self._unload_model()

    def enqueue_live(self, session_id: str, segment_id: str) -> None:
        self.jobs.put(Job(10, next(self._counter), "live", session_id, segment_id))

    def enqueue_final(self, session_id: str) -> None:
        # Final work jumps ahead of obsolete preliminary jobs after stop.
        self.jobs.put(Job(0, next(self._counter), "final", session_id))

    def health(self) -> dict[str, Any]:
        return {
            "queue_depth": self.jobs.qsize(),
            "model": self._model_kind,
            "current_job": (
                None
                if self._current_job is None
                else {
                    "kind": self._current_job.kind,
                    "session_id": self._current_job.session_id,
                    "segment_id": self._current_job.segment_id,
                }
            ),
            "thread_alive": self._thread.is_alive(),
        }

    def _run(self) -> None:
        while True:
            job = self.jobs.get()
            self._current_job = job
            try:
                if job.kind == "shutdown":
                    return
                if job.kind == "live" and job.segment_id:
                    self._run_live(job.session_id, job.segment_id)
                elif job.kind == "final":
                    self._run_final(job.session_id)
            except Exception as error:  # keep the consumer alive for later sessions
                LOGGER.exception("Transcription job failed: %s", job)
                if job.kind == "final":
                    self.database.fail_session(job.session_id, str(error))
                elif job.segment_id:
                    self.database.fail_segment(job.segment_id, str(error))
            finally:
                self._current_job = None
                self.jobs.task_done()

    def _run_live(self, session_id: str, segment_id: str) -> None:
        session = self.database.get_session(session_id)
        if session["state"] not in (
            SessionState.RECORDING.value,
            SessionState.PAUSED.value,
        ):
            return
        segment = next(
            (
                item
                for item in self.database.list_audio_segments(session_id)
                if item["id"] == segment_id
            ),
            None,
        )
        if not segment:
            return
        model = self._ensure_model("live")
        lines = self._transcribe_file(model, segment, final=False)
        self.database.replace_lines(session_id, segment_id, "preliminary", lines)

    def _run_final(self, session_id: str) -> None:
        model = self._ensure_model("final")
        errors: list[str] = []
        for segment in self.database.list_audio_segments(session_id):
            try:
                lines = self._transcribe_file(model, segment, final=True)
                self.database.replace_lines(session_id, segment["id"], "final", lines)
            except Exception as error:
                LOGGER.exception("Final pass failed for %s", segment["relative_path"])
                self.database.fail_segment(segment["id"], str(error))
                errors.append(f"{segment['relative_path']}: {error}")

        if errors:
            raise RuntimeError("; ".join(errors[:10]))

        transcript_path = self._write_transcript(session_id)
        self.database.complete_session(session_id, transcript_path)
        # Return VRAM to the fast live model only when another live job arrives.
        self._unload_model()

    def _transcribe_file(
        self, model: WhisperModel, segment: dict[str, Any], *, final: bool
    ) -> list[dict[str, Any]]:
        audio_path = (self.settings.recordings_root / segment["relative_path"]).resolve()
        if (
            self.settings.recordings_root not in audio_path.parents
            or audio_path.suffix.lower() != ".ogg"
            or not audio_path.is_file()
        ):
            raise ValueError(f"invalid or missing audio path: {segment['relative_path']}")

        segments, _info = model.transcribe(
            str(audio_path),
            language=self.settings.language,
            task="transcribe",
            beam_size=5 if final else 1,
            best_of=5 if final else 1,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=False,
            temperature=0.0,
        )
        base = int(segment["relative_start_ms"])
        lines: list[dict[str, Any]] = []
        for result in segments:
            text = clean_text(result.text)
            if not text:
                continue
            lines.append(
                {
                    "start_ms": base + round(result.start * 1000),
                    "end_ms": base + round(result.end * 1000),
                    "user_id": segment["user_id"],
                    "speaker": segment["speaker"],
                    "text": text,
                }
            )
        return lines

    def _ensure_model(self, kind: Literal["live", "final"]) -> WhisperModel:
        if self._model is not None and self._model_kind == kind:
            return self._model
        self._unload_model()
        model_id = (
            self.settings.live_model if kind == "live" else self.settings.final_model
        )
        revision = None
        if kind == "final" and self.settings.final_revision:
            revision = self.settings.final_revision
        preferred = self.settings.compute_type
        # Large Strict needs ~3 GB in float16; with llama-server on the same
        # 4070 that often fails. Prefer lighter quantizations, then CPU.
        candidates: list[tuple[str, str]] = [
            ("cuda", preferred),
            ("cuda", "int8_float16"),
            ("cuda", "int8"),
            ("cpu", "int8"),
        ]
        # De-dupe while preserving order
        seen: set[tuple[str, str]] = set()
        unique: list[tuple[str, str]] = []
        for item in candidates:
            if item not in seen:
                seen.add(item)
                unique.append(item)

        last_error: Exception | None = None
        for device, compute_type in unique:
            try:
                LOGGER.info(
                    "Loading %s model %s revision=%s device=%s compute_type=%s",
                    kind,
                    model_id,
                    revision,
                    device,
                    compute_type,
                )
                kwargs: dict[str, Any] = {
                    "device": device,
                    "compute_type": compute_type,
                    "num_workers": 1,
                    "download_root": str(self.settings.model_cache),
                }
                if revision:
                    kwargs["revision"] = revision
                if device == "cuda":
                    kwargs["device_index"] = self.settings.cuda_device
                self._model = WhisperModel(model_id, **kwargs)
                self._model_kind = kind
                return self._model
            except Exception as error:  # OOM or unsupported compute type
                last_error = error
                LOGGER.warning(
                    "Failed to load %s model on %s/%s: %s",
                    kind,
                    device,
                    compute_type,
                    error,
                )
                self._unload_model()
                continue
        assert last_error is not None
        raise last_error

    def _unload_model(self) -> None:
        if self._model is None:
            return
        try:
            self._model.model.unload_model()
        except Exception:
            LOGGER.debug("CTranslate2 model did not expose unload_model", exc_info=True)
        self._model = None
        self._model_kind = None
        gc.collect()

    def _write_transcript(self, session_id: str) -> Path:
        session = self.database.get_session(session_id)
        participants = self.database.participants(session_id)
        lines = self.database.final_lines(session_id)
        content = render_transcript(
            session_id=session_id,
            channel=session["voice_channel_name"],
            participants=[participant["speaker"] for participant in participants],
            lines=lines,
        )
        session_directory = self.settings.recordings_root / session_id
        session_directory.mkdir(parents=True, exist_ok=True)
        destination = session_directory / "transcript.txt"
        temporary = session_directory / ".transcript.txt.tmp"
        temporary.write_text(content, encoding="utf-8", newline="\n")
        temporary.replace(destination)
        return destination


def render_transcript(
    *, session_id: str, channel: str, participants: list[str], lines: list[dict[str, Any]]
) -> str:
    output = [
        "Discord Call Transcription",
        f"Session: {clean_text(session_id)}",
        f"Channel: {clean_text(channel)}",
        f"Participants: {', '.join(clean_text(name) for name in participants)}",
    ]
    for line in lines:
        output.append(
            f"[{format_relative_timestamp(int(line['start_ms']))}] "
            f"{clean_text(line['speaker'])}: {clean_text(line['text'])}"
        )
    return "\n".join(output) + "\n"


def format_relative_timestamp(milliseconds: int) -> str:
    total_seconds = max(0, milliseconds) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def clean_text(value: str) -> str:
    return " ".join(value.replace("\x00", "").split()).strip()
