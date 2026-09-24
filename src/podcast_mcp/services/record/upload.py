"""Chunk ACK store for record keepers — same sqlite file as session sync."""

from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.session_sync.sqlite import connect_session_db
from podcast_mcp.util.body_limits import record_upload_max_part_bytes
from podcast_mcp.util.progress import progress_task
from podcast_mcp.util.wav import pcm_wav_header

KEEPER_SAMPLE_RATE = 48_000
JOIN_OFFSET_MAX_MS = 24 * 60 * 60 * 1000
RECORD_UPLOAD_MAX_PARTS = 256
RECORD_UPLOAD_MAX_ASSEMBLED = 512 * 1024 * 1024
RECORD_UPLOAD_PENDING_QUOTA = 2 * RECORD_UPLOAD_MAX_ASSEMBLED
RECORD_UPLOAD_TTL_SEC = 7 * 24 * 3600
RECORD_UPLOAD_COPY_CHUNK = 1024 * 1024
UPLOAD_KIND_KEEPER = "keeper"
UPLOAD_KIND_ROOM_TONE = "room_tone"
# Reserved take so room-tone rows never collide with sequential keepers.
ROOM_TONE_TAKE_INDEX = 2_147_483_647
ROOM_TONE_SEGMENT_INDEX = 0
ROOM_TONE_MAX_DURATION_SEC = 10
ROOM_TONE_MAX_PCM_BYTES = KEEPER_SAMPLE_RATE * 2 * ROOM_TONE_MAX_DURATION_SEC
_SAFE_ID = re.compile(r"^p_[A-Za-z0-9]+$")
_SAFE_SESSION = re.compile(r"^[A-Za-z0-9._-]+$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS record_upload_parts (
  session_id TEXT NOT NULL,
  take_index INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  part_seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  acked_ns INTEGER NOT NULL,
  PRIMARY KEY (session_id, take_index, participant_id, segment_index, part_seq)
);

CREATE TABLE IF NOT EXISTS record_upload_files (
  session_id TEXT NOT NULL,
  take_index INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  file_sha256 TEXT,
  byte_length INTEGER,
  expected_parts INTEGER,
  acked_ns INTEGER,
  join_offset_ms INTEGER,
  landed_ns INTEGER,
  land_failed_ns INTEGER,
  PRIMARY KEY (session_id, take_index, participant_id, segment_index)
);

CREATE TABLE IF NOT EXISTS record_take_tombstones (
  session_id TEXT NOT NULL,
  take_index INTEGER NOT NULL,
  tombstoned_ns INTEGER NOT NULL,
  PRIMARY KEY (session_id, take_index)
);
"""

_FILE_COLUMN_MIGRATIONS: dict[str, str] = {
    "join_offset_ms": "INTEGER",
    "landed_ns": "INTEGER",
    "expected_parts": "INTEGER",
    "land_failed_ns": "INTEGER",
}

_STORE_CACHE: dict[str, RecordUploadStore] = {}
_STORE_LOCK = threading.Lock()
_INGEST_LOCKS_GUARD = threading.Lock()
_INGEST_LOCKS: dict[tuple[str, str, str], threading.Lock] = {}


def _ingest_lock(session_id: str, kind: str, participant_id: str) -> threading.Lock:
    key = (session_id, kind, participant_id)
    with _INGEST_LOCKS_GUARD:
        lock = _INGEST_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _INGEST_LOCKS[key] = lock
        return lock


class RecordUploadError(ValueError):
    """Reject a chunk or resume query."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_upload_index(value: int | str, *, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise RecordUploadError(f"invalid {name}") from exc
    if parsed < 0:
        raise RecordUploadError(f"invalid {name}")
    return parsed


def parse_join_offset_ms(value: int | str) -> int:
    parsed = parse_upload_index(value, name="join_offset_ms")
    if parsed > JOIN_OFFSET_MAX_MS:
        raise RecordUploadError("join_offset_ms too large")
    return parsed


def parse_participant_id(value: str) -> str:
    pid = str(value or "").strip()
    if pid != "p_host" and not _SAFE_ID.fullmatch(pid):
        raise RecordUploadError("invalid participant_id")
    return pid


