"""Host-minted record participant ids and hashed leases."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from pathlib import Path

from podcast_mcp.services.session_sync.sqlite import connect_session_db

LEASE_TTL_NS = 7 * 24 * 60 * 60 * 1_000_000_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS record_participants (
  participant_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lease_hash TEXT NOT NULL,
  lease_expires_ns INTEGER NOT NULL,
  created_ns INTEGER NOT NULL,
  last_seen_ns INTEGER NOT NULL
);
"""


def hash_lease(lease: str) -> str:
    return hashlib.sha256(lease.encode("utf-8")).hexdigest()


class RecordParticipantStore:
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

    def mint(
        self,
        *,
        session_id: str,
        token: str,
        role: str,
        display_name: str,
    ) -> tuple[str, str]:
        participant_id = "p_" + secrets.token_hex(4)
        lease = secrets.token_urlsafe(24)
        now = time.time_ns()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO record_participants (
                  participant_id, session_id, token_hash, role, display_name,
                  lease_hash, lease_expires_ns, created_ns, last_seen_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    participant_id,
                    session_id,
                    hash_lease(token),
                    role,
                    display_name,
                    hash_lease(lease),
                    now + LEASE_TTL_NS,
                    now,
                    now,
                ),
            )
        return participant_id, lease

    def verify(
        self,
        participant_id: str,
        lease: str,
        *,
        token: str,
        session_id: str,
    ) -> bool:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT session_id, token_hash, lease_hash, lease_expires_ns
                FROM record_participants
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
        token_ok = hmac.compare_digest(str(row["token_hash"]), hash_lease(token))
        lease_ok = hmac.compare_digest(str(row["lease_hash"]), hash_lease(lease))
        return token_ok and lease_ok

    def touch(self, participant_id: str) -> None:
        now = time.time_ns()
        with self._lock:
            self._conn.execute(
                "UPDATE record_participants SET last_seen_ns = ? WHERE participant_id = ?",
                (now, participant_id),
            )

    def revoke(self, participant_id: str, *, session_id: str) -> None:
        """Expire one participant's lease without changing the room roster."""
        with self._lock:
            self._conn.execute(
                """UPDATE record_participants SET lease_expires_ns = 0
                WHERE participant_id = ? AND session_id = ?""",
                (participant_id, session_id),
            )

    def clear_all(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM record_participants")

    def for_session(self, session_id: str) -> list[dict[str, str]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT participant_id, session_id, role, display_name
                FROM record_participants
                WHERE session_id = ?
                ORDER BY created_ns
                """,
                (session_id,),
            ).fetchall()
        return [
            {
                "participant_id": str(row["participant_id"]),
                "session_id": str(row["session_id"]),
                "role": str(row["role"]),
                "display_name": str(row["display_name"]),
            }
            for row in rows
        ]

    def participant_ids_for_token(self, *, token: str, session_id: str) -> set[str]:
        """Participant ids minted through ``token`` in ``session_id`` (revoked ones included)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT participant_id FROM record_participants WHERE session_id = ? AND token_hash = ?",
                (session_id, hash_lease(token)),
            ).fetchall()
        return {str(row["participant_id"]) for row in rows}
