"""SetClipJoin: mode and fades in one step, across domain, service, document, MCP and CLI."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.clips_ops import crossfade_ms_at_join, roll_clip_join
from podcast_mcp.edits.join_modes import (
    default_join_length_ms,
    set_clip_join,
    set_clip_join_mode,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.render_invalidations import reason_for_operation
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.payloads import SetClipJoinPayload
from podcast_mcp.services.document_sync.projections import ViewProjection, projection_for_command
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace

runner = CliRunner()


def _project(gap: float = 0.0, *, dur: float = 4.0) -> EpisodeProject:
    p = EpisodeProject.create("join_cmd", "/tmp/join_cmd")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=dur, timeline_start=0.0),
        Clip(
            id="c2",
            track_id="host",
            source_start=dur,
            source_end=dur * 2,
            timeline_start=dur + gap,
        ),
    ]
    return p


def test_crossfade_sets_both_fades_to_default():
    p = _project()
    out = set_clip_join(p, "c1", "c2", "crossfade")
    c1, c2 = p.clips
    assert (c1.fade_out_ms, c2.fade_in_ms) == (25, 25)
    assert c2.join_in_mode == ClipJoinMode.CROSSFADE
    assert out["operation"] == "set_clip_join"
    assert out["crossfade_ms"] == 25
    assert out["crossfade_blocked"] is None
    assert crossfade_ms_at_join(c1, c2) == 25


def test_crossfade_length_is_clamped_and_zero_rejected():
    p = _project()
    set_clip_join(p, "c1", "c2", ClipJoinMode.CROSSFADE, length_ms=500)
    assert p.clips[0].fade_out_ms == 40  # dialogue cap
    assert p.clips[1].fade_in_ms == 40
    with pytest.raises(ValueError, match="> 0"):
        set_clip_join(p, "c1", "c2", "crossfade", length_ms=0)
    with pytest.raises(ValueError, match=">= 0"):
        set_clip_join(p, "c1", "c2", "fade", length_ms=-1)


def test_cut_zeroes_both_fades():
    p = _project()
    p.clips[0].fade_out_ms = 20
    p.clips[1].fade_in_ms = 20
    out = set_clip_join(p, "c1", "c2", "cut")
    assert (p.clips[0].fade_out_ms, p.clips[1].fade_in_ms) == (0, 0)
    assert p.clips[1].join_in_mode == ClipJoinMode.CUT
    assert out["crossfade_blocked"] is None


def test_fade_defaults_keep_or_seed():
    p = _project()
    set_clip_join(p, "c1", "c2", "fade")
    assert (p.clips[0].fade_out_ms, p.clips[1].fade_in_ms) == (10, 10)
    p.clips[0].fade_out_ms = 30
    p.clips[1].fade_in_ms = 5
    set_clip_join(p, "c1", "c2", "fade")
    assert (p.clips[0].fade_out_ms, p.clips[1].fade_in_ms) == (30, 5)
    set_clip_join(p, "c1", "c2", "fade", length_ms=12)
    assert (p.clips[0].fade_out_ms, p.clips[1].fade_in_ms) == (12, 12)
    assert default_join_length_ms(ClipJoinMode.CUT) == 0


def test_non_abutting_crossfade_reports_blocked():
    p = _project(gap=1.0)
    out = set_clip_join(p, "c1", "c2", "crossfade")
    assert out["crossfade_blocked"] == "not_abutting"
    assert out["crossfade_ms"] == 0


def test_non_neighbours_rejected():
    p = _project()
    with pytest.raises(ValueError, match="next clip"):
        set_clip_join(p, "c2", "c1", "cut")


def test_service_is_one_undo_step(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = _project().timeline.tracks
    ws.project.timeline.clips = _project().timeline.clips
    ws.save()
    svc = EditService(ProjectWorkspace.open(minimal_project))
    out = svc.set_clip_join("c1", "c2", "crossfade", 20)
    assert out["crossfade_ms"] == 20
    from podcast_mcp.services.history import HistoryService

    hist = HistoryService(ProjectWorkspace.open(minimal_project))
    before = hist.status()["cursor"]
    hist.undo()
    assert hist.status()["cursor"] == before - 1
    ws2 = ProjectWorkspace.open(minimal_project)
    c1, c2 = ws2.project.clips
    assert c2.join_in_mode == ClipJoinMode.FADE
    assert (c1.fade_out_ms, c2.fade_in_ms) == (0, 0)


def test_set_clip_join_invalidates_as_clip_op():
    assert reason_for_operation("set_clip_join") == "clip"


def test_render_bug_mode_alone_does_not_crossfade_but_set_clip_join_does():
    p = _project()
    p.clips[1].join_in_mode = ClipJoinMode.CROSSFADE
    assert crossfade_ms_at_join(p.clips[0], p.clips[1]) == 0
    set_clip_join(p, "c1", "c2", "crossfade", length_ms=20)
    assert crossfade_ms_at_join(p.clips[0], p.clips[1]) == 20


def test_render_uses_acrossfade_after_set_clip_join(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws"
    (ws / "raw").mkdir(parents=True)
    (ws / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    p = EpisodeProject.create("cj", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    p.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.4, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=0.6, source_end=1.0, timeline_start=0.4),
    ]
    set_clip_join(p, "c1", "c2", "crossfade", length_ms=20)
    import podcast_mcp.engines.ffmpeg as ff

    real_run = ff.run
    commands: list[str] = []

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(
            p,
            p.tracks[0],
            ws / "out.wav",
            {"render": {"crossfade_curve": "tri"}},
            engine=eng,
        )
    render_cmds = [c for c in commands if "filter_complex" in c]
    assert "acrossfade=d=0.02:c1=tri:c2=tri" in render_cmds[0]


def test_document_command_applies_and_undoes(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = _project().timeline.tracks
    ws.project.timeline.clips = _project().timeline.clips
    ws.save()
    svc = DocumentSyncService.open(minimal_project)
    res = svc.submit(
        DocumentCommand(
            type="SetClipJoin",
            payload={"left_clip_id": "c1", "right_clip_id": "c2", "mode": "crossfade"},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert res["ok"]
    row = res["snapshot"]["patch"]["clips"]["tracks"]["host"][1]
    assert row["join_in_mode"] == "crossfade"
    assert row["fade_in_ms"] == 25
    assert row["join_crossfade_ms"] == 25
    undone = svc.submit(
        DocumentCommand(type="UndoHistory", payload={}, client_id="c1", role="viewer", client_seq=2)
    )
    assert undone["ok"]
    c2 = ProjectWorkspace.open(minimal_project).project.clips[1]
    assert c2.join_in_mode == ClipJoinMode.FADE
    assert c2.fade_in_ms == 0


def test_payload_validation_and_projection():
    ok = SetClipJoinPayload(left_clip_id="a", right_clip_id="b", mode="cut")
    assert ok.length_ms is None
    with pytest.raises(ValidationError):
        SetClipJoinPayload(left_clip_id="a", right_clip_id="b", mode="cut", length_ms=-1)
    with pytest.raises(ValidationError):
        SetClipJoinPayload(left_clip_id="a", right_clip_id="b", mode="wipe")
    assert projection_for_command("SetClipJoin") is ViewProjection.CLIPS


def test_mcp_tool_delegates():
    with (
        patch("podcast_mcp.mcp.tools.timeline.EditService") as svc_cls,
        patch("podcast_mcp.mcp.tools.timeline.ProjectWorkspace"),
    ):
        svc_cls.return_value.set_clip_join.return_value = {"operation": "set_clip_join"}
        out = json.loads(mcp_timeline.set_clip_join_tool("p.json", "a", "b", "crossfade", 30))
    assert out["operation"] == "set_clip_join"
    svc_cls.return_value.set_clip_join.assert_called_once_with("a", "b", "crossfade", 30)


def test_cli_set_clip_join(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.set_clip_join.return_value = {"operation": "set_clip_join"}
        result = runner.invoke(
            app,
            [
                "edit",
                "set-clip-join",
                "--project",
                str(ws / "episode.project.json"),
                "--left",
                "a",
                "--right",
                "b",
                "--mode",
                "crossfade",
                "--length-ms",
                "30",
            ],
        )
    assert result.exit_code == 0
    assert json.loads(result.stdout) == {"operation": "set_clip_join"}
    service.return_value.set_clip_join.assert_called_once_with("a", "b", "crossfade", 30)


def test_cross_track_join_rejected_with_shared_message():
    p = _project()
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=4.0, timeline_start=4.0)
    )
    with pytest.raises(ValueError, match="join requires clips on the same track"):
        set_clip_join(p, "c1", "g1", "cut")
    with pytest.raises(ValueError, match="join requires clips on the same track"):
        roll_clip_join(p, "c1", "g1", 0.1)


def test_cut_then_fade_reseeds_the_default():
    p = _project()
    set_clip_join(p, "c1", "c2", "fade", length_ms=30)
    set_clip_join(p, "c1", "c2", "cut")
    set_clip_join(p, "c1", "c2", "fade")
    assert (p.clips[0].fade_out_ms, p.clips[1].fade_in_ms) == (10, 10)


def test_clamped_crossfade_reports_the_shorter_overlap():
    p = _project(dur=0.05)  # two 50 ms clips
    p.clips[0].fade_in_ms = 30  # leaves 20 ms for the left fade-out
    out = set_clip_join(p, "c1", "c2", "crossfade", length_ms=25)
    assert p.clips[0].fade_out_ms == 20
    assert p.clips[1].fade_in_ms == 25
    assert out["crossfade_ms"] == 20  # max(min(20, 25), 25 // 2)
    assert out["crossfade_blocked"] is None


def test_mode_only_crossfade_reports_why_it_will_not_blend():
    p = _project()
    out = set_clip_join_mode(p, "c2", "crossfade")
    assert out["join_left_clip_id"] == "c1"
    assert out["join_crossfade_blocked"] == "no_fade_out"
    assert out["join_crossfade_ms"] == 0
    first = set_clip_join_mode(p, "c1", "crossfade")
    assert first["join_left_clip_id"] is None
    assert first["join_crossfade_blocked"] is None
