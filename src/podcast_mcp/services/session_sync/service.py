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

    def meta(self) -> dict[str, Any]:
        path = sync_db_path(self.project)
        store = self._store_optional()
        snap = store.get_snapshot() if store else None
        if store is None or (not path.is_file() and snap is None):
            return {
                "path": str(path.resolve()),
                "mtime_ns": 0,
                "size": 0,
                "exists": False,
                "server_seq": 0,
            }
        if snap is None or (
            int(snap.get("server_seq") or 0) == 0 and snap.get("last_command_id") is None
        ):
            # DB may exist from a failed open; treat empty authority as missing
            return {
                "path": str(path.resolve()),
                "mtime_ns": 0,
                "size": 0,
                "exists": False,
                "server_seq": 0,
            }
        assert snap is not None
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

        existing = store.find_by_client_seq(command.client_id, command.client_seq)
        if existing is not None:
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
                client_seq=next_client_seq(),
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
                client_seq=next_client_seq(),
            )
        )


# --- Exported module-level functions (formerly session_state.py) ---


def read_session_state(project: EpisodeProject) -> dict[str, Any] | None:
    """Read the current session state, or None if empty."""
    svc = SessionSyncService(project)
    if svc._store_optional() is None:
        return None
    snap = svc.snapshot()
    if int(snap.get("server_seq") or 0) == 0 and snap.get("last_command_id") is None:
        return None
    return snap


def session_meta(project_path: Path) -> dict[str, Any]:
    """Get session metadata (path, mtime, size, existence, server_seq)."""
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(project_path)
    return SessionSyncService(ws.project).meta()


