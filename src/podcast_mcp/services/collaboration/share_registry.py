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
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, TypedDict, runtime_checkable

from coolname import generate_slug

from podcast_mcp import settings
from podcast_mcp.util import host_platform
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.registry_backup import _anchor_path, publish_registry_backup
from podcast_mcp.util.registry_cleanup import cleanup
from podcast_mcp.util.registry_privacy import registry_privacy
from podcast_mcp.util.sqlite_open import (
    close_sqlite_connection,
    open_sqlite,
    sqlite_connection_finalizer,
)
from podcast_mcp.util.sqlite_tx import (
    SQLITE_SIDECARS,
    immediate_transaction,
)

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
FINALIZE_LEASE = timedelta(seconds=60)
MAX_RESTORABLE_WINDOW = timedelta(seconds=30)


class PendingRevoke(TypedDict):
    token: str
    id: str | None
    kind: str
    group_id: str
    project_workspace: str
    snapshot: dict[str, Any]
    revoked_at: str
    restorable_until: str
    finalize_lease_until: str | None


class RestoreWindowClosedError(CodedValueError):
    """The undo window of a revoked link has ended (HTTP 410)."""

    code = "restore_window_closed"

    def __init__(
        self, message: str = "the undo window for this link has ended. The link stays off."
    ) -> None:
        super().__init__(message)


class ShareExpiredError(CodedValueError):
    """The link passed its own expiry, so it cannot come back (HTTP 410)."""

    code = "share_expired"


class RecordRoomConflictError(CodedValueError):
    """Another record room is live for the project, so this one stays ended (HTTP 409)."""

    code = "record_room_conflict"


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

CREATE TABLE IF NOT EXISTS pending_revokes (
  token TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  project_workspace TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  restorable_until TEXT NOT NULL,
  finalize_lease_until TEXT
);

CREATE INDEX IF NOT EXISTS pending_revokes_group ON pending_revokes (group_id);

