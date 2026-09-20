"""Tests for move_clips domain op and MoveClips document command."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.clips_ops import move_clips, pin_clip_source_id
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace

runner = CliRunner()


def _two_tracks(ws: ProjectWorkspace) -> None:
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=40.0),
        ),
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=15.0,
            timeline_start=5.0,
        ),
        Clip(
            id="g1",
            track_id="guest",
            source_start=0.0,
            source_end=4.0,
            timeline_start=1.0,
        ),
    ]
    ws.save()


def test_move_clips_intra_track_leaves_gap(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    move_clips(project, [{"clip_id": "c1", "timeline_start": 8.0, "track_id": "host"}])
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.timeline_start == pytest.approx(8.0)
    assert c1.track_id == "host"
    assert c2.timeline_start == pytest.approx(5.0)
    assert c1.source_id is None


def test_move_clips_batch_rigid_group(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    move_clips(
        project,
        [
            {"clip_id": "c1", "timeline_start": 2.0, "track_id": "host"},
            {"clip_id": "c2", "timeline_start": 7.0, "track_id": "host"},
        ],
    )
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.timeline_start == pytest.approx(2.0)
    assert c2.timeline_start == pytest.approx(7.0)


def test_move_clips_inter_track_pins_source_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    move_clips(project, [{"clip_id": "c1", "timeline_start": 3.0, "track_id": "guest"}])
    c1 = next(c for c in project.clips if c.id == "c1")
    assert c1.track_id == "guest"
    assert c1.timeline_start == pytest.approx(3.0)
    assert c1.source_id is not None
    src = next(s for s in project.sources if s.id == c1.source_id)
    assert src.path == "raw/host.wav"


def test_move_clips_unknown_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="unknown clip_id"):
        move_clips(ws.project, [{"clip_id": "nope", "timeline_start": 0.0, "track_id": "host"}])


def test_move_clips_duplicate_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="duplicate clip_id"):
        move_clips(
            ws.project,
            [
                {"clip_id": "c1", "timeline_start": 1.0, "track_id": "host"},
                {"clip_id": "c1", "timeline_start": 2.0, "track_id": "guest"},
            ],
        )


def test_move_clips_unknown_track(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="unknown track_id"):
        move_clips(
            ws.project,
            [{"clip_id": "c1", "timeline_start": 0.0, "track_id": "missing"}],
        )


def test_move_clips_rejects_negative_time(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="timeline_start"):
        move_clips(ws.project, [{"clip_id": "c1", "timeline_start": -1.0, "track_id": "host"}])


def test_document_move_clips(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="MoveClips",
            payload={
                "clips": [{"clip_id": "c1", "timeline_start": 4.0, "track_id": "guest"}],
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert out["ok"]
    ws2 = ProjectWorkspace.open(minimal_project)
    c1 = next(c for c in ws2.project.clips if c.id == "c1")
    assert c1.track_id == "guest"
    assert c1.timeline_start == pytest.approx(4.0)
    assert c1.source_id is not None


def test_move_clips_tool(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    payload = json.dumps([{"clip_id": "g1", "timeline_start": 9.0, "track_id": "guest"}])
    out = json.loads(mcp_timeline.move_clips_tool(str(minimal_project), payload))
    assert out["operation"] == "move_clips"
    ws2 = ProjectWorkspace.open(minimal_project)
    g1 = next(c for c in ws2.project.clips if c.id == "g1")
    assert g1.timeline_start == pytest.approx(9.0)


def test_move_clips_empty_rejected(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="non-empty"):
        move_clips(ws.project, [])


def test_move_clips_tool_rejects_non_array(minimal_project):
    with pytest.raises(ValueError, match="JSON array"):
        mcp_timeline.move_clips_tool(str(minimal_project), "{}")


def test_pin_clip_source_id_keeps_valid_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    project.sources.append(SourceRecording(id="src_host", path="raw/host.wav", duration_sec=40.0))
    c1 = next(c for c in project.clips if c.id == "c1")
    c1.source_id = "src_host"
    pin_clip_source_id(project, c1)
    assert c1.source_id == "src_host"
    assert len(project.sources) == 1


def test_pin_clip_source_id_reuses_path(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    project.sources.append(SourceRecording(id="src_host", path="raw/host.wav", duration_sec=40.0))
    c1 = next(c for c in project.clips if c.id == "c1")
    pin_clip_source_id(project, c1)
    assert c1.source_id == "src_host"
    assert len(project.sources) == 1


def test_document_move_clips_rejects_non_list_payload(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="clips must be a list"):
        edit_handlers.move_clips(ws, {"clips": "nope"})


def test_pin_clip_source_id_skips_without_media(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    track = project.track_by_id("host")
    assert track is not None
    track.media = None
    c1 = next(c for c in project.clips if c.id == "c1")
    pin_clip_source_id(project, c1)
    assert c1.source_id is None


def test_move_clips_inter_track_without_media_raises(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    project = ws.project
    track = project.track_by_id("host")
    assert track is not None
    track.media = None
    with pytest.raises(ValueError, match="without origin media"):
        move_clips(
            project,
            [{"clip_id": "c1", "timeline_start": 1.0, "track_id": "guest"}],
        )


def test_edit_service_move_clips_rejects_non_object(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="object"):
        EditService(ws).move_clips(["nope"])


def test_edit_service_move_clips_empty(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="non-empty"):
        EditService(ws).move_clips([])


def test_edit_service_move_clips_unknown_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    with pytest.raises(ValueError, match="unknown clip_id"):
        EditService(ws).move_clips([{"clip_id": "nope", "timeline_start": 1.0, "track_id": "host"}])


def test_cli_move_clips(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    payload = json.dumps([{"clip_id": "c1", "timeline_start": 6.0, "track_id": "host"}])
    result = runner.invoke(
        app,
        [
            "edit",
            "move-clips",
            "--project",
            str(minimal_project),
            "--clips-json",
            payload,
        ],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    data = json.loads(result.stdout)
    assert data["operation"] == "move_clips"
    ws2 = ProjectWorkspace.open(minimal_project)
    c1 = next(c for c in ws2.project.clips if c.id == "c1")
    assert c1.timeline_start == pytest.approx(6.0)


def test_cli_move_clips_rejects_object(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_tracks(ws)
    result = runner.invoke(
        app,
        [
            "edit",
            "move-clips",
            "--project",
            str(minimal_project),
            "--clips-json",
            "{}",
        ],
    )
    assert result.exit_code != 0
