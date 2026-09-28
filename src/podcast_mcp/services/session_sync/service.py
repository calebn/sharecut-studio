"""Session sync authority - all clients submit typed commands here."""

from __future__ import annotations

import errno
import functools
import itertools
import json
import logging
import os
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.models import EpisodeProject, workspace_artifacts_dir
from podcast_mcp.project_io import resolve_project_path
from podcast_mcp.services.session_sync.commands import (
    GUEST_CLIENT_ID_PREFIX,
    SyncCommand,
    TransportRole,
    audition_mode_from_source,
    normalize_presence_meta,
    normalize_presence_playhead,
    sanitize_display_name,
    track_id_from_source,
)
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import (
    SyncStore,
    cached_sync_store,
    cached_sync_store_if_exists,
    cross_process_command,
)
from podcast_mcp.services.session_sync.presence_delta import (
    get_roster_tracker,
    presence_roster_event,
)
from podcast_mcp.services.session_sync.presence_fanout import schedule as schedule_presence
from podcast_mcp.services.session_sync.snapshot import (
    apply_command,
    attribution_fields,
    empty_snapshot,
    flatten_for_api,
    wire_snapshot,
)
from podcast_mcp.util.keyed_lock import KeyedLocks

_SEQ = itertools.count(1)

log = logging.getLogger(__name__)

SYNC_META_READ_ERRORS: tuple[type[Exception], ...] = (OSError, sqlite3.DatabaseError)
"""Errors the parse-free meta helpers treat as "store unavailable" (best-effort poll)."""

_T = TypeVar("_T")
_CORRUPT_META_WARNED: set[str] = set()
_CORRUPT_META_WARNED_LOCK = threading.Lock()

# Never evicted, deliberately: one small Lock per distinct workspace this process has
# submitted to. ``discard_idle`` is unsafe here: a CLI/MCP ``submit`` may hold a
# fetched but unacquired instance, and a fresh one would let the watcher read that row
# before its publish and let two submits publish out of server_seq order (#695).
_PUBLISH_LOCKS: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)


def _publish_lock(project_key: str) -> threading.Lock:
    """Held from a durable submit's journal append through its hub publish, and by
    ``publish_cross_process_head``. The watcher then never sees this process's row
    before its ``Applied`` is published, and never re-sends it (#695)."""
    return _PUBLISH_LOCKS.get(project_key)


def _symlink_loop_as_oserror(resolve: Callable[[], _T]) -> _T:
    """Run one ``Path.resolve()``-style call; its pre-3.13 symlink-loop ``RuntimeError`` becomes ``OSError(ELOOP)``.

    CPython 3.11/3.12 raise ``RuntimeError`` on a loop (``OSError(ELOOP)`` from 3.13).
    Wrap only the resolve, never a whole read, so unrelated ``RuntimeError``s still surface.
    """
    try:
        return resolve()
    except RuntimeError as exc:
        raise OSError(errno.ELOOP, str(exc)) from exc


def meta_workspace_dir(project_path: str | Path) -> Path:
    """Workspace dir for ``project_path`` (file or dir), for the parse-free meta reads.

    A symlink loop raises ``OSError(ELOOP)`` (see ``_symlink_loop_as_oserror``), which
    falls under ``SYNC_META_READ_ERRORS``.
    """
    return _symlink_loop_as_oserror(lambda: resolve_project_path(project_path)).parent


def resolve_meta_path(path: Path) -> Path:
    """``path.resolve()`` for the meta reads; a symlink loop raises ``OSError(ELOOP)``.

    Resolve a store path once, up front, and pass the result down. The store cache key,
    the sqlite URI and the WAL lock key then re-resolve a loop-free path, so a loop
    under ``artifacts/`` becomes a meta read error instead of an uncaught ``RuntimeError``.
    """
    return _symlink_loop_as_oserror(path.resolve)


def _is_corrupt_store_error(exc: BaseException) -> bool:
    """A sqlite error that means a bad file, not a transient lock or I/O hiccup."""
    return isinstance(exc, sqlite3.DatabaseError) and not isinstance(exc, sqlite3.OperationalError)


def _corrupt_warning_key(what: str, path: str | Path) -> str:
    # realpath is non-strict: it never raises on a symlink loop, it just stops resolving.
    return f"{what}|{os.path.realpath(path)}"


