from __future__ import annotations

import json
from pathlib import Path

import pytest

from pause_policy_public_helpers import add_bed, project
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, Track, TrackRole, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync import submit_host_command_result
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers

pytestmark = pytest.mark.unscoped_ok

BED_PAD = {
    "source_end": 0.25,
    "source_id": "room-tone-host",
    "source_start": 0.0,
    "track_id": "host",
}
OWN_PAD = {"source_end": 1.125, "source_id": None, "source_start": 0.875, "track_id": "host"}
WIRE_KEYS = ["operation", "affected_tracks", "clip_count", "timeline_duration_sec", "pad_samples"]


def gappy_path(tmp_path: Path, name: str, *, bed: bool = True) -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root)
    result.tracks[0].speaker = "Host"
    if bed:
        add_bed(result, root)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=2.0),
    ]
    return str(save_project(result))


def single_clip_path(tmp_path: Path, name: str = "single") -> str:
    root = tmp_path / name
    root.mkdir()
    return str(save_project(project(root)))


def no_clip_path(tmp_path: Path, name: str = "empty") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root)
    result.clips = []
    return str(save_project(result))


def no_media_path(tmp_path: Path, name: str = "nomedia") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root)
    result.tracks.append(Track(id="ghost", label="Ghost", role=TrackRole.DIALOGUE, media=None))
    result.clips += [
        Clip(id="g-0", track_id="ghost", source_start=0, source_end=1, timeline_start=0),
        Clip(id="g-1", track_id="ghost", source_start=2, source_end=3, timeline_start=2.0),
    ]
    return str(save_project(result))


def digital_guest_path(tmp_path: Path, name: str = "nosrc") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root, guest="digital")
    result.clips = [
        Clip(id="left", track_id="guest", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="guest", source_start=2, source_end=6, timeline_start=2.0),
    ]
    return str(save_project(result))


def twin_speaker_path(tmp_path: Path, name: str = "twins") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root, guest="gated")
    result.tracks[0].speaker = "Host"
    result.tracks[1].speaker = "Host"
    return str(save_project(result))


def _within(kwargs: dict) -> tuple[float, float] | None:
    start, end = kwargs.get("start_sec"), kwargs.get("end_sec")
    return (start, end) if start is not None and end is not None else None


def via_service(path: str, **kwargs) -> dict:
    out = TimelineService(ProjectWorkspace.open(path)).fill_room_tone(
        track_id=kwargs.get("track_id"), speaker=kwargs.get("speaker"), within=_within(kwargs)
    )
    return out.model_dump() if hasattr(out, "model_dump") else out


def via_handler(path: str, **kwargs) -> dict:
    return edit_handlers.fill_room_tone(ProjectWorkspace.open(path), kwargs)


def via_command(path: str, **kwargs) -> dict:
    return submit_host_command_result(path, "FillRoomTone", kwargs)


def via_tool(path: str, **kwargs) -> dict:
    return json.loads(mcp_timeline.fill_with_room_tone_tool(path, **kwargs))


LAYERS = {
    "service": via_service,
    "handler": via_handler,
    "command": via_command,
    "tool": via_tool,
}