CREATE TABLE IF NOT EXISTS recording_key_secret (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  secret BLOB NOT NULL
);
"""


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def lease_held(row: Mapping[str, Any] | sqlite3.Row, moment: datetime) -> bool:
    held = parse_iso(row["finalize_lease_until"])
    return held is not None and held > moment


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _resolve_registry_path(path: str | Path) -> Path:
    return _anchor_path(Path(path).expanduser())


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
    override = settings.value("PODCAST_SHARE_REGISTRY")
    if override:
        return _resolve_registry_path(override)
    return _resolve_registry_path(host_platform.data_roots().state / "share_registry.sqlite")


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

    def rebase_workspace(self, old: str, new: str) -> int: ...

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

    def begin_pending_revoke(
        self,
        tokens: Sequence[str],
        *,
        project_workspace: str,
        group_id: str,
        window: timedelta,
        now: datetime | None = None,
    ) -> list[PendingRevoke]: ...

    def restore_group(
        self,
        group_id: str,
        *,
        project_workspace: str | None = None,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]: ...

    def claim_due(
        self,
        *,
        now: datetime | None = None,
        lease: timedelta = FINALIZE_LEASE,
        project_workspace: str | None = None,
        group_id: str | None = None,
        force: bool = False,
    ) -> list[PendingRevoke]: ...

    def complete_finalize(self, tokens: Sequence[str]) -> None: ...

    def list_pending(self, project_workspace: str | None = None) -> list[PendingRevoke]: ...

    def finalize_unresolvable_pending(self) -> int: ...

    def demote_expired_unresolvable_active(self, *, now: datetime | None = None) -> int: ...

    def backup_to_new(self, dest: Path) -> Path: ...


def _apply_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(_SCHEMA)


def _decode_workspace(stored: str) -> str | None:
    """The absolute workspace a stored value names, or None when it names no usable folder.

    A relative value on a host whose paths never move, and an absolute value that is not under
    the current container, are both unusable: neither is resolved against the working directory
    or an older container.
    """
    path = host_platform.from_stored(stored)
    if path is None or not os.path.isabs(path):
        return None
    root = host_platform.container_root()
    if root is not None and not Path(path).is_relative_to(root):
        return None
    return path


class SqliteShareRegistry:
    """Sqlite active + cooldown pools for public share tokens.

    Callers pass and receive absolute resolved workspace paths. The table stores the form
    :func:`host_platform.to_stored` gives, so a row survives the app container moving. Every
    argument that names a workspace is encoded here, and a stored value is decoded only where a
    row leaves the registry: :meth:`get_active`, :meth:`list_active_for_workspace`,
    :meth:`restore_group`, :meth:`list_pending` and :meth:`claim_due`. A row whose value cannot
    be decoded is unresolvable: an active one is invisible to those readers and keeps its slug
    reserved until revoked or demoted by :meth:`demote_expired_unresolvable_active`, and a pending
    one is dropped by :meth:`finalize_unresolvable_pending`.
    """

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = (
            _anchor_path(db_path) if db_path is not None else default_share_registry_db_path()
        )
        self._lock = threading.RLock()
        self._conn = self._open_connection()
        self._connection_finalizer = sqlite_connection_finalizer(self, self._conn, lock=self._lock)
        self._connection_failed = False

    @contextlib.contextmanager
    def _private_files(self, *, create: bool = False) -> Iterator[Callable[[], None]]:
        names = tuple(self.db_path.name + suffix for suffix in ("", *SQLITE_SIDECARS))
        with registry_privacy(self.db_path.parent, names, create=create) as verify:
            yield verify

    def _open_connection(self) -> sqlite3.Connection:
        connection = None
        try:
            with self._private_files(create=True) as verify:
                connection = open_sqlite(
                    self.db_path, row_factory=sqlite3.Row, verify=verify, setup=_apply_schema
                )
            return connection
        except BaseException:
            if connection is not None:
                with contextlib.suppress(BaseException):
                    connection.close()
            raise

    def close(self) -> None:
        with self._lock:
            close_sqlite_connection(self._conn, self._connection_finalizer)

    @contextlib.contextmanager
    def _ready_connection(self) -> Iterator[None]:
        with self._lock:
            if self._connection_failed:
                connection = self._open_connection()
                cleanup = sqlite_connection_finalizer(self, connection, lock=self._lock)
                self._conn = connection
                self._connection_finalizer = cleanup
                self._connection_failed = False
            with self._private_files():
                yield

    @contextlib.contextmanager
    def _write_transaction(self) -> Iterator[None]:
        try:
            with immediate_transaction(self._conn):
                yield
        except BaseException:
            self._connection_failed = True
            with contextlib.suppress(BaseException):
                close_sqlite_connection(self._conn, self._connection_finalizer)
            raise

    def recording_key_secret(self) -> bytes:
        """Return the host-local key secret, initializing the singleton atomically."""
        with self._ready_connection():
            row = self._conn.execute(
                "SELECT secret FROM recording_key_secret WHERE singleton = 1"
            ).fetchone()
            if row is not None:
                return _recording_secret(row)
            with self._write_transaction():
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
        until = parse_iso(row["reserved_until"])
        return until is not None and until > now

    def purge_expired_cooldown(self, *, now: datetime | None = None) -> int:
        """Drop cooldown rows whose reserved_until has passed. Returns count."""
        moment = now or utc_now()
        with self._ready_connection(), self._write_transaction():
            return self._purge_expired_cooldown_unlocked(moment)

    def is_reserved(self, token: str, *, now: datetime | None = None) -> bool:
        """True if token is active or still in cooldown."""
        moment = now or utc_now()
        with self._ready_connection(), self._write_transaction():
            self._purge_expired_cooldown_unlocked(moment)
            return self._is_reserved_unlocked(token, moment)

    def get_active(self, token: str) -> dict[str, Any] | None:
        with self._ready_connection():
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            workspace = None if row is None else _decode_workspace(row["project_workspace"])
            return None if workspace is None else self._active_row_to_dict(row, workspace)

    def list_active_for_workspace(self, project_workspace: str) -> list[dict[str, Any]]:
        """Active rows minted for one episode workspace (the host's share list)."""
        with self._ready_connection():
            rows = self._conn.execute(
                "SELECT * FROM active_shares WHERE project_workspace = ?",
                (host_platform.to_stored(project_workspace),),
            ).fetchall()
            return [
                self._active_row_to_dict(row, workspace)
                for row in rows
                if (workspace := _decode_workspace(row["project_workspace"])) is not None
            ]

    def claim_active(self, share: dict[str, Any]) -> None:
        """Insert an active share with its ``id``. Raises ``ValueError`` if token is reserved."""
        token = str(share["token"])
        now = utc_now()
        created = str(share.get("created_at") or _iso(now))
        last_used = str(share.get("last_used_at") or created)
        caps = share.get("capabilities") or []
        kind = str(share.get("kind") or SHARE_KIND_REVIEW)
        if kind not in SHARE_KINDS:
            raise CodedValueError(
                f"unknown share kind {kind!r}. Use a supported share kind.",
                code="share_kind_invalid",
            )
        role = share.get("role")
        session_id = share.get("session_id")
        with self._ready_connection(), self._write_transaction():
            self._purge_expired_cooldown_unlocked(now)
            if self._is_reserved_unlocked(token, now):
                raise CodedValueError(
                    "share token already reserved. Mint a new share token.",
                    code="share_token_reserved",
                )
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
                        host_platform.to_stored(str(share["project_workspace"])),
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
                raise CodedValueError(
                    "share token already reserved. Mint a new share token.",
                    code="share_token_reserved",
                ) from exc

    def rebase_workspace(self, old: str, new: str) -> int:
        """Point every active and cooldown row of workspace ``old`` at ``new`` (a moved folder).

        Both tables change in one transaction, so a guest link never resolves to a folder that
        is gone while its cooldown row names the new one. Returns the rows changed.
        """
        old_stored, new_stored = host_platform.to_stored(old), host_platform.to_stored(new)
        with self._ready_connection(), self._write_transaction():
            active = self._conn.execute(
                "UPDATE active_shares SET project_workspace = ? WHERE project_workspace = ?",
                (new_stored, old_stored),
            )
            cooldown = self._conn.execute(
                "UPDATE cooldown_shares SET project_workspace = ? WHERE project_workspace = ?",
                (new_stored, old_stored),
            )
            pending = self._conn.execute(
                "UPDATE pending_revokes SET project_workspace = ? WHERE project_workspace = ?",
                (new_stored, old_stored),
            )
            return (
                int(active.rowcount or 0) + int(cooldown.rowcount or 0) + int(pending.rowcount or 0)
            )

    def release_claim(self, token: str) -> bool:
        """Drop an active claim without cooldown (create rollback)."""
        with self._ready_connection(), self._write_transaction():
            cur = self._conn.execute("DELETE FROM active_shares WHERE token = ?", (token,))
            return int(cur.rowcount or 0) > 0

    def upsert_active_metadata(self, row: dict[str, Any]) -> None:
        """Overwrite the active row's fields from ``row`` (no-op if the token is not active)."""
        token = str(row.get("token") or "")
        if not token:
            return
        caps = row.get("capabilities") or []
        kind = str(row.get("kind") or SHARE_KIND_REVIEW)
        if kind not in SHARE_KINDS:
            raise CodedValueError(
                f"unknown share kind {kind!r}. Use a supported share kind.",
                code="share_kind_invalid",
            )
        role = row.get("role")
        session_id = row.get("session_id")
        with self._ready_connection(), self._write_transaction():
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
                    host_platform.to_stored(str(row["project_workspace"])),
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
        moment = now or utc_now()
        with self._ready_connection(), self._write_transaction():
            row = self._conn.execute(
                "SELECT last_used_at FROM active_shares WHERE token = ?",
                (token,),
            ).fetchone()
            if row is None:
                return None
            prev = parse_iso(row["last_used_at"])
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
        moment = now or utc_now()
        with self._ready_connection(), self._write_transaction():
            row = self._conn.execute(
                "SELECT * FROM active_shares WHERE token = ?", (token,)
            ).fetchone()
            if row is None:
                return False
            self._reserve_revoked(row, reason, moment, cooldown_days)
            return True

    def begin_pending_revoke(
        self,
        tokens: Sequence[str],
        *,
        project_workspace: str,
        group_id: str,
        window: timedelta,
        now: datetime | None = None,
    ) -> list[PendingRevoke]:
        """Kill active links of one workspace at once but keep a snapshot so they can return.

        One transaction: each active row is snapshotted into ``pending_revokes``, deleted, and
        replaced by the usual ``revoked`` cooldown row, so the token stays reserved. The group
        shares one ``restorable_until``: ``now + window`` capped at the earliest ``expires_at``.
        Tokens that are not active in that workspace are skipped.
        """
        with self._ready_connection(), self._write_transaction():
            moment = now or utc_now()
            stored = host_platform.to_stored(project_workspace)
            found = [
                row
                for row in (self._active_row(token, stored) for token in tokens)
                if row is not None
            ]
            if not found:
                return []
            until = min(
                [
                    moment + window,
                    *(e for r in found if (e := parse_iso(r["expires_at"])) is not None),
                ]
            )
            for row in found:
                self._reserve_revoked(row, "revoked", moment, SHARE_COOLDOWN_DAYS)
            return [
                self._park_active_row(row, project_workspace, group_id, moment, until)
                for row in found
            ]

    def restore_group(
        self,
        group_id: str,
        *,
        project_workspace: str | None = None,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """Put every token of a pending group back, or raise; ``[]`` when nothing is pending.

        Compare-and-set in one transaction: the pending rows are deleted only while the window
        is open and no finalize holds a lease, so a concurrent finalize and restore cannot both
        win. The snapshot returns with its original token and id.
        """
        with self._ready_connection(), self._write_transaction():
            moment = now or utc_now()
            rows = [
                (row, workspace)
                for row in self._pending_rows(project_workspace, group_id)
                if (workspace := _decode_workspace(row["project_workspace"])) is not None
            ]
            if not rows:
                return []
            self._require_restorable([row for row, _ in rows], moment)
            self._require_no_live_room([row for row, _ in rows], moment)
            for row, _ in rows:
                self._reinstate(row)
            return [
                {**json.loads(row["snapshot_json"]), "project_workspace": workspace}
                for row, workspace in rows
            ]

    def claim_due(
        self,
        *,
        now: datetime | None = None,
        lease: timedelta = FINALIZE_LEASE,
        project_workspace: str | None = None,
        group_id: str | None = None,
        force: bool = False,
    ) -> list[PendingRevoke]:
        """Lease the pending rows whose window ended (or any of ``group_id`` when ``force``).

        A row whose lease is still running is skipped; one whose lease lapsed is claimed again,
        so a finalize that crashed is retried (effects are at-least-once).
        """
        with self._ready_connection(), self._write_transaction():
            moment = now or utc_now()
            claimed = []
            for row in self._pending_rows(project_workspace, group_id):
                workspace = _decode_workspace(row["project_workspace"])
                if workspace is None:
                    continue
                if (not force and not self._window_ended(row, moment)) or lease_held(row, moment):
                    continue
                leased_until = _iso(moment + lease)
                self._conn.execute(
                    "UPDATE pending_revokes SET finalize_lease_until = ? WHERE token = ?",
                    (leased_until, row["token"]),
                )
                claimed.append(
                    self._pending_view(
                        {**dict(row), "finalize_lease_until": leased_until}, workspace
                    )
                )
            return claimed

    def complete_finalize(self, tokens: Sequence[str]) -> None:
        """Drop leased pending rows after their effects ran."""
        with self._ready_connection(), self._write_transaction():
            self._conn.executemany(
                "DELETE FROM pending_revokes WHERE token = ? AND finalize_lease_until IS NOT NULL",
                [(token,) for token in tokens],
            )

    def list_pending(self, project_workspace: str | None = None) -> list[PendingRevoke]:
        with self._ready_connection():
            return [
                self._pending_view(dict(row), workspace)
                for row in self._pending_rows(project_workspace, None)
                if (workspace := _decode_workspace(row["project_workspace"])) is not None
            ]

    def finalize_unresolvable_pending(self) -> int:
        """Drop pending rows whose workspace cannot be decoded; their slugs stay in cooldown.

        Such a row cannot be restored to a folder that does not exist, and its effects (media,
        room end) have no workspace to run in, so the sweep finishes it here. Returns the count.
        """
        with self._ready_connection(), self._write_transaction():
            dead = [
                row["token"]
                for row in self._pending_rows(None, None)
                if _decode_workspace(row["project_workspace"]) is None
            ]
            self._conn.executemany(
                "DELETE FROM pending_revokes WHERE token = ?", [(token,) for token in dead]
            )
            return len(dead)

    def demote_expired_unresolvable_active(self, *, now: datetime | None = None) -> int:
        """Demote active rows past their expiry whose workspace cannot be decoded.

        Only a lookup demotes an expired link, and an unresolvable row is invisible to lookups,
        so the sweep does it here. The slug then follows the normal cooldown. Returns the count.
        """
        moment = now or utc_now()
        with self._ready_connection(), self._write_transaction():
            dead = [
                row
                for row in self._conn.execute("SELECT * FROM active_shares").fetchall()
                if _decode_workspace(row["project_workspace"]) is None
                and share_hard_expired(dict(row), now=moment)
            ]
            for row in dead:
                self._reserve_revoked(row, "expired", moment, SHARE_COOLDOWN_DAYS)
            return len(dead)

    def _active_row(self, token: str, project_workspace: str) -> sqlite3.Row | None:
        found: sqlite3.Row | None = self._conn.execute(
            "SELECT * FROM active_shares WHERE token = ? AND project_workspace = ?",
            (token, project_workspace),
        ).fetchone()
        return found

    def _pending_rows(self, workspace: str | None, group_id: str | None) -> list[sqlite3.Row]:
        workspace = None if workspace is None else host_platform.to_stored(workspace)
        return list(
            self._conn.execute(
                "SELECT * FROM pending_revokes"
                " WHERE (?1 IS NULL OR project_workspace = ?1)"
                " AND (?2 IS NULL OR group_id = ?2) ORDER BY token",
                (workspace, group_id),
            ).fetchall()
        )

    def _reserve_revoked(
        self, row: sqlite3.Row, reason: str, moment: datetime, cooldown_days: int
    ) -> None:
        token = row["token"]
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
                _iso(parse_iso(row["last_used_at"]) or moment),
                _iso(moment + timedelta(days=cooldown_days)),
                reason,
                row["project_workspace"],
            ),
        )

    def _park_active_row(
        self,
        row: sqlite3.Row,
        workspace: str,
        group_id: str,
        moment: datetime,
        until: datetime,
    ) -> PendingRevoke:
        snapshot = {
            k: v
            for k, v in self._active_row_to_dict(row, workspace).items()
            if k != "project_workspace"
        }
        parked = {
            "token": row["token"],
            "group_id": group_id,
            "project_workspace": row["project_workspace"],
            "snapshot_json": json.dumps(snapshot),
            "revoked_at": _iso(moment),
            "restorable_until": _iso(until),
            "finalize_lease_until": None,
        }
        self._conn.execute(
            """
            INSERT INTO pending_revokes (
              token, group_id, project_workspace, snapshot_json, revoked_at, restorable_until
            ) VALUES (:token, :group_id, :project_workspace, :snapshot_json,
                      :revoked_at, :restorable_until)
            """,
            parked,
        )
        return self._pending_view(parked, workspace)

    @staticmethod
    def _window_ended(row: sqlite3.Row, moment: datetime) -> bool:
        until = parse_iso(row["restorable_until"])
        return until is None or until <= moment

    def _require_restorable(self, rows: Sequence[sqlite3.Row], moment: datetime) -> None:
        for row in rows:
            if lease_held(row, moment):
                raise RestoreWindowClosedError()
            if not self._window_ended(row, moment):
                continue
            expires = parse_iso(json.loads(row["snapshot_json"]).get("expires_at"))
            if expires is not None and expires <= moment:
                raise ShareExpiredError("this link has expired, so it cannot be restored.")
            raise RestoreWindowClosedError()

    def _require_no_live_room(self, rows: Sequence[sqlite3.Row], moment: datetime) -> None:
        snaps = [json.loads(row["snapshot_json"]) for row in rows]
        if not any(snap.get("kind") == SHARE_KIND_RECORD for snap in snaps):
            return
        others = self._conn.execute(
            "SELECT expires_at FROM active_shares WHERE project_workspace = ? AND kind = ?",
            (rows[0]["project_workspace"], SHARE_KIND_RECORD),
        ).fetchall()
        for other in others:
            expires = parse_iso(other["expires_at"])
            if expires is None or expires > moment:
                raise RecordRoomConflictError(
                    "another record room is live for this episode, so the ended room stays ended."
                )

    def _reinstate(self, row: sqlite3.Row) -> None:
        snap = json.loads(row["snapshot_json"])
        token = row["token"]
        self._conn.execute("DELETE FROM pending_revokes WHERE token = ?", (token,))
        self._conn.execute("DELETE FROM cooldown_shares WHERE token = ?", (token,))
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
                    snap.get("id"),
                    row["project_workspace"],
                    snap["review_version_id"],
                    snap["created_at"],
                    snap["last_used_at"],
                    snap.get("expires_at"),
                    json.dumps(snap.get("capabilities") or []),
                    snap.get("kind") or SHARE_KIND_REVIEW,
                    snap.get("role"),
                    snap.get("session_id"),
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise RestoreWindowClosedError() from exc

    @staticmethod
    def _pending_view(row: Mapping[str, Any], workspace: str) -> PendingRevoke:
        snap = json.loads(row["snapshot_json"])
        return {
            "token": row["token"],
            "id": snap.get("id"),
            "kind": snap.get("kind") or SHARE_KIND_REVIEW,
            "group_id": row["group_id"],
            "project_workspace": workspace,
            "snapshot": {**snap, "project_workspace": workspace},
            "revoked_at": row["revoked_at"],
            "restorable_until": row["restorable_until"],
            "finalize_lease_until": row["finalize_lease_until"],
        }

    def backup_to_new(self, dest: Path) -> Path:
        """Publish a standalone SQLite backup at a new name in a trusted private directory."""
        with self._ready_connection():
            return publish_registry_backup(self.db_path, Path(dest), self._snapshot)

    def _snapshot(self, path: Path) -> None:
        connection = sqlite3.connect(str(path), isolation_level=None)
        try:
            self._conn.backup(connection)
            mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            if str(mode).lower() != "delete":
                raise OSError("registry snapshot cannot be made standalone")
        finally:
            cleanup([connection.close])

    @staticmethod
    def _active_row_to_dict(row: sqlite3.Row, workspace: str) -> dict[str, Any]:
        caps_raw = row["capabilities"]
        try:
            caps = json.loads(caps_raw)
        except (TypeError, json.JSONDecodeError):
            caps = []
        return {
            "token": row["token"],
            "id": row["id"],
            "project_workspace": workspace,
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

    *db_path* is used verbatim (no suffix rewrite). When its anchored spelling matches
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
            current = _registry_singleton
            candidate = SqliteShareRegistry(path)
            try:
                if current is not None:
                    current.close()
                _registry_singleton = candidate
            except BaseException:
                _registry_singleton = current
                cleanup([candidate.close])
                raise
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
    """Backup the host registry to *dest* (default: sibling timestamp and random suffix)."""
    reg = registry or get_share_registry()
    if dest is None:
        stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
        dest = reg.db_path.with_name(
            f"{reg.db_path.stem}.{stamp}.{secrets.token_hex(8)}.bak.sqlite"
        )
    return reg.backup_to_new(Path(dest))


def share_hard_expired(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    exp = parse_iso(str(row.get("expires_at") or "") if row.get("expires_at") else None)
    if exp is None:
        return False
    return (now or utc_now()) >= exp


def share_is_usable(row: dict[str, Any], *, now: datetime | None = None) -> bool:
    """A link works until the host revokes it or its host-chosen ``expires_at`` passes."""
    return not row.get("revoked") and not share_hard_expired(row, now=now)