def _first_corrupt_warning(what: str, path: str | Path) -> bool:
    key = _corrupt_warning_key(what, path)
    with _CORRUPT_META_WARNED_LOCK:
        if key in _CORRUPT_META_WARNED:
            return False
        _CORRUPT_META_WARNED.add(key)
        return True


def _forget_corrupt_warning(what: str, path: str | Path) -> None:
    """Re-arm the warning after a good read, so a store that goes corrupt again warns again."""
    if not _CORRUPT_META_WARNED:  # fast path: nothing is currently warned
        return
    key = _corrupt_warning_key(what, path)
    with _CORRUPT_META_WARNED_LOCK:
        _CORRUPT_META_WARNED.discard(key)


def best_effort_meta(read: Callable[[], _T], default: _T, *, what: str, path: str | Path) -> _T:
    """Run a parse-free meta ``read``; on ``SYNC_META_READ_ERRORS`` return ``default``.

    The meta polls are best-effort, so a read error never fails the request. A
    transient error (``OSError``, ``sqlite3.OperationalError``: locked, disk I/O)
    logs at debug. A corrupt store (any other ``sqlite3.DatabaseError``, e.g. "file
    is not a database") logs one warning per ``what`` + resolved path, re-armed once
    a read of that path succeeds, so a broken sync.db / document.db shows up without
    a log line on every poll but warns again if it goes bad again after recovering.
    """
    try:
        result = read()
    except SYNC_META_READ_ERRORS as exc:
        if _is_corrupt_store_error(exc) and _first_corrupt_warning(what, path):
            log.warning(
                "%s unreadable for %s (corrupt sqlite store?); reporting it as missing",
                what,
                path,
                exc_info=True,
            )
        else:
            log.debug("%s unavailable for %s", what, path, exc_info=True)
        return default
    _forget_corrupt_warning(what, path)
    return result


def session_dir_for_workspace(workspace: Path) -> Path:
    return workspace_artifacts_dir(workspace) / "session"


def sync_db_path_for_workspace(workspace: Path) -> Path:
    return session_dir_for_workspace(workspace) / "sync.db"


def session_dir(project: EpisodeProject) -> Path:
    return session_dir_for_workspace(project.workspace_path())


def sync_db_path(project: EpisodeProject) -> Path:
    return sync_db_path_for_workspace(project.workspace_path())


def _open_store(path: Path) -> SyncStore:
    """Cached sync.db store at ``path``; creates the file."""
    return cached_sync_store(path, table_prefix="", enforce_command_ids=True)


def _existing_store_at(path: Path) -> SyncStore | None:
    """Cached sync.db store at ``path`` without creating it (meta reads)."""
    return cached_sync_store_if_exists(path, table_prefix="", enforce_command_ids=True)


def _store_for(project: EpisodeProject, *, create: bool = False) -> SyncStore | None:
    """Return the project store. Does not create sync.db until ``create``."""
    path = sync_db_path(project)
    return _open_store(path) if create else _existing_store_at(path)


def next_client_seq() -> int:
    return next(_SEQ)


def _is_guest(command: SyncCommand) -> bool:
    return command.client_id.startswith(GUEST_CLIENT_ID_PREFIX)


def _presence_label(command: SyncCommand) -> str | None:
    """Roster ``label`` under the ``meta.display_name`` rule (control chars, 40 max, guest suffix).

    ``None`` (blank or missing) keeps the stored label: ``touch_client`` COALESCEs it.
    """
    return sanitize_display_name(command.payload.get("label"), guest=_is_guest(command))


def _is_empty_authority(snap: dict[str, Any] | None) -> bool:
    """True when ``snap`` is missing or has never applied a command.

    Single home for the "empty authority" rule: a sync.db that exists (e.g. from
    a failed open) but has never applied a command is treated as missing, both
    for ``state_or_none`` and for the session meta endpoint.
    """
    if snap is None:
        return True
    return int(snap.get("server_seq") or 0) == 0 and snap.get("last_command_id") is None