def parse_session_id(value: str) -> str:
    sid = str(value or "").strip()
    if not _SAFE_SESSION.fullmatch(sid) or sid in {".", ".."}:
        raise RecordUploadError("invalid session_id")
    return sid


def parse_upload_kind(value: str | None) -> str:
    raw = str(value or UPLOAD_KIND_KEEPER).strip().lower()
    if raw in ("", UPLOAD_KIND_KEEPER):
        return UPLOAD_KIND_KEEPER
    if raw == UPLOAD_KIND_ROOM_TONE:
        return UPLOAD_KIND_ROOM_TONE
    raise RecordUploadError("invalid kind")


def cached_record_upload_store(path: Path) -> RecordUploadStore:
    key = str(path.resolve())
    with _STORE_LOCK:
        store = _STORE_CACHE.get(key)
        if store is None:
            store = RecordUploadStore(path)
            _STORE_CACHE[key] = store
        return store


def drop_cached_record_upload_stores() -> list[RecordUploadStore]:
    with _STORE_LOCK:
        stores = list(_STORE_CACHE.values())
        _STORE_CACHE.clear()
    return stores


def pending_record_upload_bytes(root: Path) -> int:
    if not root.is_dir():
        return 0
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def sweep_stale_record_uploads(root: Path, *, ttl_sec: int = RECORD_UPLOAD_TTL_SEC) -> int:
    if not root.is_dir():
        return 0
    now = time.time()
    removed = 0
    for part_file in root.rglob("*.part"):
        try:
            if now - part_file.stat().st_mtime > ttl_sec:
                part_file.unlink(missing_ok=True)
                removed += 1
        except OSError:
            continue
    return removed


class RecordUploadStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = connect_session_db(db_path)
        with self._lock:
            self._conn.executescript(_SCHEMA)
            existing = {
                str(row["name"])
                for row in self._conn.execute("PRAGMA table_info(record_upload_files)")
            }
            for name, ddl in _FILE_COLUMN_MIGRATIONS.items():
                if name not in existing:
                    self._conn.execute(f"ALTER TABLE record_upload_files ADD COLUMN {name} {ddl}")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def part_sha256(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        part_seq: int,
    ) -> str | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT sha256 FROM record_upload_parts
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ? AND part_seq = ?
                """,
                (session_id, take_index, participant_id, segment_index, part_seq),
            ).fetchone()
        if row is None:
            return None
        return str(row["sha256"])

    def put_part(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        part_seq: int,
        digest: str,
        byte_length: int,
    ) -> bool:
        now = time.time_ns()
        with self._lock:
            row = self._conn.execute(
                """
                SELECT sha256 FROM record_upload_parts
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ? AND part_seq = ?
                """,
                (session_id, take_index, participant_id, segment_index, part_seq),
            ).fetchone()
            if row is not None:
                if str(row["sha256"]) != digest:
                    raise RecordUploadError("part hash mismatch")
                return False
            try:
                self._conn.execute(
                    """
                    INSERT INTO record_upload_parts (
                      session_id, take_index, participant_id, segment_index, part_seq,
                      sha256, byte_length, acked_ns
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        take_index,
                        participant_id,
                        segment_index,
                        part_seq,
                        digest,
                        byte_length,
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                existing = self._conn.execute(
                    """
                    SELECT sha256 FROM record_upload_parts
                    WHERE session_id = ? AND take_index = ? AND participant_id = ?
                      AND segment_index = ? AND part_seq = ?
                    """,
                    (session_id, take_index, participant_id, segment_index, part_seq),
                ).fetchone()
                if existing is None or str(existing["sha256"]) != digest:
                    raise RecordUploadError("part hash mismatch") from None
                return False
        return True

    def parts(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT part_seq, sha256, byte_length FROM record_upload_parts
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                ORDER BY part_seq ASC
                """,
                (session_id, take_index, participant_id, segment_index),
            ).fetchall()
        return [
            {
                "part_seq": int(row["part_seq"]),
                "sha256": str(row["sha256"]),
                "byte_length": int(row["byte_length"]),
            }
            for row in rows
        ]

    def set_join_offset(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        join_offset_ms: int,
    ) -> None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT landed_ns FROM record_upload_files
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                """,
                (session_id, take_index, participant_id, segment_index),
            ).fetchone()
            if row is not None and row["landed_ns"] is not None:
                raise RecordUploadError("join_offset refused after land")
            self._conn.execute(
                """
                INSERT INTO record_upload_files (
                  session_id, take_index, participant_id, segment_index, join_offset_ms
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id, take_index, participant_id, segment_index)
                DO UPDATE SET join_offset_ms = excluded.join_offset_ms
                """,
                (session_id, take_index, participant_id, segment_index, join_offset_ms),
            )

    def set_expected_parts(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        expected_parts: int,
    ) -> None:
        if expected_parts < 1 or expected_parts > RECORD_UPLOAD_MAX_PARTS:
            raise RecordUploadError("invalid expected_parts")
        with self._lock:
            existing = self._conn.execute(
                """
                SELECT expected_parts FROM record_upload_files
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                """,
                (session_id, take_index, participant_id, segment_index),
            ).fetchone()
            if (
                existing is not None
                and existing["expected_parts"] is not None
                and int(existing["expected_parts"]) != expected_parts
            ):
                raise RecordUploadError("expected_parts mismatch")
            self._conn.execute(
                """
                INSERT INTO record_upload_files (
                  session_id, take_index, participant_id, segment_index,
                  expected_parts
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id, take_index, participant_id, segment_index)
                DO UPDATE SET expected_parts = excluded.expected_parts
                WHERE record_upload_files.expected_parts IS NULL
                   OR record_upload_files.expected_parts = excluded.expected_parts
                """,
                (
                    session_id,
                    take_index,
                    participant_id,
                    segment_index,
                    expected_parts,
                ),
            )

    def mark_file(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        file_sha256: str,
        byte_length: int,
    ) -> None:
        now = time.time_ns()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO record_upload_files (
                  session_id, take_index, participant_id, segment_index,
                  file_sha256, byte_length, acked_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, take_index, participant_id, segment_index)
                DO UPDATE SET
                  file_sha256 = excluded.file_sha256,
                  byte_length = excluded.byte_length,
                  acked_ns = excluded.acked_ns,
                  landed_ns = CASE
                    WHEN excluded.take_index = ? THEN NULL
                    ELSE record_upload_files.landed_ns
                  END,
                  land_failed_ns = NULL
                """,
                (
                    session_id,
                    take_index,
                    participant_id,
                    segment_index,
                    file_sha256,
                    byte_length,
                    now,
                    ROOM_TONE_TAKE_INDEX,
                ),
            )

    def mark_landed(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> None:
        now = time.time_ns()
        with self._lock:
            self._conn.execute(
                """
                UPDATE record_upload_files SET landed_ns = ?, land_failed_ns = NULL
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                """,
                (now, session_id, take_index, participant_id, segment_index),
            )

    def mark_land_failed(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> None:
        now = time.time_ns()
        with self._lock:
            self._conn.execute(
                """
                UPDATE record_upload_files SET land_failed_ns = ?, landed_ns = NULL
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ? AND acked_ns IS NOT NULL
                """,
                (now, session_id, take_index, participant_id, segment_index),
            )

    def file_row(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT file_sha256, byte_length, expected_parts, acked_ns,
                       join_offset_ms, landed_ns, land_failed_ns
                FROM record_upload_files
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ? AND acked_ns IS NOT NULL
                """,
                (session_id, take_index, participant_id, segment_index),
            ).fetchone()
        if row is None or row["acked_ns"] is None:
            return None
        join = row["join_offset_ms"]
        landed = row["landed_ns"]
        return {
            "file_sha256": str(row["file_sha256"]),
            "byte_length": int(row["byte_length"]),
            "expected_parts": (
                int(row["expected_parts"]) if row["expected_parts"] is not None else None
            ),
            "acked_ns": int(row["acked_ns"]),
            "join_offset_ms": int(join) if join is not None else 0,
            "landed": landed is not None,
            "land_failed": row["land_failed_ns"] is not None,
        }

    def tombstoned_takes(self, session_id: str) -> set[int]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT take_index FROM record_take_tombstones WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        return {int(row["take_index"]) for row in rows}

    def take_manifest_terminal(self, session_id: str, take_index: int) -> bool:
        with self._lock:
            part_rows = self._conn.execute(
                """
                SELECT DISTINCT participant_id, segment_index FROM record_upload_parts
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            ).fetchall()
            file_rows = self._conn.execute(
                """
                SELECT participant_id, segment_index FROM record_upload_files
                WHERE session_id = ? AND take_index = ? AND acked_ns IS NOT NULL
                """,
                (session_id, take_index),
            ).fetchall()
        acked = {(str(row["participant_id"]), int(row["segment_index"])) for row in file_rows}
        pending = {(str(row["participant_id"]), int(row["segment_index"])) for row in part_rows}
        return pending <= acked

    def tombstone_take(self, session_id: str, take_index: int) -> None:
        now = time.time_ns()
        with self._lock:
            already = self._conn.execute(
                """
                SELECT 1 FROM record_take_tombstones
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            ).fetchone()
            self._conn.execute(
                """
                INSERT INTO record_take_tombstones (session_id, take_index, tombstoned_ns)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id, take_index) DO UPDATE SET tombstoned_ns = excluded.tombstoned_ns
                """,
                (session_id, take_index, now),
            )
            self._conn.execute(
                """
                DELETE FROM record_upload_parts
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            )
            self._conn.execute(
                """
                DELETE FROM record_upload_files
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            )
            if already is None:
                self._conn.execute(
                    "UPDATE record_upload_files SET landed_ns = NULL WHERE session_id = ?",
                    (session_id,),
                )

    def delete_segment(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                DELETE FROM record_upload_parts
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                """,
                (session_id, take_index, participant_id, segment_index),
            )
            self._conn.execute(
                """
                DELETE FROM record_upload_files
                WHERE session_id = ? AND take_index = ? AND participant_id = ?
                  AND segment_index = ?
                """,
                (session_id, take_index, participant_id, segment_index),
            )

    def status(
        self,
        *,
        session_id: str,
        participant_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if participant_id is not None:
            part_sql = """
                SELECT take_index, participant_id, segment_index, part_seq
                FROM record_upload_parts
                WHERE session_id = ? AND participant_id = ?
                ORDER BY take_index, participant_id, segment_index, part_seq
                """
            file_sql = """
                SELECT take_index, participant_id, segment_index, file_sha256, byte_length,
                       expected_parts, acked_ns, join_offset_ms, landed_ns, land_failed_ns
                FROM record_upload_files
                WHERE session_id = ? AND participant_id = ?
                """
            params: tuple[Any, ...] = (session_id, participant_id)
        else:
            part_sql = """
                SELECT take_index, participant_id, segment_index, part_seq
                FROM record_upload_parts
                WHERE session_id = ?
                ORDER BY take_index, participant_id, segment_index, part_seq
                """
            file_sql = """
                SELECT take_index, participant_id, segment_index, file_sha256, byte_length,
                       expected_parts, acked_ns, join_offset_ms, landed_ns, land_failed_ns
                FROM record_upload_files
                WHERE session_id = ?
                """
            params = (session_id,)
        with self._lock:
            part_rows = self._conn.execute(part_sql, params).fetchall()
            file_rows = self._conn.execute(file_sql, params).fetchall()
        tombstoned = self.tombstoned_takes(session_id)
        segments: dict[tuple[int, str, int], dict[str, Any]] = {}
        for row in part_rows:
            take = int(row["take_index"])
            if take in tombstoned:
                continue
            key = (take, str(row["participant_id"]), int(row["segment_index"]))
            slot = segments.setdefault(
                key,
                {
                    "take_index": key[0],
                    "participant_id": key[1],
                    "segment_index": key[2],
                    "acked_parts": [],
                    "file_ack": False,
                    "join_offset_ms": 0,
                    "landed": False,
                    "land_failed": False,
                    "expected_parts": None,
                },
            )
            slot["acked_parts"].append(int(row["part_seq"]))
        for row in file_rows:
            take = int(row["take_index"])
            if take in tombstoned:
                continue
            key = (take, str(row["participant_id"]), int(row["segment_index"]))
            slot = segments.setdefault(
                key,
                {
                    "take_index": key[0],
                    "participant_id": key[1],
                    "segment_index": key[2],
                    "acked_parts": [],
                    "file_ack": False,
                    "join_offset_ms": 0,
                    "landed": False,
                },
            )
            slot["file_ack"] = row["acked_ns"] is not None
            if row["file_sha256"] is not None:
                slot["file_sha256"] = str(row["file_sha256"])
            if row["byte_length"] is not None:
                slot["byte_length"] = int(row["byte_length"])
            join = row["join_offset_ms"]
            slot["join_offset_ms"] = int(join) if join is not None else 0
            slot["landed"] = row["landed_ns"] is not None
            slot["land_failed"] = row["land_failed_ns"] is not None
            if row["expected_parts"] is not None:
                slot["expected_parts"] = int(row["expected_parts"])
        return list(segments.values())


class RecordUploadService:
    def __init__(self, project: EpisodeProject) -> None:
        self._project = project
        self._store = cached_record_upload_store(sync_db_path(project))
        self._root = Path(project.workspace_dir) / "artifacts" / "record" / "uploads"
        self._acked = Path(project.workspace_dir) / "artifacts" / "record" / "acked"

    def status(self, *, session_id: str, participant_id: str | None = None) -> dict[str, Any]:
        sid = parse_session_id(session_id)
        pid = parse_participant_id(participant_id) if participant_id else None
        segments = [
            row
            for row in self._store.status(session_id=sid, participant_id=pid)
            if int(row["take_index"]) != ROOM_TONE_TAKE_INDEX
        ]
        for row in segments:
            row["acked_parts"] = [
                seq
                for seq in row["acked_parts"]
                if self._part_path(
                    sid,
                    int(row["take_index"]),
                    str(row["participant_id"]),
                    int(row["segment_index"]),
                    seq,
                    kind=UPLOAD_KIND_KEEPER,
                ).is_file()
            ]
        return {
            "session_id": sid,
            "segments": segments,
            "room_tone_status": self.room_tone_status(session_id=sid, participant_id=pid),
        }

    def room_tone_status(
        self, *, session_id: str, participant_id: str | None = None
    ) -> list[dict[str, Any]]:
        sid = parse_session_id(session_id)
        pid = parse_participant_id(participant_id) if participant_id else None
        return [
            {**row, "kind": UPLOAD_KIND_ROOM_TONE}
            for row in self._store.status(session_id=sid, participant_id=pid)
            if int(row["take_index"]) == ROOM_TONE_TAKE_INDEX
        ]

    def ingest_part(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        part_seq: int,
        data: bytes,
        digest: str,
        file_sha256: str | None = None,
        final: bool = False,
        expected_parts: int | None = None,
        join_offset_ms: int | None = None,
        kind: str | None = None,
    ) -> dict[str, Any]:
        sid = parse_session_id(session_id)
        pid = parse_participant_id(participant_id)
        upload_kind = parse_upload_kind(kind)
        parse_upload_index(take_index, name="take_index")
        parse_upload_index(segment_index, name="segment_index")
        seq = parse_upload_index(part_seq, name="part_seq")
        with _ingest_lock(sid, upload_kind, pid):
            return self._ingest_part_locked(
                sid=sid,
                pid=pid,
                take_index=take_index,
                segment_index=segment_index,
                seq=seq,
                data=data,
                digest=digest,
                file_sha256=file_sha256,
                final=final,
                join_offset_ms=join_offset_ms,
                upload_kind=upload_kind,
                expected_parts=expected_parts,
            )

    def _ingest_part_locked(
        self,
        *,
        sid: str,
        pid: str,
        take_index: int,
        segment_index: int,
        seq: int,
        data: bytes,
        digest: str,
        file_sha256: str | None,
        final: bool,
        expected_parts: int | None,
        join_offset_ms: int | None,
        upload_kind: str,
    ) -> dict[str, Any]:
        if upload_kind == UPLOAD_KIND_ROOM_TONE:
            take = ROOM_TONE_TAKE_INDEX
            segment = ROOM_TONE_SEGMENT_INDEX
            if seq != 0:
                raise RecordUploadError("room tone must be a single part")
            if join_offset_ms is not None:
                raise RecordUploadError("join_offset_ms not allowed for room tone")
            if not final:
                raise RecordUploadError("room tone must be a single part")
        else:
            take = parse_upload_index(take_index, name="take_index")
            segment = parse_upload_index(segment_index, name="segment_index")
        declared_parts = (
            parse_upload_index(expected_parts, name="expected_parts")
            if expected_parts is not None
            else None
        )
        if upload_kind == UPLOAD_KIND_ROOM_TONE:
            declared_parts = None
        else:
            if final and declared_parts is None:
                # Older recording tabs omit the count. Their final sequence still
                # gives an exact count, while the stored manifest (if present)
                # remains authoritative through set_expected_parts below.
                declared_parts = seq + 1
            if declared_parts is not None and seq >= declared_parts:
                raise RecordUploadError("part_seq exceeds expected_parts")
        payload = bytes(data or b"")
        offset: int | None = None
        if join_offset_ms is not None:
            offset = parse_join_offset_ms(join_offset_ms)
        if seq >= RECORD_UPLOAD_MAX_PARTS:
            raise RecordUploadError("too many parts")
        if upload_kind == UPLOAD_KIND_ROOM_TONE and len(payload) > ROOM_TONE_MAX_PCM_BYTES:
            raise RecordUploadError("room tone too large")
        if len(payload) > record_upload_max_part_bytes():
            raise RecordUploadError("part too large")
        if final and not file_sha256:
            raise RecordUploadError("file_sha256 required")
        if not payload and not final:
            raise RecordUploadError("empty part")
        if payload and digest != sha256_hex(payload):
            raise RecordUploadError("sha256 mismatch")
        if declared_parts is not None:
            self._store.set_expected_parts(
                session_id=sid,
                take_index=take,
                participant_id=pid,
                segment_index=segment,
                expected_parts=declared_parts,
            )
        if payload:
            expected = digest
            path = self._part_path(sid, take, pid, segment, seq, kind=upload_kind)
            known = self._store.part_sha256(
                session_id=sid,
                take_index=take,
                participant_id=pid,
                segment_index=segment,
                part_seq=seq,
            )
            if upload_kind == UPLOAD_KIND_ROOM_TONE:
                existing_file = self._store.file_row(
                    session_id=sid,
                    take_index=take,
                    participant_id=pid,
                    segment_index=segment,
                )
                different_part = known is not None and known != expected
                different_file = (
                    existing_file is not None
                    and file_sha256
                    and existing_file["file_sha256"] != file_sha256
                )
                if different_part or different_file:
                    self._clear_room_tone(sid, pid)
                    known = None
            elif known is not None and known != expected:
                raise RecordUploadError("part hash mismatch")
            if known is None or not path.is_file():
                sweep_stale_record_uploads(self._root)
                pending = pending_record_upload_bytes(self._root)
                if pending + len(payload) > RECORD_UPLOAD_PENDING_QUOTA:
                    raise RecordUploadError("pending upload quota exceeded")
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(f"{path.name}.tmp")
                tmp.write_bytes(payload)
                try:
                    self._store.put_part(
                        session_id=sid,
                        take_index=take,
                        participant_id=pid,
                        segment_index=segment,
                        part_seq=seq,
                        digest=expected,
                        byte_length=len(payload),
                    )
                    tmp.replace(path)
                except Exception:
                    tmp.unlink(missing_ok=True)
                    raise
        if (
            final
            and declared_parts is not None
            and len(
                self._store.parts(
                    session_id=sid,
                    take_index=take,
                    participant_id=pid,
                    segment_index=segment,
                )
            )
            != declared_parts
        ):
            raise RecordUploadError("expected_parts incomplete")
        if offset is not None:
            self._store.set_join_offset(
                session_id=sid,
                take_index=take,
                participant_id=pid,
                segment_index=segment,
                join_offset_ms=offset,
            )
        newly_acked = False
        if final:
            newly_acked = self._assemble(
                session_id=sid,
                take_index=take,
                participant_id=pid,
                segment_index=segment,
                file_sha256=str(file_sha256),
                kind=upload_kind,
            )
        existing = self._store.file_row(
            session_id=sid,
            take_index=take,
            participant_id=pid,
            segment_index=segment,
        )
        return {
            "acked": True,
            "take_index": take,
            "participant_id": pid,
            "segment_index": segment,
            "part_seq": seq,
            "file_ack": bool(newly_acked or existing),
            "landed": bool(existing and existing.get("landed")),
            "land_failed": bool(existing and existing.get("land_failed")),
            "newly_acked": newly_acked,
            "kind": upload_kind,
        }

    def _part_path(
        self,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        part_seq: int,
        *,
        kind: str = UPLOAD_KIND_KEEPER,
    ) -> Path:
        if kind == UPLOAD_KIND_ROOM_TONE:
            return self._root / session_id / "room_tone" / participant_id / f"{part_seq}.part"
        return (
            self._root
            / session_id
            / str(take_index)
            / participant_id
            / str(segment_index)
            / f"{part_seq}.part"
        )

    def acked_wav(
        self,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> Path:
        sid = parse_session_id(session_id)
        pid = parse_participant_id(participant_id)
        take = parse_upload_index(take_index, name="take_index")
        segment = parse_upload_index(segment_index, name="segment_index")
        kind = UPLOAD_KIND_ROOM_TONE if take == ROOM_TONE_TAKE_INDEX else UPLOAD_KIND_KEEPER
        return self._acked_path(sid, take, pid, segment, kind=kind)

    def tombstoned_takes(self, session_id: str) -> set[int]:
        return self._store.tombstoned_takes(parse_session_id(session_id))

    def take_manifest_terminal(self, session_id: str, take_index: int) -> bool:
        return self._store.take_manifest_terminal(
            parse_session_id(session_id),
            parse_upload_index(take_index, name="take_index"),
        )

    def tombstone_take(self, session_id: str, take_index: int) -> None:
        sid = parse_session_id(session_id)
        take = parse_upload_index(take_index, name="take_index")
        root = self._acked / sid / str(take)
        if root.is_dir():
            for path in root.rglob("*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
        parts_root = self._root / sid / str(take)
        if parts_root.is_dir():
            for path in parts_root.rglob("*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
        self._store.tombstone_take(sid, take)

    def revoke_room_tone(self, session_id: str, participant_id: str) -> None:
        sid = parse_session_id(session_id)
        pid = parse_participant_id(participant_id)
        with _ingest_lock(sid, UPLOAD_KIND_ROOM_TONE, pid):
            self._clear_room_tone(sid, pid)

    def _clear_room_tone(self, session_id: str, participant_id: str) -> None:
        take = ROOM_TONE_TAKE_INDEX
        segment = ROOM_TONE_SEGMENT_INDEX
        part_dir = self._root / session_id / "room_tone" / participant_id
        if part_dir.is_dir():
            for path in part_dir.rglob("*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
        acked = self._acked_path(
            session_id, take, participant_id, segment, kind=UPLOAD_KIND_ROOM_TONE
        )
        acked.unlink(missing_ok=True)
        tmp = acked.with_suffix(".wav.tmp")
        tmp.unlink(missing_ok=True)
        self._store.delete_segment(
            session_id=session_id,
            take_index=take,
            participant_id=participant_id,
            segment_index=segment,
        )

    def mark_landed(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> None:
        self._store.mark_landed(
            session_id=parse_session_id(session_id),
            take_index=parse_upload_index(take_index, name="take_index"),
            participant_id=parse_participant_id(participant_id),
            segment_index=parse_upload_index(segment_index, name="segment_index"),
        )

    def mark_land_failed(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
    ) -> None:
        self._store.mark_land_failed(
            session_id=parse_session_id(session_id),
            take_index=parse_upload_index(take_index, name="take_index"),
            participant_id=parse_participant_id(participant_id),
            segment_index=parse_upload_index(segment_index, name="segment_index"),
        )

    def _acked_path(
        self,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        *,
        kind: str = UPLOAD_KIND_KEEPER,
    ) -> Path:
        if kind == UPLOAD_KIND_ROOM_TONE:
            return self._acked / session_id / "room_tone" / f"{participant_id}.wav"
        return self._acked / session_id / str(take_index) / participant_id / f"{segment_index}.wav"

    def _assemble(
        self,
        *,
        session_id: str,
        take_index: int,
        participant_id: str,
        segment_index: int,
        file_sha256: str,
        kind: str = UPLOAD_KIND_KEEPER,
    ) -> bool:
        existing = self._store.file_row(
            session_id=session_id,
            take_index=take_index,
            participant_id=participant_id,
            segment_index=segment_index,
        )
        if existing and existing["file_sha256"] == file_sha256:
            return False
        parts = self._store.parts(
            session_id=session_id,
            take_index=take_index,
            participant_id=participant_id,
            segment_index=segment_index,
        )
        if not parts:
            raise RecordUploadError("missing parts")
        expected_seq = list(range(len(parts)))
        got_seq = [row["part_seq"] for row in parts]
        if got_seq != expected_seq:
            raise RecordUploadError("part gap")
        if kind == UPLOAD_KIND_ROOM_TONE and len(parts) != 1:
            raise RecordUploadError("room tone must be a single part")
        total_pcm = sum(int(row["byte_length"]) for row in parts)
        if kind == UPLOAD_KIND_ROOM_TONE and total_pcm > ROOM_TONE_MAX_PCM_BYTES:
            raise RecordUploadError("room tone too large")
        if total_pcm + 44 > RECORD_UPLOAD_MAX_ASSEMBLED:
            raise RecordUploadError("assembled file too large")
        dest = self._acked_path(session_id, take_index, participant_id, segment_index, kind=kind)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_dest = dest.with_suffix(".wav.tmp")
        hasher = hashlib.sha256()
        header = pcm_wav_header(total_pcm, KEEPER_SAMPLE_RATE)
        try:
            with (
                tmp_dest.open("wb") as out,
                progress_task(
                    "record_upload_assemble",
                    "Assembling record keeper",
                    total=len(parts),
                ) as progress,
            ):
                out.write(header)
                hasher.update(header)
                for row in parts:
                    part_path = self._part_path(
                        session_id,
                        take_index,
                        participant_id,
                        segment_index,
                        row["part_seq"],
                        kind=kind,
                    )
                    if not part_path.is_file():
                        raise RecordUploadError("missing parts")
                    part_hasher = hashlib.sha256()
                    remaining = int(row["byte_length"])
                    with part_path.open("rb") as src:
                        while True:
                            chunk = src.read(RECORD_UPLOAD_COPY_CHUNK)
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            if remaining < 0:
                                raise RecordUploadError("part corrupt")
                            part_hasher.update(chunk)
                            hasher.update(chunk)
                            out.write(chunk)
                    if remaining != 0 or part_hasher.hexdigest() != row["sha256"]:
                        raise RecordUploadError("part corrupt")
                    progress.advance()
            digest = hasher.hexdigest()
            if digest != file_sha256:
                raise RecordUploadError("file sha256 mismatch")
            tmp_dest.replace(dest)
        except Exception:
            tmp_dest.unlink(missing_ok=True)
            raise
        self._store.mark_file(
            session_id=session_id,
            take_index=take_index,
            participant_id=participant_id,
            segment_index=segment_index,
            file_sha256=digest,
            byte_length=total_pcm + 44,
        )
        for row in parts:
            self._part_path(
                session_id,
                take_index,
                participant_id,
                segment_index,
                row["part_seq"],
                kind=kind,
            ).unlink(missing_ok=True)
        return True
