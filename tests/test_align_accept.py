"""Tests for align accept gate."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.align_accept_status import (
    AlignAcceptRequiredError,
    align_artifact_path,
    align_status_report,
    alignment_drift_report,
    large_align_moves,
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


def test_cli_pipeline_run_realign_passes_config(tmp_path: Path, monkeypatch) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.services import PipelineService

    seen: list[dict | None] = []

    def fake_run(self, **kwargs):  # type: ignore[no-untyped-def]
        seen.append(kwargs.get("config"))
        return "done"

    monkeypatch.setattr(PipelineService, "run", fake_run)
    proj = _proj(tmp_path)
    path = tmp_path / "episode.project.json"
    from podcast_mcp.models.episode import save_project

    save_project(proj, path)
    runner = CliRunner()
    assert (
        runner.invoke(app, ["pipeline", "run", "--project", str(path), "--realign"]).exit_code == 0
    )
    assert runner.invoke(app, ["pipeline", "run", "--project", str(path)]).exit_code == 0
    assert seen == [{"align": {"realign": True}}, None]


def _write_plans(p: EpisodeProject, offset: float, method: str = "bleed") -> None:
    from podcast_mcp.edits.conversation_align import (
        AlignResult,
        ClipAlignPlan,
        write_alignment_artifact,
    )

    write_alignment_artifact(
        p,
        AlignResult(
            plans=[
                ClipAlignPlan(track_id="host", clip_id="c0", offset_sec=0.0, method="reference"),
                ClipAlignPlan(track_id="guest", clip_id="c1", offset_sec=offset, method=method),
            ],
            reference_track_id="host",
        ),
    )


def test_unattended_refuses_to_waive_large_move(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import load_status

    p = _proj(tmp_path)
    _write_plans(p, -35.6)
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError, match="will not auto-waive") as exc:
        require_or_waive_unattended(p, unattended=True)
    assert "guest" in str(exc.value)
    assert (load_status(p) or {})["status"] == "pending"


def test_unattended_waives_small_move(tmp_path: Path) -> None:
    p = _proj(tmp_path)
    _write_plans(p, 0.4)
    mark_align_pending(p)
    assert require_or_waive_unattended(p, unattended=True) == "waived (unattended)"


def test_status_report_lists_large_moves(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import align_status_report

    p = _proj(tmp_path)
    _write_plans(p, 7.0)
    report = align_status_report(p)
    assert report["large_move_sec"] == 1.0
    assert [m["track_id"] for m in report["large_moves"]] == ["guest"]


def _two_track(tmp_path: Path, guest_start: float = 35.6) -> EpisodeProject:
    p = EpisodeProject(meta=ProjectMeta(name="g2", workspace_dir=str(tmp_path)))
    for tid in ("host", "guest"):
        p.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=100.0),
            )
        )
        p.clips.append(
            Clip(
                id=f"clip_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=100.0,
                timeline_start=guest_start if tid == "guest" else 0.0,
            )
        )
    return p


def _write_two_track_plans(p: EpisodeProject, method: str = "bleed", offset: float = 35.6) -> None:
    from podcast_mcp.edits.conversation_align import (
        AlignResult,
        ClipAlignPlan,
        write_alignment_artifact,
    )

    write_alignment_artifact(
        p,
        AlignResult(
            plans=[
                ClipAlignPlan(
                    track_id="host", clip_id="clip_host", offset_sec=0.0, method="reference"
                ),
                ClipAlignPlan(
                    track_id="guest", clip_id="clip_guest", offset_sec=offset, method=method
                ),
            ],
            reference_track_id="host",
        ),
    )


def test_drift_report_unchecked_without_artifact(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import alignment_drift_report

    report = alignment_drift_report(_two_track(tmp_path))
    assert report["checked"] is False
    assert report["issues"] == []


def test_drift_report_issue_when_waived_unattended(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import alignment_drift_report, write_status

    p = _two_track(tmp_path)
    _write_two_track_plans(p)
    write_status(p, status="waived", source="unattended")
    report = alignment_drift_report(p)
    assert report["checked"] is True
    assert len(report["issues"]) == 1
    assert "guest" in report["issues"][0]
    assert "waived by unattended" in report["issues"][0]


def test_drift_report_clear_when_done(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import alignment_drift_report

    p = _two_track(tmp_path)
    _write_two_track_plans(p)
    mark_align_done(p)
    report = alignment_drift_report(p)
    assert report["issues"] == []
    assert report["accepted"] is True
    assert report["tracks"]["guest"] == pytest.approx(35.6, abs=0.01)


@pytest.mark.parametrize("method", ["hold", "manual"])
def test_drift_report_skips_locked_tracks(tmp_path: Path, method: str) -> None:
    from podcast_mcp.edits.align_accept_status import alignment_drift_report

    p = _two_track(tmp_path)
    _write_two_track_plans(p, method=method)
    assert alignment_drift_report(p)["issues"] == []


def test_drift_report_warning_when_mode_off(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import alignment_drift_report

    p = _two_track(tmp_path)
    _write_two_track_plans(p)
    report = alignment_drift_report(p, defaults={"align": {"accept": {"mode": "off"}}})
    assert report["issues"] == []
    assert len(report["warnings"]) == 1


def test_write_export_qc_reports_alignment_issue(tmp_path: Path) -> None:
    from podcast_mcp.pipeline import steps

    p = _two_track(tmp_path)
    _write_two_track_plans(p)
    mark_align_pending(p)
    qc = steps.write_export_qc(p)
    assert qc["alignment"]["checked"] is True
    assert any("off the reference clock" in i for i in qc["issues"])
    assert qc["ok"] is False


def _write_unconfirmed(p: EpisodeProject, candidate: float, *, clip_id: str = "c1") -> None:
    from podcast_mcp.edits.conversation_align import (
        AlignResult,
        ClipAlignPlan,
        write_alignment_artifact,
    )

    write_alignment_artifact(
        p,
        AlignResult(
            plans=[
                ClipAlignPlan(track_id="host", clip_id="c0", offset_sec=0.0, method="reference"),
                ClipAlignPlan(
                    track_id="guest",
                    clip_id=clip_id,
                    offset_sec=0.0,
                    method="unconfirmed_hold",
                    candidate_offset_sec=candidate,
                    acoustic_confirmed=False,
                ),
            ],
            reference_track_id="host",
        ),
    )


def test_unattended_refuses_to_waive_unconfirmed_hold(tmp_path: Path) -> None:
    from podcast_mcp.edits.align_accept_status import load_status

    p = _proj(tmp_path)
    _write_unconfirmed(p, 40.0)
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError, match=r"guest \+40\.00s \(unconfirmed_hold\)"):
        require_or_waive_unattended(p, unattended=True)
    assert (load_status(p) or {})["status"] == "pending"


def test_status_report_lists_unconfirmed_hold(tmp_path: Path) -> None:
    p = _proj(tmp_path)
    _write_unconfirmed(p, 40.0)
    assert [m["method"] for m in align_status_report(p)["large_moves"]] == ["unconfirmed_hold"]


@pytest.mark.parametrize("method", ["hold", "manual"])
def test_large_align_moves_ignores_locked(method: str) -> None:
    assert large_align_moves([{"method": method, "offset_sec": 5.0}], threshold=1.0) == []


def test_unreadable_artifact_blocks_unattended_and_fails_qc(tmp_path: Path) -> None:
    p = _two_track(tmp_path)
    path = align_artifact_path(p)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{bad", encoding="utf-8")
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError, match="unreadable"):
        require_or_waive_unattended(p, unattended=True)
    report = alignment_drift_report(p)
    assert report["checked"] is False
    assert any("unreadable" in i for i in report["issues"])
    off = alignment_drift_report(p, defaults={"align": {"accept": {"mode": "off"}}})
    assert off["warnings"]


def test_status_report_uses_artifact_threshold(tmp_path: Path) -> None:
    from podcast_mcp.edits.conversation_align import (
        AlignResult,
        ClipAlignPlan,
        write_alignment_artifact,
    )

    p = _proj(tmp_path)
    write_alignment_artifact(
        p,
        AlignResult(
            plans=[
                ClipAlignPlan(track_id="host", clip_id="c0", offset_sec=0.0, method="reference"),
                ClipAlignPlan(track_id="guest", clip_id="c1", offset_sec=2.0, method="bleed"),
            ],
            reference_track_id="host",
            large_move_sec=3.0,
        ),
    )
    report = align_status_report(p)
    assert report["large_move_sec"] == 3.0
    assert report["large_moves"] == []


def test_drift_report_locked_exemption_is_per_clip(tmp_path: Path) -> None:
    from podcast_mcp.edits.conversation_align import (
        AlignResult,
        ClipAlignPlan,
        write_alignment_artifact,
    )

    p = _two_track(tmp_path, guest_start=0.0)
    p.clips = [c for c in p.clips if c.track_id != "guest"] + [
        Clip(id="g1", track_id="guest", source_start=0, source_end=50, timeline_start=0),
        Clip(id="g2", track_id="guest", source_start=50, source_end=100, timeline_start=85.6),
    ]
    write_alignment_artifact(
        p,
        AlignResult(
            plans=[
                ClipAlignPlan(
                    track_id="host", clip_id="clip_host", offset_sec=0.0, method="reference"
                ),
                ClipAlignPlan(track_id="guest", clip_id="g1", offset_sec=0.0, method="hold"),
                ClipAlignPlan(track_id="guest", clip_id="g2", offset_sec=35.6, method="bleed"),
            ],
            reference_track_id="host",
        ),
    )
    mark_align_pending(p)
    assert len(alignment_drift_report(p)["issues"]) == 1


def test_drift_report_flags_held_track_moved_after_align(tmp_path: Path) -> None:
    p = _two_track(tmp_path, guest_start=0.0)
    _write_two_track_plans(p, method="hold", offset=0.0)
    mark_align_pending(p)
    assert alignment_drift_report(p)["issues"] == []
    next(c for c in p.clips if c.track_id == "guest").timeline_start = 35.6
    assert len(alignment_drift_report(p)["issues"]) == 1


def test_drift_report_flags_manual_track_moved_after_align(tmp_path: Path) -> None:
    p = _two_track(tmp_path, guest_start=3.0)
    _write_two_track_plans(p, method="manual", offset=3.0)
    mark_align_pending(p)
    assert alignment_drift_report(p)["issues"] == []
    next(c for c in p.clips if c.track_id == "guest").timeline_start = 20.0
    assert len(alignment_drift_report(p)["issues"]) == 1


def test_drift_report_says_accept_is_stale(tmp_path: Path) -> None:
    p = _two_track(tmp_path)
    _write_two_track_plans(p)
    mark_align_done(p)
    assert alignment_drift_report(p)["issues"] == []
    next(c for c in p.clips if c.track_id == "guest").timeline_start = 35.0
    issues = alignment_drift_report(p)["issues"]
    assert len(issues) == 1
    assert "accept is stale" in issues[0]
    assert "not accepted by a person" not in issues[0]


def test_drift_report_flags_unconfirmed_hold_until_done(tmp_path: Path) -> None:
    from podcast_mcp.pipeline import steps

    p = _two_track(tmp_path, guest_start=0.0)
    _write_unconfirmed(p, 40.0, clip_id="clip_guest")
    mark_align_pending(p)
    issues = alignment_drift_report(p)["issues"]
    assert len(issues) == 1
    assert "unconfirmed +40.0s" in issues[0]
    assert steps.write_export_qc(p)["ok"] is False
    mark_align_done(p)
    assert alignment_drift_report(p)["issues"] == []


def test_unattended_small_moves_pass_export_qc(tmp_path: Path) -> None:
    p = _two_track(tmp_path, guest_start=0.4)
    _write_two_track_plans(p, offset=0.4)
    mark_align_pending(p)
    assert require_or_waive_unattended(p, unattended=True) == "waived (unattended)"
    assert alignment_drift_report(p)["issues"] == []


def test_unattended_gate_stops_on_kept_placement_drift(tmp_path: Path) -> None:
    p = _two_track(tmp_path, guest_start=3.0)
    _write_two_track_plans(p, method="weak_hold", offset=0.0)
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError, match=r"guest 3\.00s off the reference"):
        require_or_waive_unattended(p, unattended=True)


def test_gui_fail_message_keeps_align_gate_listing(tmp_path: Path) -> None:
    from podcast_mcp.gui.jobs import _gui_fail_message

    p = _proj(tmp_path)
    _write_plans(p, -35.6)
    mark_align_pending(p)
    with pytest.raises(AlignAcceptRequiredError) as exc:
        require_or_waive_unattended(p, unattended=True)
    shown = _gui_fail_message(str(exc.value)) or ""
    assert "guest -35.60s (bleed)" in shown
    assert shown.startswith("Unattended run will not auto-waive")
