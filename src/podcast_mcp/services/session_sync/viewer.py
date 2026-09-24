"""Blob-style publishers that translate into typed session-sync commands.

``SessionSyncService`` (``service.py``) is the sync authority. This module holds
the adapters that turn a viewer snapshot blob or an agent play request into one
or more typed :class:`SyncCommand` submissions against that authority.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.session_sync.commands import SyncCommand
from podcast_mcp.services.session_sync.service import SessionSyncService, next_client_seq


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


def publish_viewer_snapshot(
    project: EpisodeProject,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Viewer publish → Ack + presence playhead + durable deltas only.

    Continuous playhead heartbeats must not emit ``SetPlayhead`` (that fans out
    Applied events, the DAW re-seeks, and audio stutters). Live playhead rides
    ``PresenceHeartbeat``; durable ``SetPlayhead`` is for paused scrub only.
    """
    svc = SessionSyncService(project)
    client_id = str(snapshot.get("client_id") or "viewer-default")
    ack_id = snapshot.get("ack_command_id")
    current = svc.snapshot()
    latest = current
    # Ack current command when client reports it
    if ack_id and ack_id == current.get("last_command_id"):
        latest = svc.submit(
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
        )["snapshot"]

    # Ephemeral playhead for agents / other clients (does not advance server_seq).
    if "playhead_sec" in snapshot:
        latest = svc.submit(
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
        )["snapshot"]

    def _changed(key: str) -> bool:
        return key in snapshot and snapshot.get(key) != current.get(key)

    # Durable field updates only when the value actually changed.
    if _changed("selection"):
        latest = svc.submit_control(
            "SetSelection",
            {"selection": snapshot["selection"]},
            client_id=client_id,
            role="viewer",
        )["snapshot"]
    if (
        "viewer_mute" in snapshot and snapshot.get("viewer_mute") != current.get("viewer_mute")
    ) or ("solo_tracks" in snapshot and snapshot.get("solo_tracks") != current.get("solo_tracks")):
        latest = svc.submit_control(
            "SetMuteSolo",
            {
                "viewer_mute": snapshot.get("viewer_mute", current.get("viewer_mute")),
                "solo_tracks": snapshot.get("solo_tracks", current.get("solo_tracks")),
            },
            client_id=client_id,
            role="viewer",
        )["snapshot"]
    if _changed("audition_mode") or (
        "source" in snapshot and snapshot.get("source") != current.get("source")
    ):
        latest = svc.submit_control(
            "SetMode",
            {
                "audition_mode": snapshot.get("audition_mode", current.get("audition_mode")),
                "source": snapshot.get("source"),
            },
            client_id=client_id,
            role="viewer",
        )["snapshot"]
    playing_now = bool(snapshot.get("is_playing", current.get("is_playing")))
    if _changed("is_playing"):
        latest = svc.submit_control(
            "SetPlaying",
            {"is_playing": snapshot["is_playing"]},
            client_id=client_id,
            role="viewer",
        )["snapshot"]
    # Paused scrub only - never journal playhead while transport is rolling
    # (local or remote). PresenceHeartbeat above already carries live playhead.
    if (
        "playhead_sec" in snapshot
        and not playing_now
        and not bool(latest.get("is_playing"))
        and float(snapshot["playhead_sec"]) != float(current.get("playhead_sec") or 0.0)
    ):
        latest = svc.submit_control(
            "SetPlayhead",
            {"playhead_sec": snapshot["playhead_sec"]},
            client_id=client_id,
            role="viewer",
        )["snapshot"]
    if "region" in snapshot and snapshot["region"] is None and current.get("region"):
        latest = svc.submit_control(
            "ClearRegion", {"stop": False}, client_id=client_id, role="viewer"
        )["snapshot"]

    # Durable submit results do not carry the response clock that snapshot() adds.
    latest["server_time_ns"] = time.time_ns()
    return latest
