from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .models import Participant, SegmentCreate, SessionCreate, SessionState


ACTIVE_STATES = (
    SessionState.RECORDING.value,
    SessionState.PAUSED.value,
    SessionState.FINALIZING.value,
)


class ConflictError(RuntimeError):
    pass


class NotFoundError(RuntimeError):
    pass


class Database:
    """Small SQLite repository; every operation is committed atomically."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    guild_id TEXT NOT NULL,
                    voice_channel_id TEXT NOT NULL,
                    voice_channel_name TEXT NOT NULL,
                    text_channel_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    state TEXT NOT NULL,
                    transcript_path TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS participants (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL,
                    speaker TEXT NOT NULL,
                    first_seen INTEGER NOT NULL,
                    PRIMARY KEY (session_id, user_id)
                );

                CREATE TABLE IF NOT EXISTS audio_segments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL,
                    user_id TEXT NOT NULL,
                    speaker TEXT NOT NULL,
                    relative_start_ms INTEGER NOT NULL,
                    relative_end_ms INTEGER NOT NULL,
                    relative_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(session_id, sequence),
                    UNIQUE(session_id, relative_path)
                );

                CREATE TABLE IF NOT EXISTS transcript_lines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    audio_segment_id TEXT NOT NULL REFERENCES audio_segments(id) ON DELETE CASCADE,
                    pass_type TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    user_id TEXT NOT NULL,
                    speaker TEXT NOT NULL,
                    text TEXT NOT NULL,
                    UNIQUE(audio_segment_id, pass_type, ordinal)
                );

                CREATE INDEX IF NOT EXISTS idx_lines_session_pass_start
                    ON transcript_lines(session_id, pass_type, start_ms, id);
                CREATE INDEX IF NOT EXISTS idx_segments_session_sequence
                    ON audio_segments(session_id, sequence);
                """
            )

    def create_session(self, data: SessionCreate) -> dict[str, Any]:
        with self._write_lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM sessions WHERE id = ?", (data.session_id,)
            ).fetchone()
            if existing:
                raise ConflictError(f"session {data.session_id} already exists")

            active = connection.execute(
                f"SELECT id FROM sessions WHERE state IN ({','.join('?' for _ in ACTIVE_STATES)}) LIMIT 1",
                ACTIVE_STATES,
            ).fetchone()
            if active:
                raise ConflictError(f"session {active['id']} is already active")

            connection.execute(
                """
                INSERT INTO sessions(
                    id, guild_id, voice_channel_id, voice_channel_name,
                    text_channel_id, started_at, state
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.session_id,
                    data.guild_id,
                    data.voice_channel_id,
                    clean_one_line(data.voice_channel_name),
                    data.text_channel_id,
                    data.started_at,
                    SessionState.RECORDING.value,
                ),
            )
            for index, participant in enumerate(data.participants):
                self._upsert_participant(connection, data.session_id, participant, index)
            return self.get_session(data.session_id, connection)

    def get_session(
        self, session_id: str, connection: sqlite3.Connection | None = None
    ) -> dict[str, Any]:
        owns_connection = connection is None
        connection = connection or self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not row:
                raise NotFoundError(f"session {session_id} not found")
            return dict(row)
        finally:
            if owns_connection:
                connection.close()

    def add_segment(self, session_id: str, data: SegmentCreate) -> bool:
        with self._write_lock, self._connect() as connection:
            session = self.get_session(session_id, connection)
            if session["state"] not in (
                SessionState.RECORDING.value,
                SessionState.PAUSED.value,
            ):
                raise ConflictError(f"session is {session['state']}; segments are closed")

            existing = connection.execute(
                "SELECT id FROM audio_segments WHERE id = ?", (data.segment_id,)
            ).fetchone()
            if existing:
                return False

            connection.execute(
                """
                INSERT INTO audio_segments(
                    id, session_id, sequence, user_id, speaker,
                    relative_start_ms, relative_end_ms, relative_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.segment_id,
                    session_id,
                    data.sequence,
                    data.user_id,
                    clean_one_line(data.speaker),
                    data.relative_start_ms,
                    max(data.relative_start_ms, data.relative_end_ms),
                    data.relative_path,
                ),
            )
            first_seen = connection.execute(
                "SELECT COUNT(*) AS count FROM participants WHERE session_id = ?",
                (session_id,),
            ).fetchone()["count"]
            self._upsert_participant(
                connection,
                session_id,
                Participant(user_id=data.user_id, speaker=data.speaker),
                first_seen,
            )
            return True

    def _upsert_participant(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        participant: Participant,
        first_seen: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO participants(session_id, user_id, speaker, first_seen)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, user_id) DO NOTHING
            """,
            (
                session_id,
                participant.user_id,
                clean_one_line(participant.speaker),
                first_seen,
            ),
        )

    def set_state(self, session_id: str, state: SessionState) -> None:
        allowed = {
            SessionState.RECORDING: {SessionState.PAUSED},
            SessionState.PAUSED: {SessionState.RECORDING},
        }
        with self._write_lock, self._connect() as connection:
            session = self.get_session(session_id, connection)
            current = SessionState(session["state"])
            if current == state:
                return
            if state not in allowed.get(current, set()):
                raise ConflictError(f"cannot transition {current.value} to {state.value}")
            connection.execute(
                "UPDATE sessions SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (state.value, session_id),
            )

    def begin_finalization(self, session_id: str) -> bool:
        with self._write_lock, self._connect() as connection:
            session = self.get_session(session_id, connection)
            if session["state"] == SessionState.COMPLETED.value:
                return False
            if session["state"] == SessionState.FINALIZING.value:
                return False
            if session["state"] not in (
                SessionState.RECORDING.value,
                SessionState.PAUSED.value,
            ):
                raise ConflictError(f"cannot finalize session in {session['state']}")
            connection.execute(
                "UPDATE sessions SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (SessionState.FINALIZING.value, session_id),
            )
            return True

    def abort_session(self, session_id: str, reason: str) -> None:
        with self._write_lock, self._connect() as connection:
            self.get_session(session_id, connection)
            connection.execute(
                """
                UPDATE sessions SET state = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (SessionState.ABORTED.value, reason[:1000], session_id),
            )

    def list_audio_segments(self, session_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM audio_segments WHERE session_id = ? ORDER BY sequence",
                (session_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def replace_lines(
        self,
        session_id: str,
        segment_id: str,
        pass_type: str,
        lines: Iterable[dict[str, Any]],
    ) -> None:
        with self._write_lock, self._connect() as connection:
            connection.execute(
                "DELETE FROM transcript_lines WHERE audio_segment_id = ? AND pass_type = ?",
                (segment_id, pass_type),
            )
            for ordinal, line in enumerate(lines):
                connection.execute(
                    """
                    INSERT INTO transcript_lines(
                        session_id, audio_segment_id, pass_type, ordinal,
                        start_ms, end_ms, user_id, speaker, text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        segment_id,
                        pass_type,
                        ordinal,
                        line["start_ms"],
                        line["end_ms"],
                        line["user_id"],
                        clean_one_line(line["speaker"]),
                        clean_one_line(line["text"]),
                    ),
                )
            status = "preliminary_done" if pass_type == "preliminary" else "final_done"
            connection.execute(
                "UPDATE audio_segments SET status = ?, error = NULL WHERE id = ?",
                (status, segment_id),
            )

    def fail_segment(self, segment_id: str, error: str) -> None:
        with self._write_lock, self._connect() as connection:
            connection.execute(
                "UPDATE audio_segments SET status = 'failed', error = ? WHERE id = ?",
                (error[:1000], segment_id),
            )

    def fail_session(self, session_id: str, error: str) -> None:
        with self._write_lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE sessions SET state = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (SessionState.FAILED.value, error[:2000], session_id),
            )

    def complete_session(self, session_id: str, transcript_path: Path) -> None:
        with self._write_lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE sessions SET state = ?, transcript_path = ?, error = NULL,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """,
                (SessionState.COMPLETED.value, str(transcript_path), session_id),
            )

    def result_page(self, session_id: str, after: int) -> dict[str, Any]:
        self.get_session(session_id)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, start_ms AS start, end_ms AS end, user_id, speaker, text
                FROM transcript_lines
                WHERE session_id = ? AND pass_type = 'preliminary' AND id > ?
                ORDER BY id
                """,
                (session_id, after),
            ).fetchall()
            lines = [dict(row) for row in rows]
            cursor = max((line["id"] for line in lines), default=after)
            return {"cursor": cursor, "lines": lines}

    def final_lines(self, session_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT l.start_ms, l.end_ms, l.user_id, l.speaker, l.text,
                    l.audio_segment_id, l.ordinal
                FROM transcript_lines AS l
                JOIN audio_segments AS a ON a.id = l.audio_segment_id
                WHERE l.session_id = ? AND l.pass_type = 'final'
                ORDER BY l.start_ms, a.sequence, l.ordinal
                """,
                (session_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def participants(self, session_id: str) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT user_id, speaker FROM participants
                WHERE session_id = ? ORDER BY first_seen, rowid
                """,
                (session_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def status(self, session_id: str) -> dict[str, Any]:
        session = self.get_session(session_id)
        with self._connect() as connection:
            counts = connection.execute(
                """
                SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                    SUM(CASE WHEN status = 'preliminary_done' THEN 1 ELSE 0 END) AS preliminary_done,
                    SUM(CASE WHEN status = 'final_done' THEN 1 ELSE 0 END) AS final_done,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                FROM audio_segments WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
        session["segments"] = {key: int(counts[key] or 0) for key in counts.keys()}
        session["participants"] = self.participants(session_id)
        return session

    def latest_session(self, guild_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id FROM sessions WHERE guild_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (guild_id,),
            ).fetchone()
        if not row:
            raise NotFoundError(f"no sessions found for guild {guild_id}")
        return self.status(row["id"])


def clean_one_line(value: str) -> str:
    return " ".join(value.replace("\x00", "").split()).strip()