def _snapshot_size(snap: dict[str, Any]) -> int:
    """Byte length of the serialized snapshot row: moves only on a durable commit."""
    return len(json.dumps(snap, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _missing_session_meta(path: str) -> dict[str, Any]:
    return {"path": path, "mtime_ns": 0, "size": 0, "exists": False, "server_seq": 0}


def _applied_session_snapshot(resolved: Path) -> dict[str, Any] | None:
    """Snapshot row of the sync.db at resolved path ``resolved``; ``None`` when missing or empty."""
    store = _existing_store_at(resolved)
    snap = store.get_snapshot() if store is not None else None
    return None if _is_empty_authority(snap) else snap


def _read_session_meta(db_path: Path) -> dict[str, Any]:
    resolved = resolve_meta_path(db_path)
    path = str(resolved)
    snap = _applied_session_snapshot(resolved)
    if snap is None:
        return _missing_session_meta(path)
    return {
        "path": path,
        "mtime_ns": int(snap.get("updated_at_ns") or 0),
        "size": _snapshot_size(snap),
        "exists": True,
        "server_seq": int(snap.get("server_seq") or 0),
    }


def session_server_seq_at(db_path: Path) -> int | None:
    """Committed sync.db ``server_seq`` at ``db_path``: 0 when missing or empty, ``None``
    when unreadable (unlike ``session_meta_at``, which reports an error as seq 0).

    Parse-free twin of ``document_server_seq_at`` for the cross-process watcher (#695).
    The caller must pass a path it has already authorized."""

    def _read() -> int:
        snap = _applied_session_snapshot(resolve_meta_path(db_path))
        return int(snap.get("server_seq") or 0) if snap is not None else 0

    return best_effort_meta(_read, None, what="session server_seq", path=db_path)


def session_meta_at(db_path: Path) -> dict[str, Any]:
    """Stat-and-one-row meta for the sync.db at ``db_path``. Never parses the project.

    Reports ``mtime_ns`` as the snapshot row's ``updated_at_ns`` rather than a
    WAL-aware file stat. The same WAL is also written by presence heartbeats and
    Acks (``touch_client``); a WAL-aware stat would change on every heartbeat and
    fire the poll (and so a state reload) on presence-only traffic. The snapshot's
    ``updated_at_ns`` changes only on a durable command commit
    (``append_and_apply`` / ``mutate_snapshot`` / ``reset``), which is what the
    poll should react to. ``size`` is the byte length of the serialized snapshot
    row (not the file size), for the same reason: a WAL checkpoint that lands
    presence-only writes grows the main file without a commit.

    Read errors go through ``best_effort_meta`` and report the missing meta.
    The caller must pass a path it has already authorized; this helper does no
    authz.
    """
    return best_effort_meta(
        lambda: _read_session_meta(db_path),
        _missing_session_meta(str(db_path)),
        what="session meta",
        path=db_path,
    )


def session_meta(project_path: str | Path) -> dict[str, Any]:
    """Session meta for the project at ``project_path``, without parsing it.

    The outer ``best_effort_meta`` covers project-path resolution; ``session_meta_at``
    covers the store read.

    The caller must pass a project path it has already authorized (the GUI route
    runs ``resolve_project`` + host auth first); this helper does no authz.
    """
    return best_effort_meta(
        lambda: session_meta_at(sync_db_path_for_workspace(meta_workspace_dir(project_path))),
        _missing_session_meta(str(project_path)),
        what="session meta",
        path=project_path,
    )


def _applied_event(
    row: dict[str, Any], api_snap: dict[str, Any], *, roster_version: int
) -> dict[str, Any]:
    """The full session ``Applied`` event: ``submit()``'s return value and the HTTP/MCP
    session responses (``author_client_id`` / ``roster_version`` added, full snapshot).

    ``roster_version`` is the presence roster counter (``PresenceRosterTracker.version``)
    when this command committed, the same counter ``Presence`` / ``PresenceDelta`` carry,
    never a separate durable-plane version. ``author_client_id`` equals
    ``command.client_id``: the author tag #567's multiplexed host socket will filter own
    echoes by. No client reads either from ``Applied`` / ``Echo`` yet."""
    return {
        "type": "Applied",
        "command": row,
        "snapshot": api_snap,
        "server_seq": row["server_seq"],
        "author_client_id": row["client_id"],
        "roster_version": roster_version,
    }


def wire_session_event(
    row: dict[str, Any], api_snap: dict[str, Any], *, roster_version: int
) -> dict[str, Any]:
    """Compact twin of ``_applied_event`` for the hub publish and the WS ``Echo``: the
    snapshot drops ``clients`` / ``fields`` (``snapshot.wire_snapshot``), so a durable
    session ``Applied`` stays a flat, fixed-size transport view. Roster fan-out is the
    separate per-client-delta path (``presence_delta.py``, ``_fanout_presence_after_commit``)."""
    event = _applied_event(row, api_snap, roster_version=roster_version)
    event["snapshot"] = wire_snapshot(api_snap)
    return event


class SessionSyncService:
    def __init__(self, project: EpisodeProject) -> None:
        self.project = project
        # Hub key: workspace root (stable across EpisodeProject reloads)
        self._project_key = str(project.workspace_path())

    @property
    def store(self) -> SyncStore:
        store = _store_for(self.project, create=True)
        assert store is not None
        return store

    def _store_optional(self) -> SyncStore | None:
        return _store_for(self.project, create=False)

    @classmethod
    def open(cls, project_path: str | Path) -> SessionSyncService:
        from podcast_mcp.services.workspace import ProjectWorkspace

        ws = ProjectWorkspace.open(project_path)
        return cls(ws.project)

    def _roster_version(self) -> int:
        return get_roster_tracker().version(self._project_key)

    def snapshot(self) -> dict[str, Any]:
        store = self._store_optional()
        if store is None:
            out = flatten_for_api(empty_snapshot(), [])
        else:
            snap = store.get_snapshot() or empty_snapshot()
            clients = store.list_clients()
            out = flatten_for_api(snap, clients)
        out["server_time_ns"] = time.time_ns()
        out["roster_version"] = self._roster_version()
        return out

    def state_or_none(self) -> dict[str, Any] | None:
        """Flattened snapshot, or ``None`` when sync.db is missing or empty.

        Single home for the "empty authority" rule: a DB that exists (e.g. from a
        failed open) but has never applied a command is treated as missing.
        """
        if self._store_optional() is None:
            return None
        snap = self.snapshot()
        if _is_empty_authority(snap):
            return None
        return snap

    def meta(self) -> dict[str, Any]:
        return session_meta_at(sync_db_path(self.project))

    def publish_cross_process_head(self, after: int | None = None) -> dict[str, Any] | None:
        """Fan out rows another process committed to sync.db (#695).

        The cross-process watcher calls this with ``after``, the head seq it saw on its last
        tick (``None`` checks the head alone). Under ``_publish_lock``, every row this
        process appended is already published (``SessionHub.unpublished_seqs``), so only
        foreign rows in ``(after, head]`` count. They collapse into one ``Applied`` at the
        head ``server_seq`` with the full snapshot. Its ``command`` is the newest foreign
        agent row, else the newest foreign row (``cross_process_command``), and the
        snapshot's ``last_*`` / ``origin`` fields name that row. The client's authority
        check then applies an agent's command even when a viewer row is the head. Returns
        the event, or ``None`` when there is no foreign row to report.
        """
        store = self._store_optional()
        if store is None:
            return None
        hub = get_hub()
        with _publish_lock(self._project_key):
            snap = store.get_snapshot()
            if _is_empty_authority(snap):
                return None
            assert snap is not None
            head = int(snap.get("server_seq") or 0)
            seqs = hub.unpublished_seqs(self._project_key, after, head)
            row = cross_process_command(store, seqs)
            if row is None:
                return None
            clients = store.list_clients()
            api_snap = {**flatten_for_api(snap, clients), **attribution_fields(row)}
            event = wire_session_event(row, api_snap, roster_version=self._roster_version())
            event["server_seq"] = head
            hub.mark_published(self._project_key, seqs)
            hub.publish(self._project_key, event)
        self._fanout_presence_after_commit(clients)
        return event

    def submit(self, command: SyncCommand) -> dict[str, Any]:
        """Append command, materialize snapshot, fanout. Idempotent on client_seq."""
        if command.client_seq is not None and command.client_seq <= 0:
            raise ValueError("explicit client_seq must be positive")
        store = self.store
        if command.type == "Ack":
            ack_seq = int(command.payload.get("acked_server_seq") or 0)
            store.touch_client(
                command.client_id,
                role=command.role,
                acked_server_seq=ack_seq,
                playhead_sec=normalize_presence_playhead(command.payload.get("playhead_sec")),
                label=_presence_label(command),
            )
            snap = self.snapshot()
            return {
                "ok": True,
                "type": "Ack",
                "server_seq": snap.get("server_seq", 0),
                "snapshot": snap,
                "command": command.to_row(),
            }

        if command.type == "PresenceHeartbeat":
            meta = normalize_presence_meta(command.payload.get("meta"), guest=_is_guest(command))
            return self._touch_and_fanout(command, meta)

        if command.type == "FollowUser":
            raw = dict(command.payload.get("meta") or {})
            raw.setdefault("display_name", command.payload.get("display_name"))
            raw["following"] = command.payload.get("follow_client_id")
            meta = normalize_presence_meta(raw, guest=_is_guest(command))
            return self._touch_and_fanout(command, meta)

        existing = (
            store.find_by_client_seq(command.client_id, command.client_seq)
            if command.client_seq is not None
            else None
        )
        if existing is not None:
            store.require_same_command_id(existing, command.command_id)
            api_snap = self.snapshot()
            event = _applied_event(existing, api_snap, roster_version=api_snap["roster_version"])
            return {"ok": True, "idempotent": True, **event}

        with _publish_lock(self._project_key):
            row, snap, idempotent = store.append_and_apply(
                command_id=command.command_id,
                client_id=command.client_id,
                client_seq=command.client_seq,
                role=command.role,
                type=command.type,
                payload=command.payload,
                causation_id=command.causation_id,
                apply_fn=apply_command,
                empty_snap_fn=empty_snapshot,
            )
            if idempotent:
                api_snap = flatten_for_api(snap, store.list_clients())
                event = _applied_event(row, api_snap, roster_version=self._roster_version())
                return {"ok": True, "idempotent": True, **event}
            store.touch_client(
                command.client_id,
                role=command.role,
                playhead_sec=normalize_presence_playhead(snap.get("playhead_sec")),
                meta={"display_name": "Agent"} if command.role == "agent" else None,
            )
            clients = store.list_clients()
            api_snap = flatten_for_api(snap, clients)
            roster_version = self._roster_version()
            full_event = _applied_event(row, api_snap, roster_version=roster_version)
            wire_event = wire_session_event(row, api_snap, roster_version=roster_version)
            get_hub().publish(self._project_key, wire_event)
        self._fanout_presence_after_commit(clients)
        return {"ok": True, **full_event}

    def _presence_events(
        self, live_rows: list[dict[str, Any]] | None = None
    ) -> list[dict[str, Any]]:
        """The roster fan-out events for the current live client rows (``presence_delta``'s
        diff against what this project key last fanned out). Reads the store directly,
        never ``snapshot()`` (no need to materialize or flatten the durable snapshot for a
        presence-only run). ``live_rows`` reuses rows this commit already read instead of
        re-reading ``store.list_clients()``."""
        if live_rows is not None:
            return get_roster_tracker().events(self._project_key, live_rows)
        store = self._store_optional()
        if store is None:
            return []
        return get_roster_tracker().events(self._project_key, store.list_clients())

    def _safe_presence_events(
        self, live_rows: list[dict[str, Any]] | None = None
    ) -> list[dict[str, Any]]:
        """``_presence_events`` for the coalesced fan-out, on both the leading edge and
        the trailing timer thread. A failed read (a locked or corrupt sync.db) is logged
        and yields no events, and the key's tracked base is dropped, so the next
        successful run fans out a full ``Presence`` at a bumped version instead of
        deltas."""
        try:
            return self._presence_events(live_rows)
        except Exception:
            log.warning("presence fan-out failed for %s", self._project_key, exc_info=True)
            get_roster_tracker().clear_key(self._project_key)
            return []

    def _fanout_presence_after_commit(self, live_rows: list[dict[str, Any]] | None = None) -> None:
        """Schedule the roster fan-out (coalesced to <=10 Hz per project key) after a
        commit that may have changed a client's roster row: a presence heartbeat/follow,
        a client join/leave, or a durable command's own-client touch.

        ``live_rows``, when given, is used to build the leading-edge events instead of
        re-reading the store (the caller's commit already read them); the trailing edge
        always re-reads.

        Best effort: the commit this follows already succeeded, so a fan-out failure on
        either edge (a locked/corrupt sync.db on the presence-only read) is logged and
        swallowed rather than failing the caller, and forces a full-roster resend on the
        next successful run (``_safe_presence_events``).
        """
        leading = (
            None if live_rows is None else functools.partial(self._safe_presence_events, live_rows)
        )
        try:
            schedule_presence(self._project_key, self._safe_presence_events, leading=leading)
        except Exception:
            log.warning("presence fan-out failed for %s", self._project_key, exc_info=True)
            get_roster_tracker().clear_key(self._project_key)

    def roster_event(self) -> dict[str, Any]:
        """A full-roster ``Presence`` for a client's ``RosterRequest`` reply: the tracker's
        last fanned-out rows at their version, read atomically
        (``PresenceRosterTracker.roster``). No version bump: nothing changed, a client just
        missed a delta (a stale/unknown version) and needs to resync."""
        store = self._store_optional()

        def _live_rows() -> list[dict[str, Any]]:
            return store.list_clients() if store is not None else []

        rows, version = get_roster_tracker().roster(self._project_key, _live_rows)
        return presence_roster_event(rows, roster_version=version)

    def _touch_and_fanout(
        self,
        command: SyncCommand,
        meta: dict[str, Any] | None,
    ) -> dict[str, Any]:
        self.store.touch_client(
            command.client_id,
            role=command.role,
            label=_presence_label(command),
            playhead_sec=normalize_presence_playhead(command.payload.get("playhead_sec")),
            meta=meta,
        )
        snap = self.snapshot()
        event = {
            "type": "Presence",
            "clients": snap.get("clients") or [],
            "server_seq": snap.get("server_seq", 0),
            "server_time_ns": snap.get("server_time_ns") or time.time_ns(),
        }
        self._fanout_presence_after_commit(list(snap.get("clients") or []))
        return {"ok": True, **event, "snapshot": snap, "command": command.to_row()}

    def claim_client(self, client_id: str) -> int:
        return self.store.claim_client(client_id)

    def remove_client(self, client_id: str, *, generation: int | None = None) -> None:
        store = self._store_optional()
        if store is None:
            return
        store.remove_client(client_id, generation=generation)
        self._fanout_presence_after_commit()

    # --- Convenience builders (agent / CLI / play) ---

    def submit_play(
        self,
        *,
        timeline_start_sec: float,
        timeline_end_sec: float,
        source: str,
        tier: str,
        dry_run: bool,
        client_id: str = "agent-play",
        role: TransportRole = "agent",
        query: str | None = None,
        match_index: int | None = None,
        wav: str | Path | None = None,
        compare_segments: list[dict[str, Any]] | None = None,
        selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "timeline_start_sec": float(timeline_start_sec),
            "timeline_end_sec": float(timeline_end_sec),
            "source": source,
            "track_id": track_id_from_source(source),
            "tier": tier,
            "query": query,
            "match_index": match_index,
            "wav": str(wav) if wav is not None else None,
            "compare_segments": compare_segments,
            "audition_mode": audition_mode_from_source(source),
        }
        if selection is not None:
            payload["selection"] = selection
        ctype = "AuditionInViewer" if dry_run else "PlayOsAudio"
        return self.submit(
            SyncCommand(
                type=ctype,  # type: ignore[arg-type]
                payload=payload,
                client_id=client_id,
                role=role,
                client_seq=None,
            )
        )

    def submit_control(
        self,
        ctype: str,
        payload: dict[str, Any],
        *,
        client_id: str = "agent-control",
        role: TransportRole = "agent",
    ) -> dict[str, Any]:
        return self.submit(
            SyncCommand(
                type=ctype,  # type: ignore[arg-type]
                payload=payload,
                client_id=client_id,
                role=role,
                client_seq=None,
            )
        )


def read_session_state(project: EpisodeProject) -> dict[str, Any] | None:
    """Current session snapshot, or ``None`` when there is no applied authority."""
    return SessionSyncService(project).state_or_none()
