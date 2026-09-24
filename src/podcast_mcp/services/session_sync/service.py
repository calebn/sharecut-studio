"""Session sync authority - all clients submit typed commands here."""

from __future__ import annotations

import itertools
import time
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.session_sync.commands import (
    ClientRole,
    SyncCommand,
    audition_mode_from_source,
    normalize_presence_meta,
    track_id_from_source,
)
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import (
    _STORE_CACHE,
    SyncStore,
    cached_sync_store,
)
from podcast_mcp.services.session_sync.presence_fanout import schedule as schedule_presence
from podcast_mcp.services.session_sync.snapshot import (
    apply_command,
    empty_snapshot,
    flatten_for_api,
)

_SEQ = itertools.count(1)


def session_dir(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / "session"


def sync_db_path(project: EpisodeProject) -> Path:
    return session_dir(project) / "sync.db"


def _store_for(project: EpisodeProject, *, create: bool = False) -> SyncStore | None:
    """Return the project store. Does not create sync.db until ``create``."""
    path = sync_db_path(project)
    key = f"{path.resolve()}|"
    store = _STORE_CACHE.get(key)
    if store is not None:
        return store
    if not path.is_file() and not create:
        return None
    store = cached_sync_store(path, table_prefix="")
    return store


def next_client_seq() -> int:
    return next(_SEQ)


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
        if int(snap.get("server_seq") or 0) == 0 and snap.get("last_command_id") is None:
            return None
        return snap

    def meta(self) -> dict[str, Any]:
        path = sync_db_path(self.project)
        snap = self.state_or_none()
        if snap is None:
            return {
                "path": str(path.resolve()),
                "mtime_ns": 0,
                "size": 0,
                "exists": False,
                "server_seq": 0,
            }
        stat = path.stat() if path.is_file() else None
        return {
            "path": str(path.resolve()),
            "mtime_ns": (stat.st_mtime_ns if stat else int(snap.get("updated_at_ns") or 0)),
            "size": stat.st_size if stat else 0,
            "exists": True,
            "server_seq": int(snap.get("server_seq") or 0),
        }

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
                playhead_sec=command.payload.get("playhead_sec"),
                label=command.payload.get("label"),
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
            guest = command.client_id.startswith("guest-")
            meta = normalize_presence_meta(command.payload.get("meta"), guest=guest)
            return self._touch_and_fanout(command, meta)

        if command.type == "FollowUser":
            guest = command.client_id.startswith("guest-")
            raw = dict(command.payload.get("meta") or {})
            raw.setdefault("display_name", command.payload.get("display_name"))
            raw["following"] = command.payload.get("follow_client_id")
            meta = normalize_presence_meta(raw, guest=guest)
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
            playhead_sec=snap.get("playhead_sec"),
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
            label=command.payload.get("label"),
            playhead_sec=command.payload.get("playhead_sec"),
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
