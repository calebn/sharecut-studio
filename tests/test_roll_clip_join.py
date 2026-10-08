"""Tests for roll_clip_join domain op and RollClipJoin document command."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.clips_ops import roll_clip_join
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools.timeline import roll_clip_join_tool
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document.boundary import RollBoundaryTarget, boundary_context
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError


def _three_clips(ws: ProjectWorkspace) -> None:
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    # Cutaway 5..15 between c1/c2; c3 after c2 on timeline
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
            source_start=15.0,
            source_end=25.0,
            timeline_start=5.0,
        ),
        Clip(
            id="c3",
            track_id="host",
            source_start=30.0,
            source_end=40.0,
            timeline_start=15.0,
        ),
    ]
    ws.save()


def test_roll_clip_join_moves_both_edges_and_stays_flush(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    roll_clip_join(project, "c1", "c2", 2.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    c3 = next(c for c in project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(7.0)
    assert c2.source_start == pytest.approx(17.0)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    # Cutaway gap preserved (10s)
    assert c2.source_start - c1.source_end == pytest.approx(10.0)
    # Pair duration unchanged → c3 unmoved
    assert c3.timeline_start == pytest.approx(15.0)
    assert c3.source_start == pytest.approx(30.0)


def test_roll_clip_join_negative_delta(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    roll_clip_join(project, "c1", "c2", -1.5)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    c3 = next(c for c in project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(3.5)
    assert c2.source_start == pytest.approx(13.5)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    assert c3.timeline_start == pytest.approx(15.0)


def test_roll_clip_join_clamps_to_min_span(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    # Would shrink c1 below min span
    roll_clip_join(project, "c1", "c2", -100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.source_end - c1.source_start == pytest.approx(0.05)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_roll_refuses_clips_with_a_gap_between_them(minimal_project):
    """A roll keeps the pair flush, so across a gap it would pull the right clip left; refuse it."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=5.0, source_end=15.0, timeline_start=10.0),
    ]
    project = ws.project
    with pytest.raises(CodedValueError) as refused:
        roll_clip_join(project, "c1", "c2", 1.0)
    assert refused.value.code == "roll_needs_abutting_clips"
    assert [(c.source_start, c.source_end, c.timeline_start) for c in project.clips] == [
        (0.0, 5.0, 0.0),
        (5.0, 15.0, 10.0),
    ]


