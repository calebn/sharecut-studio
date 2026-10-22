"""fade_joins_tool and crossfade_joins_tool keep their replies, errors and effects (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project

_REPLY_KEYS = {"operation", "join_count", "fade_ms", "dry_run", "affected_tracks"}


def _joined_path(tmp_path: Path) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    project = load_project(Path(path))
    for tid, speaker, spans in (
        ("host", "Host", ((0.0, 3.0, 0.0), (5.0, 8.0, 3.0), (9.0, 10.0, 6.0))),
        ("guest", "Guest", ((0.0, 2.0, 0.0), (4.0, 6.0, 2.0))),
    ):
        raw = project.workspace_path() / "raw" / f"{tid}.wav"
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        for index, (start, end, at) in enumerate(spans):
            project.clips.append(
                Clip(
                    id=f"{tid}-{index}",
                    track_id=tid,
                    source_start=start,
                    source_end=end,
                    timeline_start=at,
                )
            )
    save_project(project)
    return path


def _clips(path: str) -> dict[str, Clip]:
    return {clip.id: clip for clip in load_project(Path(path)).clips}


def _history_total(path: str) -> int:
    from podcast_mcp.mcp.tools.history import history_status_tool

    return json.loads(history_status_tool(path))["total"]


def test_fade_joins_sets_fade_mode_and_micro_fades(tmp_path):
    path = _joined_path(tmp_path)
    reply = json.loads(mcp_timeline.fade_joins_tool(path, fade_ms=10))
    assert set(reply) == _REPLY_KEYS
    assert reply["operation"] == "fade_joins"
    assert reply["join_count"] == 3
    assert reply["dry_run"] is False
    clips = _clips(path)
    for left, right in (("host-0", "host-1"), ("host-1", "host-2"), ("guest-0", "guest-1")):
        assert clips[right].join_in_mode.value == "fade"
        assert clips[left].fade_out_ms == 10
        assert clips[right].fade_in_ms == 10
    assert clips["host-0"].fade_in_ms == 0


def test_crossfade_joins_sets_crossfade_mode_and_fades(tmp_path):
    path = _joined_path(tmp_path)
    reply = json.loads(mcp_timeline.crossfade_joins_tool(path, fade_ms=25))
    assert set(reply) == _REPLY_KEYS
    assert reply["operation"] == "crossfade_joins"
    assert reply["fade_ms"] == 25
    assert reply["join_count"] == 3
    clips = _clips(path)
    assert clips["host-1"].join_in_mode.value == "crossfade"
    assert clips["host-0"].fade_out_ms == 25
    assert clips["host-1"].fade_in_ms == 25


@pytest.mark.parametrize("tool", ["fade_joins_tool", "crossfade_joins_tool"])
def test_dry_run_counts_joins_and_changes_nothing(tmp_path, tool):
    path = _joined_path(tmp_path)
    before = Path(path).read_bytes()
    total = _history_total(path)
    reply = json.loads(getattr(mcp_timeline, tool)(path, fade_ms=10, dry_run=True))
    assert reply["dry_run"] is True
    assert reply["join_count"] == 3
    assert Path(path).read_bytes() == before
    assert _history_total(path) == total


def test_speaker_filter_limits_the_apply(tmp_path):
    path = _joined_path(tmp_path)
    reply = json.loads(mcp_timeline.fade_joins_tool(path, speaker="Guest", fade_ms=10))
    assert reply["join_count"] == 1
    assert reply["affected_tracks"] == ["guest"]
    clips = _clips(path)
    assert clips["guest-1"].join_in_mode.value == "fade"
    assert clips["host-1"].fade_in_ms == 0
    assert clips["guest-1"].fade_in_ms == 10


@pytest.mark.parametrize("tool", ["fade_joins_tool", "crossfade_joins_tool"])
def test_unknown_track_keeps_its_code(tmp_path, tool):
    path = _joined_path(tmp_path)
    with pytest.raises(ValueError) as raised:
        getattr(mcp_timeline, tool)(path, track_id="nope")
    assert raised.value.code == "track_not_found"


@pytest.mark.parametrize(
    ("tool", "command"),
    [("fade_joins_tool", "FadeJoins"), ("crossfade_joins_tool", "CrossfadeJoins")],
)
def test_an_applying_run_journals_through_the_document_plane(tmp_path, tool, command):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _joined_path(tmp_path)
    getattr(mcp_timeline, tool)(path, fade_ms=10)
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == [command]


@pytest.mark.parametrize("tool", ["fade_joins_tool", "crossfade_joins_tool"])
def test_a_dry_run_never_journals(tmp_path, tool):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _joined_path(tmp_path)
    getattr(mcp_timeline, tool)(path, dry_run=True)
    assert DocumentSyncService.open(path).store.commands_after(0) == []


@pytest.mark.parametrize("tool", ["fade_joins_tool", "crossfade_joins_tool"])
def test_unknown_track_journals_nothing(tmp_path, tool):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _joined_path(tmp_path)
    with pytest.raises(ValueError):
        getattr(mcp_timeline, tool)(path, track_id="nope")
    assert DocumentSyncService.open(path).store.commands_after(0) == []


@pytest.mark.parametrize("tool", ["fade_joins_tool", "crossfade_joins_tool"])
def test_the_applying_run_records_a_clip_render_invalidation(tmp_path, tool):
    from podcast_mcp.engines.render_invalidations import invalidations_as_dicts

    path = _joined_path(tmp_path)
    getattr(mcp_timeline, tool)(path, fade_ms=10)
    reasons = {entry["reason"] for entry in invalidations_as_dicts(load_project(Path(path)))}
    assert "clip" in reasons


@pytest.mark.parametrize("command", ["FadeJoins", "CrossfadeJoins"])
def test_a_preview_cannot_be_submitted_as_a_command(command):
    from podcast_mcp.services.document_sync.payloads import validate_payload

    validate_payload(command, {"dry_run": False})
    with pytest.raises(ValueError):
        validate_payload(command, {"dry_run": True})


@pytest.mark.parametrize(
    ("tool", "command"),
    [("fade_joins_tool", "FadeJoins"), ("crossfade_joins_tool", "CrossfadeJoins")],
)
def test_the_registered_tool_journals_one_row_and_a_preview_none(tmp_path, tool, command):
    from podcast_mcp.services.document_sync import DocumentSyncService

    class _Server:
        def __init__(self) -> None:
            self.tools: dict[str, object] = {}

        def tool(self, *_args, **_kwargs):
            def register(fn):
                self.tools[fn.__name__] = fn
                return fn

            return register

    server = _Server()
    mcp_timeline.register(server)
    registered = server.tools[tool]
    path = _joined_path(tmp_path)
    registered(path, dry_run=True)
    assert DocumentSyncService.open(path).store.commands_after(0) == []
    registered(path, fade_ms=10)
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == [command]
