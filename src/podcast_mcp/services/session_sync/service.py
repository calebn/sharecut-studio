"""Session sync authority - all clients submit typed commands here."""

from __future__ import annotations

import itertools
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, workspace_artifacts_dir
from podcast_mcp.project_io import resolve_project_path
from podcast_mcp.services.session_sync.commands import (
    GUEST_CLIENT_ID_PREFIX,
    ClientRole,
    SyncCommand,
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
)
from podcast_mcp.services.session_sync.presence_fanout import schedule as schedule_presence
from podcast_mcp.services.session_sync.snapshot import (
    apply_command,
    empty_snapshot,
    flatten_for_api,
)

_SEQ = itertools.count(1)

log = logging.getLogger(__name__)

SYNC_META_READ_ERRORS: tuple[type[Exception], ...] = (OSError, sqlite3.DatabaseError)
"""Errors the parse-free meta helpers treat as "store unavailable" (best-effort poll)."""


def session_dir_for_workspace(workspace: Path) -> Path:
    return workspace_artifacts_dir(workspace) / "session"


def sync_db_path_for_workspace(workspace: Path) -> Path:
    return session_dir_for_workspace(workspace) / "sync.db"


def session_dir(project: EpisodeProject) -> Path:
    return session_dir_for_workspace(project.workspace_path())


def sync_db_path(project: EpisodeProject) -> Path:
    return sync_db_path_for_workspace(project.workspace_path())


def _store_at(path: Path, *, create: bool = False) -> SyncStore | None:
    """Return the store for ``path``. Does not create the file until ``create``."""
    if create:
        return cached_sync_store(path, table_prefix="", enforce_command_ids=True)
    return cached_sync_store_if_exists(path, table_prefix="", enforce_command_ids=True)


def _store_for(project: EpisodeProject, *, create: bool = False) -> SyncStore | None:
    """Return the project store. Does not create sync.db until ``create``."""
    return _store_at(sync_db_path(project), create=create)


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


def _read_session_meta(db_path: Path) -> dict[str, Any]:
    path = str(db_path.resolve())
    store = _store_at(db_path, create=False)
    snap = store.get_snapshot() if store is not None else None
    if _is_empty_authority(snap):
        return _missing_session_meta(path)
    assert snap is not None
    return {
        "path": path,
        "mtime_ns": int(snap.get("updated_at_ns") or 0),
        "size": _snapshot_size(snap),
        "exists": True,
        "server_seq": int(snap.get("server_seq") or 0),
    }


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

    Read errors (``SYNC_META_READ_ERRORS``) report the missing meta, the same
    policy as ``document_server_seq``. The caller must pass a path it has already
    authorized; this helper does no authz.
    """
    try:
        return _read_session_meta(db_path)
    except SYNC_META_READ_ERRORS:
        log.debug("session meta unavailable for %s", db_path, exc_info=True)
        return _missing_session_meta(str(db_path))


def session_meta(project_path: str | Path) -> dict[str, Any]:
    """Session meta for the project at ``project_path``, without parsing it.

    The caller must pass a project path it has already authorized (the GUI route
    runs ``resolve_project`` + host auth first); this helper does no authz.
    """
    try:
        workspace = resolve_project_path(project_path).parent
    except OSError:
        log.debug("session meta unavailable for %s", project_path, exc_info=True)
        return _missing_session_meta(str(project_path))
    return session_meta_at(sync_db_path_for_workspace(workspace))


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

    def snapshot(self) -> dict[str, Any]:
        store = self._store_optional()
        if store is None:
            out = flatten_for_api(empty_snapshot(), [])
        else:
            snap = store.get_snapshot() or empty_snapshot()
            clients = store.list_clients()
            out = flatten_for_api(snap, clients)
        out["server_time_ns"] = time.time_ns()
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
            return {
                "ok": True,
                "type": "Applied",
                "command": existing,
                "snapshot": api_snap,
                "server_seq": existing["server_seq"],
                "idempotent": True,
            }

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
            return {
                "ok": True,
                "type": "Applied",
                "command": row,
                "snapshot": api_snap,
                "server_seq": row["server_seq"],
                "idempotent": True,
            }
        store.touch_client(
            command.client_id,
            role=command.role,
            playhead_sec=normalize_presence_playhead(snap.get("playhead_sec")),
            meta={"display_name": "Agent"} if command.role == "agent" else None,
        )
        clients = store.list_clients()
        api_snap = flatten_for_api(snap, clients)
        event = {
            "type": "Applied",
            "command": row,
            "snapshot": api_snap,
            "server_seq": row["server_seq"],
        }
        get_hub().publish(self._project_key, event)
        return {"ok": True, **event}

    def _presence_event(self) -> dict[str, Any]:
        snap = self.snapshot()
        return {
            "type": "Presence",
            "clients": snap.get("clients") or [],
            "server_seq": snap.get("server_seq", 0),
            "server_time_ns": snap.get("server_time_ns") or time.time_ns(),
        }

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
        schedule_presence(self._project_key, self._presence_event, immediate=event)
        return {"ok": True, **event, "snapshot": snap, "command": command.to_row()}

    def claim_client(self, client_id: str) -> int:
        return self.store.claim_client(client_id)

    def remove_client(self, client_id: str, *, generation: int | None = None) -> None:
        store = self._store_optional()
        if store is None:
            return
        store.remove_client(client_id, generation=generation)
        schedule_presence(self._project_key, self._presence_event)

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
        role: ClientRole = "agent",
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
        role: ClientRole = "agent",
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
