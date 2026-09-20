"""Tests for align accept gate."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.align_accept_status import (
    AlignAcceptRequiredError,
    mark_align_done,
    mark_align_pending,
    mark_align_waived,
    require_or_waive_unattended,
    status_is_clear,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProjectMeta,
    Track,
    TrackRole,
)


def _proj(tmp_path: Path) -> EpisodeProject:
    p = EpisodeProject(meta=ProjectMeta(name="g", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="a",
            label="A",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=10.0),
        )
    )
    p.clips.append(
        Clip(id="c1", track_id="a", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    return p


def test_gate_blocks_then_done(tmp_path: Path) -> None:
    p = _proj(tmp_path)
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError):
        require_or_waive_unattended(p, defaults={"align": {"accept": {"mode": "require"}}})
    mark_align_done(p, notes="ok")
    assert status_is_clear(p)
    summary = require_or_waive_unattended(p, defaults={"align": {"accept": {"mode": "require"}}})
    assert "done" in summary


def test_unattended_waives(tmp_path: Path) -> None:
    p = _proj(tmp_path)
    mark_align_pending(p)
    summary = require_or_waive_unattended(
        p,
        defaults={
            "align": {"accept": {"mode": "waive_unattended"}},
            "_pipeline_unattended": True,
        },
    )
    assert "waived" in summary
    assert status_is_clear(p)


def test_fingerprint_stale_after_clip_move(tmp_path: Path) -> None:
    p = _proj(tmp_path)
    mark_align_done(p)
    assert status_is_clear(p)
    p.clips[0].timeline_start = 5.0
    assert not status_is_clear(p)
    mark_align_waived(p, reason="recheck")
    assert status_is_clear(p)


def test_skip_single_track_clears_require_gate(tmp_path: Path) -> None:
    from podcast_mcp.pipeline import steps

    p = _proj(tmp_path)
    p.ensure_dirs()
    summary = steps.align_tracks(p, {})
    assert "skipped" in (summary or "")
    assert status_is_clear(p)
    out = steps.require_align_accept(p, {"align": {"accept": {"mode": "require"}}})
    assert "done" in out


def test_corrupt_status_raises(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import load_status, status_path

    p = _proj(tmp_path)
    p.ensure_dirs()
    path = status_path(p)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not-json", encoding="utf-8")
    with pytest.raises(ValueError, match="corrupt"):
        load_status(p)


def test_status_report_uses_workspace_relative_paths(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import align_status_report, mark_align_pending

    p = _proj(tmp_path)
    p.ensure_dirs()
    mark_align_pending(p)
    report = align_status_report(p)
    assert not Path(report["path"]).is_absolute()
    assert report["path"].replace("\\", "/").startswith("artifacts/")


def test_align_accept_service_reloads_before_stamp(tmp_path: Path) -> None:
    from podcast_mcp.models import save_project
    from podcast_mcp.services import AlignAcceptService, ProjectWorkspace

    p = _proj(tmp_path)
    p.ensure_dirs()
    proj_path = tmp_path / "episode.project.json"
    save_project(p, proj_path)
    ws = ProjectWorkspace.open(proj_path)
    svc = AlignAcceptService(ws)
    payload = svc.mark_done(notes="ok", source="cli")
    assert payload["status"] == "done"
    assert status_is_clear(ws.project)


def test_align_mode_off_and_invalid_defaults(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import align_mode_from_defaults, align_status_report

    p = _proj(tmp_path)
    assert align_mode_from_defaults({"align": {"accept": {"mode": "nope"}}}) == "waive_unattended"
    assert require_or_waive_unattended(
        p, defaults={"align": {"accept": {"mode": "off"}}}
    ).startswith("skipped")
    mark_align_done(p)
    p.clips[0].timeline_start = 3.0
    report = align_status_report(p)
    assert report["stale"] is True
    assert report["status"] == "pending"


def test_waive_requires_reason_and_corrupt_artifact(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import align_status_report

    p = _proj(tmp_path)
    p.ensure_dirs()
    with pytest.raises(ValueError, match="reason"):
        mark_align_waived(p, reason="  ")
    artifact = p.artifacts_dir() / "alignment" / "conversation_align.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text("{bad", encoding="utf-8")
    report = align_status_report(p)
    assert report["plans"] == []


def test_align_accept_service_status_brief_waive(tmp_path: Path) -> None:
    from podcast_mcp.models import save_project
    from podcast_mcp.services import AlignAcceptService, ProjectWorkspace

    p = _proj(tmp_path)
    p.ensure_dirs()
    proj_path = tmp_path / "episode.project.json"
    save_project(p, proj_path)
    ws = ProjectWorkspace.open(proj_path)
    svc = AlignAcceptService(ws)
    mark_align_pending(ws.project)
    ws.save()
    status = svc.status()
    assert status["status"] == "pending"
    brief = svc.brief()
    assert "clips" in brief
    waived = svc.waive(reason="lab", source="cli")
    assert waived["status"] == "waived"


def test_align_cli_and_mcp_tools(tmp_path: Path) -> None:
    import json

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.mcp import server as mcp_server
    from podcast_mcp.models import load_project, save_project

    p = _proj(tmp_path)
    p.ensure_dirs()
    proj_path = tmp_path / "episode.project.json"
    mark_align_pending(p)
    save_project(p, proj_path)

    runner = CliRunner()
    assert runner.invoke(app, ["align", "status", "--project", str(proj_path)]).exit_code == 0
    assert runner.invoke(app, ["align", "brief", "--project", str(proj_path)]).exit_code == 0
    done = runner.invoke(app, ["align", "done", "--project", str(proj_path), "--notes", "ok"])
    assert done.exit_code == 0

    pending = load_project(proj_path)
    mark_align_pending(pending)
    save_project(pending, proj_path)
    waived = runner.invoke(app, ["align", "waive", "--project", str(proj_path), "--reason", "skip"])
    assert waived.exit_code == 0

    pending = load_project(proj_path)
    mark_align_pending(pending)
    save_project(pending, proj_path)
    assert json.loads(mcp_server.align_status_tool(str(proj_path)))["status"] == "pending"
    assert "clips" in json.loads(mcp_server.align_brief_tool(str(proj_path)))
    assert json.loads(mcp_server.align_done_tool(str(proj_path), notes="ok"))["status"] == "done"

    pending = load_project(proj_path)
    mark_align_pending(pending)
    save_project(pending, proj_path)
    assert (
        json.loads(mcp_server.align_waive_tool(str(proj_path), reason="mcp"))["status"] == "waived"
    )


def test_atomic_json_unreadable_and_workspace_relpath_fallback(tmp_path: Path) -> None:
    from podcast_mcp.util.atomic_json import load_json_object
    from podcast_mcp.util.workspace_paths import workspace_relpath

    p = _proj(tmp_path)
    folder = tmp_path / "not-a-file"
    folder.mkdir()
    with pytest.raises(ValueError, match="unreadable"):
        load_json_object(folder)
    outside = Path("/tmp/podcast-mcp-outside.json")
    assert workspace_relpath(p, outside) == str(outside)