def publish_agent_play(
    project: EpisodeProject,
    *,
    timeline_start_sec: float,
    timeline_end_sec: float,
    source: str,
    tier: str,
    dry_run: bool,
    query: str | None = None,
    match_index: int | None = None,
    wav: str | Path | None = None,
    compare_segments: list[dict[str, Any]] | None = None,
    selection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Submit a play command and return the resulting snapshot."""
    result = SessionSyncService(project).submit_play(
        timeline_start_sec=timeline_start_sec,
        timeline_end_sec=timeline_end_sec,
        source=source,
        tier=tier,
        dry_run=dry_run,
        query=query,
        match_index=match_index,
        wav=wav,
        compare_segments=compare_segments,
        selection=selection,
    )
    return result["snapshot"]


def publish_agent_control(
    project: EpisodeProject,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Map free-form patch onto typed commands and return the resulting snapshot."""
    svc = SessionSyncService(project)
    # Map free-form patch onto typed commands (one or more)
    if "selection" in patch and set(patch.keys()) <= {"selection"}:
        snap = svc.submit_control("SetSelection", {"selection": patch["selection"]})
        return snap["snapshot"]
    if "playhead_sec" in patch and set(patch.keys()) <= {"playhead_sec", "selection"}:
        payload: dict[str, Any] = {"playhead_sec": patch["playhead_sec"]}
        if "selection" in patch:
            payload["selection"] = patch["selection"]
        snap = svc.submit_control("SetPlayhead", payload)
        return snap["snapshot"]
    if "is_playing" in patch and set(patch.keys()) <= {"is_playing"}:
        snap = svc.submit_control("SetPlaying", {"is_playing": patch["is_playing"]})
        return snap["snapshot"]
    if "audition_mode" in patch:
        snap = svc.submit_control(
            "SetMode",
            {
                "audition_mode": patch["audition_mode"],
                "source": patch.get("source"),
            },
        )
        return snap["snapshot"]
    if patch.get("region") is None and "region" in patch:
        snap = svc.submit_control("ClearRegion", {"stop": True})
        # Also apply other keys if present
        if "is_playing" in patch:
            snap = svc.submit_control("SetPlaying", {"is_playing": patch["is_playing"]})
        return snap["snapshot"]
    if isinstance(patch.get("region"), dict):
        r = patch["region"]
        payload = {
            "start_sec": r["start_sec"],
            "end_sec": r["end_sec"],
            "playhead_sec": patch.get("playhead_sec", r["start_sec"]),
            "is_playing": patch.get("is_playing", False),
            "query": patch.get("query"),
        }
        if "selection" in patch:
            payload["selection"] = patch["selection"]
        snap = svc.submit_control("SetRegion", payload)
        return snap["snapshot"]
    if "solo_tracks" in patch or "viewer_mute" in patch:
        snap = svc.submit_control(
            "SetMuteSolo",
            {
                "solo_tracks": patch.get("solo_tracks"),
                "viewer_mute": patch.get("viewer_mute"),
            },
        )
        return snap["snapshot"]
    # Fallback: set playhead if present
    if "playhead_sec" in patch:
        payload = {"playhead_sec": patch["playhead_sec"]}
        if "selection" in patch:
            payload["selection"] = patch["selection"]
        snap = svc.submit_control("SetPlayhead", payload)
        return snap["snapshot"]
    return svc.snapshot()


def publish_viewer_snapshot(
    project: EpisodeProject,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Viewer publish → Ack + presence playhead + durable deltas only.

    Continuous playhead heartbeats must not emit ``SetPlayhead`` (that fans out
    Applied events, the DAW re-seeks, and audio stutters). Live playhead rides
    ``PresenceHeartbeat``; durable ``SetPlayhead`` is for paused scrub only.
    """
    from podcast_mcp.services.session_sync.commands import SyncCommand

    svc = SessionSyncService(project)
    client_id = str(snapshot.get("client_id") or "viewer-default")
    ack_id = snapshot.get("ack_command_id")
    current = svc.snapshot()
    # Ack current command when client reports it
    if ack_id and ack_id == current.get("last_command_id"):
        svc.submit(
            SyncCommand(
                type="Ack",
                payload={
                    "acked_server_seq": int(current.get("server_seq") or 0),
                    "playhead_sec": snapshot.get("playhead_sec"),
                    "label": snapshot.get("label"),
                },
                client_id=client_id,
                role="viewer",
                client_seq=next_client_seq(),
            )
        )

    # Ephemeral playhead for agents / other clients (does not advance server_seq).
    if "playhead_sec" in snapshot:
        svc.submit(
            SyncCommand(
                type="PresenceHeartbeat",
                payload={
                    "label": snapshot.get("label"),
                    "playhead_sec": snapshot.get("playhead_sec"),
                },
                client_id=client_id,
                role="viewer",
                client_seq=next_client_seq(),
            )
        )

    def _changed(key: str) -> bool:
        return key in snapshot and snapshot.get(key) != current.get(key)

    # Durable field updates only when the value actually changed.
    if _changed("selection"):
        svc.submit_control(
            "SetSelection",
            {"selection": snapshot["selection"]},
            client_id=client_id,
            role="viewer",
        )
    if (
        "viewer_mute" in snapshot and snapshot.get("viewer_mute") != current.get("viewer_mute")
    ) or ("solo_tracks" in snapshot and snapshot.get("solo_tracks") != current.get("solo_tracks")):
        svc.submit_control(
            "SetMuteSolo",
            {
                "viewer_mute": snapshot.get("viewer_mute", current.get("viewer_mute")),
                "solo_tracks": snapshot.get("solo_tracks", current.get("solo_tracks")),
            },
            client_id=client_id,
            role="viewer",
        )
    if _changed("audition_mode") or (
        "source" in snapshot and snapshot.get("source") != current.get("source")
    ):
        svc.submit_control(
            "SetMode",
            {
                "audition_mode": snapshot.get("audition_mode", current.get("audition_mode")),
                "source": snapshot.get("source"),
            },
            client_id=client_id,
            role="viewer",
        )
    playing_now = bool(snapshot.get("is_playing", current.get("is_playing")))
    if _changed("is_playing"):
        svc.submit_control(
            "SetPlaying",
            {"is_playing": snapshot["is_playing"]},
            client_id=client_id,
            role="viewer",
        )
        current = svc.snapshot()
    # Paused scrub only - never journal playhead while transport is rolling
    # (local or remote). PresenceHeartbeat above already carries live playhead.
    if (
        "playhead_sec" in snapshot
        and not playing_now
        and not bool(current.get("is_playing"))
        and float(snapshot["playhead_sec"]) != float(current.get("playhead_sec") or 0.0)
    ):
        svc.submit_control(
            "SetPlayhead",
            {"playhead_sec": snapshot["playhead_sec"]},
            client_id=client_id,
            role="viewer",
        )
    if "region" in snapshot and snapshot["region"] is None and current.get("region"):
        svc.submit_control("ClearRegion", {"stop": False}, client_id=client_id, role="viewer")

    return svc.snapshot()
