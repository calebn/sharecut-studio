"""Compatibility facade over :mod:`podcast_mcp.services.session_sync`.

Prefer ``SessionSyncService`` for new code. These helpers keep MCP/CLI/tests
working during the migration to the command-log engine.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.session_sync.commands import (
    audition_mode_from_source,
    track_id_from_source,
)
from podcast_mcp.services.session_sync.service import SessionSyncService

# Re-export helpers used by tests / callers
__all__ = [
    "audition_mode_from_source",
    "publish_agent_control",
    "publish_agent_play",
    "publish_viewer_snapshot",
    "read_session_state",
    "session_meta",
    "session_state_path",
    "track_id_from_source",
]


def session_state_path(project: EpisodeProject) -> Path:
    """Legacy JSON path (still written as a materialized mirror)."""
    return project.artifacts_dir() / "session_state.json"


def read_session_state(project: EpisodeProject) -> dict[str, Any] | None:
    svc = SessionSyncService(project)
    if svc._store_optional() is None and not session_state_path(project).is_file():
        return None
    snap = svc.snapshot()
    if int(snap.get("server_seq") or 0) == 0 and snap.get("command_id") is None:
        return None
    return snap


def session_meta(project_path: Path) -> dict[str, Any]:
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
    from podcast_mcp.services.session_sync.service import next_client_seq

    svc = SessionSyncService(project)
    client_id = str(snapshot.get("client_id") or "viewer-default")
    ack_id = snapshot.get("ack_command_id")
    current = svc.snapshot()
    # Ack current command when client reports it
    if ack_id and ack_id == current.get("command_id"):
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
