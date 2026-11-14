"""Host-minted record participant ids, bound to the share they joined through."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections.abc import Collection, Mapping
from pathlib import Path

from podcast_mcp.services.session_sync import connect_session_db
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.sqlite_open import close_sqlite_connection, sqlite_connection_finalizer

LEASE_TTL_NS = 7 * 24 * 60 * 60 * 1_000_000_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS record_participant_leases (
  participant_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  lease_hash TEXT NOT NULL,
  lease_expires_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS record_track_choices (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  PRIMARY KEY (session_id, participant_id)
);
"""


def hash_lease(lease: str) -> str:
    return hashlib.sha256(lease.encode("utf-8")).hexdigest()


class RecordParticipantStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = connect_session_db(db_path, schema=_SCHEMA)
        self._connection_finalizer = sqlite_connection_finalizer(self, self._conn, lock=self._lock)

    def close(self) -> None:
        with self._lock:
            close_sqlite_connection(self._conn, self._connection_finalizer)

    def mint(self, *, session_id: str, share_id: str) -> tuple[str, str]:
        """A new participant id and its lease, bound to the share (link) it joined through."""
        if not share_id:
            raise CodedValueError(
                "a participant needs the share it joined through", code="record_share_required"
            )
        participant_id = "p_" + secrets.token_hex(4)
        lease = secrets.token_urlsafe(24)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO record_participant_leases (
                  participant_id, session_id, share_id, lease_hash, lease_expires_ns
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    participant_id,
                    session_id,
                    share_id,
                    hash_lease(lease),
                    time.time_ns() + LEASE_TTL_NS,
                ),
            )
        return participant_id, lease

    def verify(
        self,
        participant_id: str,
        lease: str,
        *,
        share_id: str,
        session_id: str,
    ) -> bool:
        """True when the lease is live, in this room, and was minted through this share."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT session_id, share_id, lease_hash, lease_expires_ns
                FROM record_participant_leases
                WHERE participant_id = ?
                """,
                (participant_id,),
            ).fetchone()
        if row is None:
            return False
        if str(row["session_id"]) != session_id:
            return False
        if int(row["lease_expires_ns"]) < time.time_ns():
            return False
        share_ok = bool(share_id) and hmac.compare_digest(str(row["share_id"]), share_id)
        lease_ok = hmac.compare_digest(str(row["lease_hash"]), hash_lease(lease))
        return share_ok and lease_ok

    def revoke(self, participant_id: str, *, session_id: str) -> None:
        """Expire one participant's lease without changing the room roster."""
        with self._lock:
            self._conn.execute(
                """UPDATE record_participant_leases SET lease_expires_ns = 0
                WHERE participant_id = ? AND session_id = ?""",
                (participant_id, session_id),
            )

    def clear_except(self, session_id: str) -> None:
        """Forget every room's participants and track choices except ``session_id``'s."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM record_participant_leases WHERE session_id != ?", (session_id,)
            )
            self._conn.execute(
                "DELETE FROM record_track_choices WHERE session_id != ?", (session_id,)
            )

    def set_track_choice(self, session_id: str, participant_id: str, track_id: str) -> None:
        """Remember the host's choice of track for one participant (host-only; never sent to guests)."""
        with self._lock:
            self._conn.execute(
                """INSERT INTO record_track_choices (session_id, participant_id, track_id)
                VALUES (?, ?, ?)
                ON CONFLICT (session_id, participant_id) DO UPDATE SET track_id = excluded.track_id""",
                (session_id, participant_id, track_id),
            )

    def track_choices(self, session_id: str) -> dict[str, str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT participant_id, track_id FROM record_track_choices WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        return {str(row["participant_id"]): str(row["track_id"]) for row in rows}

    def invites_of(self, participant_ids: Collection[str], *, session_id: str) -> Mapping[str, str]:
        """The share id each of ``participant_ids`` joined through (unbound ids are absent)."""
        wanted = set(participant_ids)
        if not wanted:
            return {}
        with self._lock:
            rows = self._conn.execute(
                "SELECT participant_id, share_id FROM record_participant_leases WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        return {
            str(row["participant_id"]): str(row["share_id"])
            for row in rows
            if str(row["participant_id"]) in wanted
        }
