"""Host MCP document-plane submit helper."""

from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.agent_document import submit_host_document_command
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.document_sync import DocumentSyncService


def _seed(path: str, sample_wav) -> None:
    proj = load_project(Path(path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=str(sample_wav), duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, Path(path))


def test_submit_host_document_split_logs_command(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    result = submit_host_document_command(
        path,
        "SplitAtTime",
        {"at_time": 1.5, "track_ids": ["host"]},
    )
    assert result["ok"] is True
    assert result["command"]["type"] == "SplitAtTime"
    svc = DocumentSyncService.open(path)
    rows = svc.store.commands_after(0)
    assert any(r["type"] == "SplitAtTime" for r in rows)


def test_split_clip_tool_uses_document_plane(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    out = json.loads(mcp_timeline.split_clip_tool(path, 2.0, track_id="host"))
    assert out["operation"] == "split_clips_at"
    svc = DocumentSyncService.open(path)
    rows = svc.store.commands_after(0)
    assert any(r["type"] == "SplitAtTime" for r in rows)


def test_host_document_commands_use_server_assigned_sequences(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    body = {"author": "a", "timeline_start": 1.0}
    one = submit_host_document_command(path, "AddComment", {**body, "body": "one"})
    two = submit_host_document_command(path, "AddComment", {**body, "body": "two"})
    assert one["ok"] and two["ok"]
    assert one["command"]["client_seq"] < 0
    assert one["command"]["client_seq"] != two["command"]["client_seq"]
    assert len(load_project(Path(path)).comments) == 2
