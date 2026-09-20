from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import load_project


def _project(path: Path) -> None:
    from podcast_mcp.models import (
        Clip,
        MediaAsset,
        Track,
        TrackRole,
    )

    p = load_project(path)
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    from podcast_mcp.models import save_project

    save_project(p, path)


def test_timeline_mcp_tools(tmp_path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _project(Path(path))
    out = mcp_server.ripple_delete_tool(path, 1.0, 2.0)
    assert "ripple_delete" in out
    out = mcp_server.list_clips_tool(path)
    assert "host" in out
    out = mcp_server.add_chapter_tool(path, 0.0, "Start")
    assert "Start" in out
    removed = json.loads(mcp_server.remove_chapter_tool(path, "Start"))
    assert removed["removed"] is True
    out = mcp_server.list_effects_tool(path)
    data = json.loads(out)
    assert "presets" in data
