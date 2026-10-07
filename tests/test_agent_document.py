"""Host MCP document-plane submit helper."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_document_command


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


def _seed_two_clips(path: str, sample_wav) -> None:
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
        Clip(id="c1", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=6.0, source_end=10.0, timeline_start=4.0),
    ]
    save_project(proj, Path(path))


def _clip_starts(path: str) -> dict[str, float]:
    return {c.id: c.timeline_start for c in load_project(Path(path)).clips}


def _journal_types(path: str) -> list[str]:
    return [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]


def test_delete_clips_tool_leaves_a_gap_through_the_document_plane(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    mcp_timeline.delete_clips_tool(path, '["c1"]')
    assert _clip_starts(path) == {"c2": 4.0}
    assert _journal_types(path) == ["DeleteClip"]


def test_delete_clips_tool_ripple_closes_the_gap(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    mcp_timeline.delete_clips_tool(path, '["c1"]', ripple=True)
    assert _clip_starts(path) == {"c2": 0.0}
    assert _journal_types(path) == ["RippleDeleteClip"]


def test_delete_clips_tool_rejects_a_non_list(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    with pytest.raises(ValueError, match="JSON array of clip ids"):
        mcp_timeline.delete_clips_tool(path, '"c1"')


def test_cli_delete_clips_is_undoable(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    runner = CliRunner()
    result = runner.invoke(
        app, ["edit", "delete-clips", "--project", path, "--ids", "c1", "--ripple"]
    )
    assert result.exit_code == 0, result.output
    assert _clip_starts(path) == {"c2": 0.0}
    assert _journal_types(path) == ["RippleDeleteClip"]
    assert runner.invoke(app, ["undo", "--project", path]).exit_code == 0
    assert _clip_starts(path) == {"c1": 0.0, "c2": 4.0}