def test_roll_cannot_eat_past_short_right_clip(minimal_project):
    """Join later is limited by right clip duration (e.g. only 2s of content)."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=12.0,  # only 2s of content
            timeline_start=10.0,
        ),
    ]
    ws.save()
    project = ws.project
    roll_clip_join(project, "c1", "c2", 100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    # Right kept min span; join moved by ~1.95s not 100s
    assert c2.source_end - c2.source_start == pytest.approx(0.05)
    assert c1.source_end == pytest.approx(11.95)
    assert c2.source_start == pytest.approx(11.95)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_roll_cannot_eat_past_short_left_clip(minimal_project):
    """Join earlier is limited by left clip duration."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=8.0,
            source_end=10.0,  # only 2s of content
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=30.0,
            timeline_start=2.0,
        ),
    ]
    ws.save()
    project = ws.project
    roll_clip_join(project, "c1", "c2", -100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.source_end - c1.source_start == pytest.approx(0.05)
    assert c1.source_end == pytest.approx(8.05)
    assert c2.source_start == pytest.approx(8.05)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_document_roll_clip_join(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    revision = boundary_context(
        ws.project, RollBoundaryTarget(left_clip_id="c1", right_clip_id="c2")
    ).token
    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="RollClipJoin",
            payload={
                "left_clip_id": "c1",
                "right_clip_id": "c2",
                "delta_sec": 1.0,
                "expected_token": revision,
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert out["ok"]
    ws2 = ProjectWorkspace.open(minimal_project)
    c1 = next(c for c in ws2.project.clips if c.id == "c1")
    c2 = next(c for c in ws2.project.clips if c.id == "c2")
    c3 = next(c for c in ws2.project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(6.0)
    assert c2.source_start == pytest.approx(16.0)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    assert c3.timeline_start == pytest.approx(15.0)


def _rolled_edges(project_path) -> tuple[float, float, float]:
    clips = {c.id: c for c in ProjectWorkspace.open(project_path).project.clips}
    return clips["c1"].source_end, clips["c2"].source_start, clips["c3"].timeline_start


def test_roll_clip_join_tool_submits_the_document_command(minimal_project):
    _three_clips(ProjectWorkspace.open(minimal_project))
    roll_clip_join_tool(str(minimal_project), "c1", "c2", 1.5)
    assert _rolled_edges(minimal_project) == pytest.approx((6.5, 16.5, 15.0))
    rows = DocumentSyncService.open(minimal_project).store.commands_after(0)
    assert [r["type"] for r in rows] == ["RollClipJoin"]


def test_cli_roll_join_is_undoable(minimal_project):
    _three_clips(ProjectWorkspace.open(minimal_project))
    runner = CliRunner()
    args = ["--project", str(minimal_project)]
    result = runner.invoke(
        app, ["edit", "roll-join", *args, "--left", "c1", "--right", "c2", "--delta-sec", "-1"]
    )
    assert result.exit_code == 0, result.output
    assert _rolled_edges(minimal_project) == pytest.approx((4.0, 14.0, 15.0))
    assert runner.invoke(app, ["undo", *args]).exit_code == 0
    assert _rolled_edges(minimal_project) == pytest.approx((5.0, 15.0, 15.0))


ROLL_GAP_MESSAGE = (
    "These clips have a gap between them, so there is no join to roll. "
    "Move one clip to touch the other, or trim an edge instead."
)


def _gapped_pair(ws: ProjectWorkspace) -> None:
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=5.0, source_end=15.0, timeline_start=10.0),
    ]
    ws.save()


def _gap_roll_target() -> RollBoundaryTarget:
    return RollBoundaryTarget(left_clip_id="c1", right_clip_id="c2")


def _gap_roll_command_body() -> dict:
    return {
        "type": "RollClipJoin",
        "payload": {
            "left_clip_id": "c1",
            "right_clip_id": "c2",
            "delta_sec": 1.0,
            "expected_token": "any",
        },
        "client_id": "c1",
        "role": "viewer",
        "client_seq": 1,
    }


def test_roll_across_a_gap_raises_the_coded_refusal(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _gapped_pair(ws)
    with pytest.raises(CodedValueError) as refused:
        roll_clip_join(ws.project, "c1", "c2", 1.0)
    assert refused.value.code == "roll_needs_abutting_clips"
    assert str(refused.value) == ROLL_GAP_MESSAGE


def test_boundary_context_across_a_gap_raises_the_coded_refusal(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _gapped_pair(ws)
    with pytest.raises(CodedValueError) as refused:
        boundary_context(ws.project, _gap_roll_target())
    assert refused.value.code == "roll_needs_abutting_clips"
    assert str(refused.value) == ROLL_GAP_MESSAGE


def test_document_command_across_a_gap_raises_the_coded_refusal(minimal_project):
    _gapped_pair(ProjectWorkspace.open(minimal_project))
    command = DocumentCommand(**_gap_roll_command_body())
    with pytest.raises(CodedValueError) as refused:
        DocumentSyncService.open(minimal_project).submit(command)
    assert refused.value.code == "roll_needs_abutting_clips"
    assert str(refused.value) == ROLL_GAP_MESSAGE


def test_cli_roll_join_across_a_gap_prints_the_message_and_code(minimal_project):
    _gapped_pair(ProjectWorkspace.open(minimal_project))
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "roll-join",
            "--project",
            str(minimal_project),
            "--left",
            "c1",
            "--right",
            "c2",
            "--delta-sec",
            "1",
        ],
    )
    assert result.exit_code == 1
    assert f"Error: {ROLL_GAP_MESSAGE} (code roll_needs_abutting_clips)" in result.output


@pytest.mark.asyncio
async def test_mcp_roll_across_a_gap_reaches_the_agent_with_its_code(minimal_project):
    _gapped_pair(ProjectWorkspace.open(minimal_project))
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "roll_clip_join_tool",
            {
                "project_path": str(minimal_project),
                "left_clip_id": "c1",
                "right_clip_id": "c2",
                "delta_sec": 1.0,
            },
        )
    assert result.is_error
    assert result.content[0].text == ROLL_GAP_MESSAGE
    assert result.structured_content == {
        "ok": False,
        "error": ROLL_GAP_MESSAGE,
        "error_code": "roll_needs_abutting_clips",
    }


def test_boundary_context_route_sends_the_code_and_message(minimal_project):
    _gapped_pair(ProjectWorkspace.open(minimal_project))
    body = {
        "path": str(minimal_project),
        "target": _gap_roll_target().model_dump(),
        "expected_geometry": [],
    }
    with TestClient(create_app(served_project=minimal_project)) as client:
        response = client.post("/api/boundary/context", json=body)
    assert response.status_code == 400
    assert response.json() == {"detail": ROLL_GAP_MESSAGE}
    assert response.headers["x-sharecut-error-code"] == "roll_needs_abutting_clips"


def test_document_command_route_sends_the_code_and_message(minimal_project):
    _gapped_pair(ProjectWorkspace.open(minimal_project))
    with TestClient(create_app(served_project=minimal_project)) as client:
        response = client.post(
            "/api/document/command",
            params={"path": str(minimal_project)},
            json=_gap_roll_command_body(),
        )
    assert response.status_code == 400
    assert response.json() == {"detail": ROLL_GAP_MESSAGE}
    assert response.headers["x-sharecut-error-code"] == "roll_needs_abutting_clips"
