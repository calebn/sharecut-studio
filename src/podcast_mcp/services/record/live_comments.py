"""Dedicated live-comment rows in the same session-sync sqlite file."""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

from podcast_mcp.edits.comments import COMMENT_BODY_MAX
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.session_sync.sqlite import connect_session_db

RECORD_LIVE_COMMENT_MAX = 500
LIVE_COMMENT_ID_PREFIX = "live-"
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS record_live_comments (
  session_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  take_index INTEGER NOT NULL,
  recording_ms INTEGER NOT NULL,
  pressed_wall_ms INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_ns INTEGER NOT NULL,
  landed_ns INTEGER,
  PRIMARY KEY (session_id, comment_id)
);
"""

_STORE_CACHE: dict[str, RecordLiveCommentStore] = {}
_STORE_LOCK = threading.Lock()


class RecordLiveCommentError(ValueError):
    """Reject a live comment upsert."""


def parse_comment_id(value: str) -> str:
    cid = str(value or "").strip()
    if not cid.startswith(LIVE_COMMENT_ID_PREFIX) or not _SAFE_ID.fullmatch(cid):
        raise RecordLiveCommentError("invalid comment id")
    return cid


def cached_record_live_comment_store(path: Path) -> RecordLiveCommentStore:
    key = str(path.resolve())
    with _STORE_LOCK:
        store = _STORE_CACHE.get(key)
        if store is None:
            store = RecordLiveCommentStore(path)
            _STORE_CACHE[key] = store
        return store


def drop_cached_record_live_comment_stores() -> list[RecordLiveCommentStore]:
    with _STORE_LOCK:
        stores = list(_STORE_CACHE.values())
        _STORE_CACHE.clear()
    return stores


def live_comment_store_for(project: EpisodeProject) -> RecordLiveCommentStore:
    return cached_record_live_comment_store(sync_db_path(project))


class RecordLiveCommentStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = connect_session_db(db_path)
        with self._lock:
            self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def clear_all(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM record_live_comments")

    def upsert(
        self,
        *,
        session_id: str,
        comment_id: str,
        take_index: int,
        recording_ms: int,
        pressed_wall_ms: int,
        author: str,
        body: str,
    ) -> dict[str, Any]:
        cid = parse_comment_id(comment_id)
        text = (body or "").strip()
        if not text:
            raise RecordLiveCommentError("comment body is required")
        if len(text) > COMMENT_BODY_MAX:
            raise RecordLiveCommentError("comment body exceeds limit")
        who = (author or "").strip()
        if not who:
            raise RecordLiveCommentError("author is required")
        now_ns = time.time_ns()
        with self._lock:
            existing = self._conn.execute(
                """
                SELECT comment_id, landed_ns, author FROM record_live_comments
                WHERE session_id = ? AND comment_id = ?
                """,
                (session_id, cid),
            ).fetchone()
            if existing is None:
                count = int(
                    self._conn.execute(
                        """
                        SELECT COUNT(*) AS n FROM record_live_comments
                        WHERE session_id = ? AND landed_ns IS NULL
                        """,
                        (session_id,),
                    ).fetchone()["n"]
                )
                if count >= RECORD_LIVE_COMMENT_MAX:
                    raise RecordLiveCommentError("too many live comments")
                self._conn.execute(
                    """
                    INSERT INTO record_live_comments (
                      session_id, comment_id, take_index, recording_ms,
                      pressed_wall_ms, author, body, created_ns, landed_ns
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        session_id,
                        cid,
                        take_index,
                        recording_ms,
                        pressed_wall_ms,
                        who,
                        text,
                        now_ns,
                    ),
                )
            elif existing["landed_ns"] is None:
                if str(existing["author"]) != who:
                    raise RecordLiveCommentError("comment belongs to another participant")
                self._conn.execute(
                    """
                    UPDATE record_live_comments
                    SET take_index = ?, recording_ms = ?, pressed_wall_ms = ?,
                        body = ?
                    WHERE session_id = ? AND comment_id = ? AND landed_ns IS NULL
                    """,
                    (
                        take_index,
                        recording_ms,
                        pressed_wall_ms,
                        text,
                        session_id,
                        cid,
                    ),
                )
        return self.get(session_id, cid) or {}

    def get(self, session_id: str, comment_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT session_id, comment_id, take_index, recording_ms,
                       pressed_wall_ms, author, body, created_ns, landed_ns
                FROM record_live_comments
                WHERE session_id = ? AND comment_id = ?
                """,
                (session_id, comment_id),
            ).fetchone()
        return dict(row) if row is not None else None

    def list_unlanded(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT session_id, comment_id, take_index, recording_ms,
                       pressed_wall_ms, author, body, created_ns, landed_ns
                FROM record_live_comments
                WHERE session_id = ? AND landed_ns IS NULL
                ORDER BY recording_ms, created_ns
                """,
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def ids_for_take(self, session_id: str, take_index: int) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT comment_id FROM record_live_comments
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            ).fetchall()
        return [str(row["comment_id"]) for row in rows]

    def mark_landed(self, session_id: str, comment_ids: list[str]) -> None:
        if not comment_ids:
            return
        now_ns = time.time_ns()
        with self._lock:
            self._conn.executemany(
                """
                UPDATE record_live_comments SET landed_ns = ?
                WHERE session_id = ? AND comment_id = ? AND landed_ns IS NULL
                """,
                [(now_ns, session_id, cid) for cid in comment_ids],
            )

    def delete_take(self, session_id: str, take_index: int) -> list[str]:
        ids = self.ids_for_take(session_id, take_index)
        if not ids:
            return []
        with self._lock:
            self._conn.execute(
                """
                DELETE FROM record_live_comments
                WHERE session_id = ? AND take_index = ?
                """,
                (session_id, take_index),
            )
        return ids
