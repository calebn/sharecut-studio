"""Host-local sqlite registry for unique public share tokens.

``share_token`` values are **globally unique** while present in either the
**active** or **cooldown** pool. Multi-host deployments must eventually claim
tokens via the relay; until then this per-host DB is the UNIQUE authority.

Call sites depend on :class:`ShareRegistryProtocol` so a future relay/HTTP
backend can plug in without rewriting ``ShareService``.

See docs/share-tokens.md and docs/persistence.md.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from coolname import generate_slug

from podcast_mcp.util.sqlite_tx import immediate_transaction

# Invariant for agents / scale: public /r/{token} and /rec/{token} IDs must not
# collide across hosts once a relay-owned registry exists. This flag documents
# the contract.
SHARE_TOKEN_IS_GLOBALLY_UNIQUE = True

SHARE_KIND_REVIEW = "review"
SHARE_KIND_RECORD = "record"
SHARE_KINDS = frozenset({SHARE_KIND_REVIEW, SHARE_KIND_RECORD})
RECORD_REVIEW_VERSION_SENTINEL = ""

SHARE_COOLDOWN_DAYS = 365
LAST_USED_TOUCH_MIN_INTERVAL = timedelta(hours=1)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_shares (
  token TEXT PRIMARY KEY,
  project_workspace TEXT NOT NULL,
  review_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT,
  capabilities TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'review',
  role TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS cooldown_shares (
  token TEXT PRIMARY KEY,
  last_used_at TEXT NOT NULL,
  reserved_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  project_workspace TEXT
);
"""

_ACTIVE_SHARE_COLUMN_MIGRATIONS: dict[str, str] = {
    "kind": "TEXT NOT NULL DEFAULT 'review'",
    "role": "TEXT",
    "session_id": "TEXT",
}


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, ddl in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def _now() -> datetime:
    return datetime.now(UTC)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _resolve_registry_path(path: str | Path) -> Path:
    """Normalize a registry path. The path is used verbatim (no suffix rewrite)."""
    return Path(path).expanduser().resolve()


def default_share_registry_db_path() -> Path:
    """Path to the host share registry sqlite DB.

    Prefer pinning with ``PODCAST_SHARE_REGISTRY``; the override is used
    verbatim (whatever its suffix) so every caller opens the same file.
    """
    override = os.environ.get("PODCAST_SHARE_REGISTRY", "").strip()
    if override:
        return _resolve_registry_path(override)
    return _resolve_registry_path(Path.home() / ".podcast_mcp" / "share_registry.sqlite")


@runtime_checkable
class ShareRegistryProtocol(Protocol):
    """Portable UNIQUE(token) + cooldown API (host sqlite today; relay later)."""

    @property
    def db_path(self) -> Path: ...

    def close(self) -> None: ...

    def purge_expired_cooldown(self, *, now: datetime | None = None) -> int: ...

    def is_reserved(self, token: str, *, now: datetime | None = None) -> bool: ...

    def get_active(self, token: str) -> dict[str, Any] | None: ...

    def claim_active(self, share: dict[str, Any]) -> None: ...

    def release_claim(self, token: str) -> bool: ...

    def upsert_active_metadata(self, row: dict[str, Any]) -> None: ...

    def touch_last_used(
        self,
        token: str,
        *,
        now: datetime | None = None,
        min_interval: timedelta = LAST_USED_TOUCH_MIN_INTERVAL,
    ) -> str | None: ...

    def demote_to_cooldown(
        self,
        token: str,
        *,
        reason: str,
        now: datetime | None = None,
        cooldown_days: int = SHARE_COOLDOWN_DAYS,
    ) -> bool: ...

    def backup_to(self, dest: Path) -> Path: ...


