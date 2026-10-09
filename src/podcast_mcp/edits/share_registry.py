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
import secrets
import sqlite3
import tempfile
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from coolname import generate_slug

from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.sqlite_tx import DEFAULT_BUSY_TIMEOUT_PRAGMA, immediate_transaction
from podcast_mcp.util.sqlite_wal import ensure_wal

# Invariant for agents / scale: public /r/{token} and /rec/{token} IDs must not
# collide across hosts once a relay-owned registry exists. This flag documents
# the contract.
SHARE_TOKEN_IS_GLOBALLY_UNIQUE = True

SHARE_KIND_REVIEW = "review"
SHARE_KIND_RECORD = "record"
SHARE_KINDS = frozenset({SHARE_KIND_REVIEW, SHARE_KIND_RECORD})
RECORD_REVIEW_VERSION_SENTINEL = ""

# How long a slug stays reserved after its link ends (revoke or expiry).
SHARE_COOLDOWN_DAYS = 365
LAST_USED_TOUCH_MIN_INTERVAL = timedelta(hours=1)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_shares (
  token TEXT PRIMARY KEY,
  id TEXT,
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

CREATE TABLE IF NOT EXISTS recording_key_secret (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  secret BLOB NOT NULL
);
"""

_ACTIVE_SHARE_COLUMN_MIGRATIONS: dict[str, str] = {
    "id": "TEXT",
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


def _recording_secret(row: sqlite3.Row) -> bytes:
    secret = row["secret"]
    if not isinstance(secret, bytes) or len(secret) != 32:
        raise CodedValueError(
            "stored recording key secret is invalid",
            code="recording_key_secret_invalid",
        )
    return secret


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

    def recording_key_secret(self) -> bytes: ...

    def purge_expired_cooldown(self, *, now: datetime | None = None) -> int: ...

    def is_reserved(self, token: str, *, now: datetime | None = None) -> bool: ...

    def get_active(self, token: str) -> dict[str, Any] | None: ...

    def list_active_for_workspace(self, project_workspace: str) -> list[dict[str, Any]]: ...

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
        self._conn = self._open_connection()
        self._secret_connection_failed = False

    def _open_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,
            timeout=0,
        )
        try:
            connection.row_factory = sqlite3.Row
            with contextlib.suppress(OSError):
                os.chmod(self.db_path, 0o600)
            ensure_wal(connection, monotonic=time.monotonic, sleep=time.sleep)
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute(DEFAULT_BUSY_TIMEOUT_PRAGMA)
            connection.executescript(_SCHEMA)
            _ensure_columns(connection, "active_shares", _ACTIVE_SHARE_COLUMN_MIGRATIONS)
        except BaseException:
            with contextlib.suppress(BaseException):
                connection.close()
            raise
        return connection

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextlib.contextmanager
    def _ready_connection(self) -> Iterator[None]:
        with self._lock:
            if self._secret_connection_failed:
                self._conn = self._open_connection()
                self._secret_connection_failed = False
            yield

    def recording_key_secret(self) -> bytes:
        """Return the host-local key secret, initializing the singleton atomically."""
        with self._ready_connection():
            row = self._conn.execute(
                "SELECT secret FROM recording_key_secret WHERE singleton = 1"
            ).fetchone()
            if row is not None:
                return _recording_secret(row)
            try:
                with immediate_transaction(self._conn):
                    row = self._conn.execute(
                        "SELECT secret FROM recording_key_secret WHERE singleton = 1"
                    ).fetchone()
                    if row is None:
                        secret = secrets.token_bytes(32)
                        self._conn.execute(
                            "INSERT INTO recording_key_secret (singleton, secret) VALUES (1, ?)",
                            (secret,),
                        )
                    else:
                        secret = _recording_secret(row)
            except BaseException:
                # A failed rollback can leave an uncommitted secret on this connection.
                self._secret_connection_failed = True
                with contextlib.suppress(BaseException):
                    self._conn.close()
                raise
            return secret

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
        with self._ready_connection(), immediate_transaction(self._conn):
            return self._purge_expired_cooldown_unlocked(moment)

    def is_reserved(self, token: str, *, now: datetime | None = None) -> bool:
        """True if token is active or still in cooldown."""
        moment = now or _now()
        with self._ready_connection(), immediate_transaction(self._conn):
            self._purge_expired_cooldown_unlocked(moment)
            return self._is_reserved_unlocked(token, moment)

    def get_active(self, token: str) -> dict[str, Any] | None:
        with self._ready_connection():
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            if row is None:
                return None
            return self._active_row_to_dict(row)

    def list_active_for_workspace(self, project_workspace: str) -> list[dict[str, Any]]:
        """Active rows minted for one episode workspace (the host's share list)."""
        with self._ready_connection():
            rows = self._conn.execute(
                "SELECT * FROM active_shares WHERE project_workspace = ?",
                (project_workspace,),
            ).fetchall()
            return [self._active_row_to_dict(row) for row in rows]

    def claim_active(self, share: dict[str, Any]) -> None:
        """Insert an active share with its ``id``. Raises ``ValueError`` if token is reserved."""
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
        with self._ready_connection(), immediate_transaction(self._conn):
            self._purge_expired_cooldown_unlocked(now)
            if self._is_reserved_unlocked(token, now):
                raise ValueError(f"share token already reserved: {token}")
            try:
                self._conn.execute(
                    """
                    INSERT INTO active_shares (
                      token, id, project_workspace, review_version_id,
                      created_at, last_used_at, expires_at, capabilities,
                      kind, role, session_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        token,
                        str(share["id"]),
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
        with self._ready_connection(), immediate_transaction(self._conn):
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
        with self._ready_connection():
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
        with self._ready_connection():
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
        with self._ready_connection(), immediate_transaction(self._conn):
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            if row is None:
                return False
            last_used = _parse_iso(row["last_used_at"]) or moment
            reserved_until = moment + timedelta(days=cooldown_days)
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
        with self._ready_connection():
            fd, temporary_name = tempfile.mkstemp(prefix=f".{dest.name}.", dir=dest.parent)
            temporary = Path(temporary_name)
            try:
                os.close(fd)
                dest_conn = sqlite3.connect(str(temporary))
                try:
                    self._conn.backup(dest_conn)
                finally:
                    dest_conn.close()
                os.replace(temporary, dest)
            finally:
                temporary.unlink(missing_ok=True)
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
            "id": row["id"],
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
        with _registry_singleton._ready_connection():
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


def share_hard_expired(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    exp = _parse_iso(str(row.get("expires_at") or "") if row.get("expires_at") else None)
    if exp is None:
        return False
    return (now or _now()) >= exp


def share_is_usable(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    """A link works until the host revokes it or its host-chosen ``expires_at`` passes."""
    return not row.get("revoked") and not share_hard_expired(row, now=now)
