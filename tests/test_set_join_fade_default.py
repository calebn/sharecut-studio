from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService, TimelineService
from podcast_mcp.util.coded_error import CodedValueError


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _seed(minimal_project: Path) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="b", track_id="host", source_start=1, source_end=2, timeline_start=1),
    ]
    ws.save()
    return ProjectWorkspace.open(minimal_project)


def _stored(minimal_project: Path) -> int | None:
    return load_project(minimal_project).timeline.join_fade_max_ms


def test_sets_resets_and_undoes_in_one_step(minimal_project: Path) -> None:
    ws = _seed(minimal_project)
    out = TimelineService(ws).set_join_fade_default(80)
    assert (out["operation"], out["join_fade_default_ms"], out["stored_ms"]) == (
        "set_join_fade_default",
        80,
        80,
    )
    assert _stored(minimal_project) == 80
    reset = TimelineService(ws).set_join_fade_default(None)
    assert (reset["join_fade_default_ms"], reset["stored_ms"]) == (40, None)
    assert _stored(minimal_project) is None
    assert b"join_fade_max_ms" not in minimal_project.read_bytes()
    HistoryService(ws).undo()
    assert _stored(minimal_project) == 80
    HistoryService(ws).undo()
    assert _stored(minimal_project) is None


@pytest.mark.parametrize("bad", [-1, 201])
def test_refuses_values_outside_the_range_without_changing_anything(
    minimal_project: Path, bad: int
) -> None:
    ws = _seed(minimal_project)
    before = minimal_project.read_bytes()
    with pytest.raises(CodedValueError) as err:
        TimelineService(ws).set_join_fade_default(bad)
    assert err.value.code == "out_of_range"
    assert minimal_project.read_bytes() == before


def test_changes_no_stem_and_writes_no_invalidation(minimal_project: Path) -> None:
    ws = _seed(minimal_project)
    fingerprint = audio_state_fingerprint
    from podcast_mcp.engines.play_audit import dialogue_render_hashes

    config = ws.effective_config()
    before = fingerprint(
        ws.project, dialogue_render_hashes(ws.project, defaults=config), defaults=config
    )
    fresh = stem_is_fresh(ws.project, "host", defaults=config)
    TimelineService(ws).set_join_fade_default(120)
    after = fingerprint(
        ws.project, dialogue_render_hashes(ws.project, defaults=config), defaults=config
    )
    assert after == before
    assert stem_is_fresh(ws.project, "host", defaults=config) == fresh
    assert ws.project.render.invalidations == []
    assert [c.fade_in_ms for c in ws.project.clips] == [0, 0]


def test_the_automatic_writers_read_the_saved_default(minimal_project: Path) -> None:
    ws = _seed(minimal_project)
    TimelineService(ws).set_join_fade_default(90)
    out = TimelineService(ws).fade_joins(fade_ms=200)
    assert (out["fade_ms"], out["cap_ms"]) == (90, 90)
    assert [c.fade_in_ms for c in load_project(minimal_project).clips] == [0, 90]


def test_list_clips_reports_the_effective_default(minimal_project: Path) -> None:
    ws = _seed(minimal_project)
    assert TimelineService(ws).list_clips()["join_fade_default_ms"] == 40
    TimelineService(ws).set_join_fade_default(65)
    assert TimelineService(ws).list_clips()["join_fade_default_ms"] == 65


def test_payload_accepts_null_and_refuses_out_of_range() -> None:
    from podcast_mcp.services.document_sync.payloads import validate_payload

    validate_payload("SetJoinFadeDefault", {"ms": 0})
    validate_payload("SetJoinFadeDefault", {"ms": 200})
    validate_payload("SetJoinFadeDefault", {"ms": None})
    for bad in ({}, {"ms": -1}, {"ms": 201}, {"ms": 1.5}, {"ms": "x"}):
        with pytest.raises(ValidationError):
            validate_payload("SetJoinFadeDefault", bad)


def test_document_command_applies_and_refreshes_the_clips_slice(minimal_project: Path) -> None:
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.document_sync.projection_types import ViewProjection
    from podcast_mcp.services.document_sync.projections import projection_for_command

    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    result = svc.submit(
        DocumentCommand(
            type="SetJoinFadeDefault",
            client_id="c",
            role="editor",
            client_seq=1,
            payload={"ms": 55},
        )
    )
    assert result["ok"] is True
    assert _stored(minimal_project) == 55
    assert projection_for_command("SetJoinFadeDefault") is ViewProjection.CLIPS
    assert _clips_slice(minimal_project)["clips"]["join_fade_default_ms"] == 55


def _clips_slice(project: Path) -> dict:
    from podcast_mcp.gui.assembler import dump_project_projection
    from podcast_mcp.services.document_sync.projection_types import ViewProjection

    return dump_project_projection(project, projection=ViewProjection.CLIPS)


def test_the_clips_slice_carries_the_default_in_force(minimal_project: Path) -> None:
    ws = _seed(minimal_project)
    assert _clips_slice(minimal_project)["clips"]["join_fade_default_ms"] == 40
    TimelineService(ws).set_join_fade_default(0)
    assert _clips_slice(minimal_project)["clips"]["join_fade_default_ms"] == 0
    TimelineService(ws).set_join_fade_default(None)
    assert _clips_slice(minimal_project)["clips"]["join_fade_default_ms"] == 40


def test_registry_row_names_the_tool_and_the_cli() -> None:
    from podcast_mcp.services.collaboration import ReviewRole
    from podcast_mcp.services.document_sync.registry import COMMANDS, named

    spec = COMMANDS["SetJoinFadeDefault"]
    assert spec.guest is ReviewRole.EDITOR
    assert spec.mcp == named("set_join_fade_default_tool")
    assert spec.cli == named("podcast episode set-join-fade-default")


def test_mcp_tool_sets_and_resets(minimal_project: Path) -> None:
    from podcast_mcp.mcp.server import mcp
    from podcast_mcp.mcp.tools.timeline import set_join_fade_default_tool

    _seed(minimal_project)
    assert "set_join_fade_default_tool" in {t.name for t in mcp._tool_manager.list_tools()}
    out = json.loads(set_join_fade_default_tool(str(minimal_project), 70))
    assert _stored(minimal_project) == 70
    assert out["join_fade_default_ms"] == 70
    json.loads(set_join_fade_default_tool(str(minimal_project), None))
    assert _stored(minimal_project) is None
    with pytest.raises((CodedValueError, ValidationError)):
        set_join_fade_default_tool(str(minimal_project), 500)
    assert _stored(minimal_project) is None


def test_cli_sets_and_resets(minimal_project: Path) -> None:
    _seed(minimal_project)
    runner = CliRunner()
    base = ["episode", "set-join-fade-default", "--project", str(minimal_project)]
    done = runner.invoke(app, [*base, "--ms", "75"])
    assert done.exit_code == 0, done.output
    assert json.loads(done.output)["join_fade_default_ms"] == 75
    assert _stored(minimal_project) == 75
    reset = runner.invoke(app, [*base, "--reset"])
    assert reset.exit_code == 0, reset.output
    assert _stored(minimal_project) is None
    for args in ([], ["--ms", "5", "--reset"], ["--ms", "500"]):
        failed = runner.invoke(app, [*base, *args])
        assert failed.exit_code != 0
    assert _stored(minimal_project) is None