class SqliteShareRegistry:
    """Sqlite active + cooldown pools for public share tokens."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path else default_share_registry_db_path()
        self._lock = threading.RLock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self.db_path.parent, 0o700)
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._conn.executescript(_SCHEMA)
            _ensure_columns(self._conn, "active_shares", _ACTIVE_SHARE_COLUMN_MIGRATIONS)
        with contextlib.suppress(OSError):
            os.chmod(self.db_path, 0o600)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _purge_expired_cooldown_unlocked(self, now: datetime) -> int:
        ts = _iso(now)
        cur = self._conn.execute(
            "DELETE FROM cooldown_shares WHERE reserved_until <= ?",
            (ts,),
        )
        return int(cur.rowcount or 0)

    def _is_reserved_unlocked(self, token: str, now: datetime) -> bool:
        if self._conn.execute("SELECT 1 FROM active_shares WHERE token = ?", (token,)).fetchone():
            return True
        row = self._conn.execute(
            "SELECT reserved_until FROM cooldown_shares WHERE token = ?",
            (token,),
        ).fetchone()
        if row is None:
            return False
        until = _parse_iso(row["reserved_until"])
        return until is not None and until > now

    def purge_expired_cooldown(self, *, now: datetime | None = None) -> int:
        """Drop cooldown rows whose reserved_until has passed. Returns count."""
        moment = now or _now()
        with self._lock, immediate_transaction(self._conn):
            return self._purge_expired_cooldown_unlocked(moment)

    def is_reserved(self, token: str, *, now: datetime | None = None) -> bool:
        """True if token is active or still in cooldown."""
        moment = now or _now()
        with self._lock, immediate_transaction(self._conn):
            self._purge_expired_cooldown_unlocked(moment)
            return self._is_reserved_unlocked(token, moment)

    def get_active(self, token: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            if row is None:
                return None
            return self._active_row_to_dict(row)

    def claim_active(self, share: dict[str, Any]) -> None:
        """Insert an active share. Raises ``ValueError`` if token is reserved."""
        token = str(share["token"])
        now = _now()
        created = str(share.get("created_at") or _iso(now))
        last_used = str(share.get("last_used_at") or created)
        caps = share.get("capabilities") or []
        kind = str(share.get("kind") or SHARE_KIND_REVIEW)
        if kind not in SHARE_KINDS:
            raise ValueError(f"unknown share kind {kind!r}")
        role = share.get("role")
        session_id = share.get("session_id")
        with self._lock, immediate_transaction(self._conn):
            self._purge_expired_cooldown_unlocked(now)
            if self._is_reserved_unlocked(token, now):
                raise ValueError(f"share token already reserved: {token}")
            try:
                self._conn.execute(
                    """
                    INSERT INTO active_shares (
                      token, project_workspace, review_version_id,
                      created_at, last_used_at, expires_at, capabilities,
                      kind, role, session_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        token,
                        str(share["project_workspace"]),
                        str(share["review_version_id"]),
                        created,
                        last_used,
                        share.get("expires_at"),
                        json.dumps(caps),
                        kind,
                        None if role is None else str(role),
                        None if session_id is None else str(session_id),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"share token already reserved: {token}") from exc

    def release_claim(self, token: str) -> bool:
        """Drop an active claim without cooldown (create rollback)."""
        with self._lock, immediate_transaction(self._conn):
            cur = self._conn.execute("DELETE FROM active_shares WHERE token = ?", (token,))
            return int(cur.rowcount or 0) > 0

    def upsert_active_metadata(self, row: dict[str, Any]) -> None:
        """Refresh active-row fields from the project sidecar (no-op if missing)."""
        token = str(row.get("token") or "")
        if not token:
            return
        caps = row.get("capabilities") or []
        kind = str(row.get("kind") or SHARE_KIND_REVIEW)
        if kind not in SHARE_KINDS:
            raise ValueError(f"unknown share kind {kind!r}")
        role = row.get("role")
        session_id = row.get("session_id")
        with self._lock:
            self._conn.execute(
                """
                UPDATE active_shares SET
                  project_workspace = ?,
                  review_version_id = ?,
                  expires_at = ?,
                  capabilities = ?,
                  last_used_at = COALESCE(?, last_used_at),
                  kind = ?,
                  role = ?,
                  session_id = ?
                WHERE token = ?
                """,
                (
                    str(row["project_workspace"]),
                    str(row["review_version_id"]),
                    row.get("expires_at"),
                    json.dumps(caps),
                    row.get("last_used_at"),
                    kind,
                    None if role is None else str(role),
                    None if session_id is None else str(session_id),
                    token,
                ),
            )

    def touch_last_used(
        self,
        token: str,
        *,
        now: datetime | None = None,
        min_interval: timedelta = LAST_USED_TOUCH_MIN_INTERVAL,
    ) -> str | None:
        """Update last_used_at if older than *min_interval*. Returns new ISO or None."""
        moment = now or _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT last_used_at FROM active_shares WHERE token = ?",
                (token,),
            ).fetchone()
            if row is None:
                return None
            prev = _parse_iso(row["last_used_at"])
            if prev is not None and moment - prev < min_interval:
                return None
            ts = _iso(moment)
            self._conn.execute(
                "UPDATE active_shares SET last_used_at = ? WHERE token = ?",
                (ts, token),
            )
            return ts

    def demote_to_cooldown(
        self,
        token: str,
        *,
        reason: str,
        now: datetime | None = None,
        cooldown_days: int = SHARE_COOLDOWN_DAYS,
    ) -> bool:
        """Move active → cooldown. Returns False if token was not active."""
        moment = now or _now()
        with self._lock, immediate_transaction(self._conn):
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            if row is None:
                return False
            last_used = _parse_iso(row["last_used_at"]) or moment
            reserved_until = last_used + timedelta(days=cooldown_days)
            self._conn.execute("DELETE FROM active_shares WHERE token = ?", (token,))
            self._conn.execute(
                """
                INSERT INTO cooldown_shares (
                  token, last_used_at, reserved_until, reason, project_workspace
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(token) DO UPDATE SET
                  last_used_at = excluded.last_used_at,
                  reserved_until = excluded.reserved_until,
                  reason = excluded.reason,
                  project_workspace = excluded.project_workspace
                """,
                (
                    token,
                    _iso(last_used),
                    _iso(reserved_until),
                    reason,
                    row["project_workspace"],
                ),
            )
            return True

    def backup_to(self, dest: Path) -> Path:
        """Copy the registry via sqlite online backup (WAL-safe). Returns dest."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            dest_conn = sqlite3.connect(str(dest))
            try:
                self._conn.backup(dest_conn)
            finally:
                dest_conn.close()
        with contextlib.suppress(OSError):
            os.chmod(dest, 0o600)
        return dest.resolve()

    @staticmethod
    def _active_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        caps_raw = row["capabilities"]
        try:
            caps = json.loads(caps_raw)
        except (TypeError, json.JSONDecodeError):
            caps = []
        return {
            "token": row["token"],
            "project_workspace": row["project_workspace"],
            "review_version_id": row["review_version_id"],
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "expires_at": row["expires_at"],
            "capabilities": caps if isinstance(caps, list) else [],
            "kind": row["kind"] or SHARE_KIND_REVIEW,
            "role": row["role"],
            "session_id": row["session_id"],
            "revoked": False,
        }


_registry_singleton: SqliteShareRegistry | None = None
_registry_lock = threading.Lock()


def reset_share_registry_for_tests() -> None:
    """Close the process singleton (tests that change env paths)."""
    global _registry_singleton
    with _registry_lock:
        if _registry_singleton is not None:
            _registry_singleton.close()
            _registry_singleton = None


def get_share_registry(db_path: Path | None = None) -> ShareRegistryProtocol:
    """Process-wide registry for the default path; ephemeral for any other *db_path*.

    *db_path* is used verbatim (no suffix rewrite). When it resolves to
    :func:`default_share_registry_db_path` the process singleton is returned so
    lookups do not open a second connection to the same file.
    """
    global _registry_singleton
    path = default_share_registry_db_path()
    if db_path is not None:
        requested = _resolve_registry_path(db_path)
        if requested != path:
            return SqliteShareRegistry(requested)
    with _registry_lock:
        if _registry_singleton is None or _registry_singleton.db_path != path:
            if _registry_singleton is not None:
                _registry_singleton.close()
            _registry_singleton = SqliteShareRegistry(path)
        return _registry_singleton


def claim_with_mint_retry(
    share_template: dict[str, Any],
    *,
    max_attempts: int = 32,
    registry: ShareRegistryProtocol | None = None,
) -> dict[str, Any]:
    """Assign a coolname token and claim it, retrying on reservation races."""
    reg = registry or get_share_registry()
    last_err: Exception | None = None
    for _ in range(max_attempts):
        row = dict(share_template)
        row["token"] = generate_slug(3)
        try:
            reg.claim_active(row)
            return row
        except ValueError as exc:
            last_err = exc
            continue
    raise RuntimeError("could not allocate unique share token") from last_err


def backup_share_registry(
    dest: Path | None = None,
    *,
    registry: ShareRegistryProtocol | None = None,
) -> Path:
    """Backup the host registry to *dest* (default: sibling ``.bak`` timestamp)."""
    reg = registry or get_share_registry()
    if dest is None:
        stamp = _now().strftime("%Y%m%dT%H%M%SZ")
        dest = reg.db_path.with_name(f"{reg.db_path.stem}.{stamp}.bak.sqlite")
    return reg.backup_to(Path(dest))


_NEVER_USED = datetime.min.replace(tzinfo=UTC)


def share_last_used_at(row: dict[str, Any]) -> datetime:
    """Effective last-used clock.

    Registry rows always carry ``last_used_at`` (NOT NULL column), but project
    sidecar rows are not schema-enforced: fall back to ``created_at``, and when
    neither parses fail closed (``datetime.min``) so the share reads inactive.
    """
    return (
        _parse_iso(str(row.get("last_used_at") or ""))
        or _parse_iso(str(row.get("created_at") or ""))
        or _NEVER_USED
    )


def share_hard_expired(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    exp = _parse_iso(str(row.get("expires_at") or "") if row.get("expires_at") else None)
    if exp is None:
        return False
    return (now or _now()) >= exp


def share_inactive(
    row: dict[str, Any],
    *,
    now: datetime | None = None,
    cooldown_days: int = SHARE_COOLDOWN_DAYS,
) -> bool:
    """True when the usable window has lapsed (last_used + cooldown_days)."""
    last = share_last_used_at(row)
    return (now or _now()) >= last + timedelta(days=cooldown_days)


def share_is_usable(
    row: dict[str, Any],
    *,
    now: datetime | None = None,
    cooldown_days: int = SHARE_COOLDOWN_DAYS,
) -> bool:
    if row.get("revoked"):
        return False
    if share_hard_expired(row, now=now):
        return False
    return not share_inactive(row, now=now, cooldown_days=cooldown_days)
