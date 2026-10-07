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
    mcp_timeline.delete_clips_tool(path, ["c1"])
    assert _clip_starts(path) == {"c2": 4.0}
    assert _journal_types(path) == ["DeleteClip"]


def test_delete_clips_tool_ripple_closes_the_gap(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    mcp_timeline.delete_clips_tool(path, ["c1"], mode="ripple")
    assert _clip_starts(path) == {"c2": 0.0}
    assert _journal_types(path) == ["DeleteClip"]


def _seed_two_lanes(path: str, sample_wav) -> None:
    _seed_two_clips(path, sample_wav)
    proj = load_project(Path(path))
    proj.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path=str(sample_wav), duration_sec=10.0),
        )
    )
    proj.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=8.0, timeline_start=0.0)
    )
    save_project(proj, Path(path))


def _layout(path: str) -> list[tuple[str, float, float, float]]:
    return sorted(
        (c.track_id, round(c.timeline_start, 6), c.source_start, c.source_end)
        for c in load_project(Path(path)).clips
    )


def test_paste_segment_tool_pastes_one_track_copy_twice(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_lanes(path, sample_wav)
    clipboard = json.loads(mcp_timeline.copy_segment_tool(path, 1.0, 3.0, ["host"]))
    mcp_timeline.paste_segment_tool(path, 4.0, clipboard)
    mcp_timeline.paste_segment_tool(path, 4.0, clipboard)
    assert _layout(path) == [
        ("guest", 0.0, 0.0, 4.0),
        ("guest", 8.0, 4.0, 8.0),
        ("host", 0.0, 0.0, 4.0),
        ("host", 4.0, 1.0, 3.0),
        ("host", 6.0, 1.0, 3.0),
        ("host", 8.0, 6.0, 10.0),
    ]
    assert _journal_types(path) == ["PasteSegment", "PasteSegment"]


def test_paste_segment_tool_gap_mode_pastes_over_in_place(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_lanes(path, sample_wav)
    clipboard = json.loads(mcp_timeline.copy_segment_tool(path, 1.0, 3.0, ["host"]))
    mcp_timeline.paste_segment_tool(path, 5.0, clipboard, mode="gap")
    assert _layout(path) == [
        ("guest", 0.0, 0.0, 8.0),
        ("host", 0.0, 0.0, 4.0),
        ("host", 4.0, 6.0, 7.0),
        ("host", 5.0, 1.0, 3.0),
        ("host", 7.0, 9.0, 10.0),
    ]
    assert _journal_types(path) == ["PasteSegment"]


def _on_disk(path: str) -> tuple[bytes, list[str], dict]:
    """Everything a paste could write: the project file, the command journal, the history index."""
    return (
        Path(path).read_bytes(),
        _journal_types(path),
        load_project(Path(path)).history.model_dump(mode="json"),
    )


_BAD_CLIPBOARDS = {
    "paste_unknown_track": {"track_id": "ghost", "source_start": 1.0, "source_end": 3.0},
    "paste_unknown_source": {
        "track_id": "host",
        "source_id": "ghost",
        "source_start": 1.0,
        "source_end": 3.0,
    },
    "paste_bad_range": {"track_id": "host", "source_start": 1.0, "source_end": 99.0},
}


@pytest.mark.parametrize("code", sorted(_BAD_CLIPBOARDS))
def test_paste_segment_tool_rejects_a_bad_clipboard_and_writes_nothing(tmp_path, sample_wav, code):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    before = _on_disk(path)
    clipboard = {"duration": 2.0, "extracts": [_BAD_CLIPBOARDS[code]]}
    with pytest.raises(ValueError, match=f"^{code}: "):
        mcp_timeline.paste_segment_tool(path, 4.0, clipboard)
    assert _on_disk(path) == before


def test_cli_paste_segment_rejects_a_bad_clipboard_and_writes_nothing(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    before = _on_disk(path)
    clipboard = json.dumps({"duration": 2.0, "extracts": [_BAD_CLIPBOARDS["paste_unknown_track"]]})
    result = CliRunner().invoke(
        app,
        ["edit", "paste-segment", "--project", path, "--at", "4", "--clipboard", "-"],
        input=clipboard,
    )
    assert result.exit_code != 0
    assert "paste_unknown_track: " in result.output
    assert _on_disk(path) == before


def test_paste_segment_document_command_rejects_a_bad_clipboard_and_writes_nothing(
    tmp_path, sample_wav
):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    before = _on_disk(path)
    payload = {
        "insert_at": 4.0,
        "duration": 2.0,
        "extracts": [_BAD_CLIPBOARDS["paste_bad_range"]],
        "mode": "ripple",
    }
    with pytest.raises(ValueError, match="paste_bad_range: "):
        submit_host_document_command(path, "PasteSegment", payload)
    assert _on_disk(path) == before


def test_cli_copy_then_paste_segment_is_undoable(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    before = _layout(path)
    runner = CliRunner()
    copied = runner.invoke(
        app, ["edit", "copy-segment", "--project", path, "--start", "1", "--end", "3"]
    )
    assert copied.exit_code == 0, copied.output
    pasted = runner.invoke(
        app,
        ["edit", "paste-segment", "--project", path, "--at", "8", "--clipboard", "-"],
        input=copied.output,
    )
    assert pasted.exit_code == 0, pasted.output
    assert json.loads(pasted.output)["operation"] == "paste_segment"
    assert _layout(path) == [*before, ("host", 8.0, 1.0, 3.0)]
    assert _journal_types(path) == ["PasteSegment"]
    assert runner.invoke(app, ["undo", "--project", path]).exit_code == 0
    assert _layout(path) == before


def test_cli_delete_clips_is_undoable(tmp_path, sample_wav):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed_two_clips(path, sample_wav)
    runner = CliRunner()
    result = runner.invoke(
        app, ["edit", "delete-clips", "--project", path, "--ids", "c1", "--mode", "ripple"]
    )
    assert result.exit_code == 0, result.output
    assert _clip_starts(path) == {"c2": 0.0}
    assert _journal_types(path) == ["DeleteClip"]
    assert runner.invoke(app, ["undo", "--project", path]).exit_code == 0
    assert _clip_starts(path) == {"c1": 0.0, "c2": 4.0}
