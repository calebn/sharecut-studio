"""Transcript refine hard-gate unit tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.edits.transcript_refine_status import (
    TranscriptRefineRequiredError,
    assert_refine_clear,
    load_status,
    mark_refine_done,
    mark_refine_pending,
    mark_refine_waived,
    precorrect_fingerprint,
    refine_status_report,
    refresh_unattended_waiver,
    require_or_waive_unattended,
    status_is_clear,
)
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.pipeline.runner import PipelineRunner
from podcast_mcp.services import EditService, ProjectWorkspace, TranscriptRefineService


def _with_words(minimal_project: Path) -> object:
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2),
                TranscriptWord(text="world", start=0.3, end=0.5),
            ],
        )
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


@pytest.mark.refine_gate
def test_precorrect_apply_resets_refine_pending(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_done(proj, notes="prior")
    assert status_is_clear(proj)
    run_precorrect_transcript(proj, dry_run=False)
    report = refine_status_report(proj)
    assert report["status"] == "pending"
    assert not report["clear"]
    assert not Path(report["path"]).is_absolute()


@pytest.mark.refine_gate
def test_fingerprint_stale_after_text_change(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_done(proj, notes="done")
    assert status_is_clear(proj)
    proj.transcripts[0].words[0].text = "hola"
    assert not status_is_clear(proj)
    report = refine_status_report(proj)
    assert report["status"] == "pending"
    assert report["stale"] is True


@pytest.mark.refine_gate
def test_refreshes_stale_unattended_waiver(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="batch", source="unattended")
    original = load_status(proj)
    proj.transcripts[0].words[0].text = "hola"

    assert refresh_unattended_waiver(proj) is True
    refreshed = load_status(proj)
    assert refreshed is not None
    assert refreshed["status"] == "waived"
    assert refreshed["source"] == "unattended"
    assert refreshed["notes"] == original["notes"]
    assert refreshed["precorrect_fingerprint"] == precorrect_fingerprint(proj)
    assert status_is_clear(proj)


@pytest.mark.refine_gate
@pytest.mark.parametrize(
    ("status", "source"),
    [
        ("pending", "precorrect"),
        ("done", "agent"),
        ("done", "unattended"),
        ("waived", "user"),
        ("waived", "cli"),
        ("waived", "mcp"),
    ],
)
def test_refresh_does_not_change_non_unattended_waivers_or_pending(minimal_project, status, source):
    proj = _with_words(minimal_project)
    if status == "pending":
        mark_refine_pending(proj, source=source)
    elif status == "done":
        mark_refine_done(proj, source=source)
    else:
        mark_refine_waived(proj, reason="explicit", source=source)
    before = load_status(proj)
    proj.transcripts[0].words[0].text = "hola"

    assert refresh_unattended_waiver(proj) is False
    assert load_status(proj) == before


@pytest.mark.refine_gate
def test_refresh_does_not_rewrite_current_unattended_waiver(minimal_project, monkeypatch):
    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="batch", source="unattended")

    import podcast_mcp.edits.transcript_refine_status as refine_mod

    monkeypatch.setattr(refine_mod, "_write_status", pytest.fail)
    assert refresh_unattended_waiver(proj) is False


@pytest.mark.refine_gate
def test_require_step_fails_interactive_pending(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    defaults = {"analysis": {"transcript_refine": {"mode": "waive_unattended"}}}
    with pytest.raises(TranscriptRefineRequiredError):
        steps.require_transcript_refine(proj, defaults)


@pytest.mark.refine_gate
def test_require_step_auto_waives_unattended(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    defaults = {
        "analysis": {"transcript_refine": {"mode": "waive_unattended"}},
        "_pipeline_unattended": True,
    }
    summary = steps.require_transcript_refine(proj, defaults)
    assert summary == "waived (unattended)"
    assert status_is_clear(proj)


@pytest.mark.refine_gate
def test_require_step_passes_when_done(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_done(proj, notes="ok")
    defaults = {"analysis": {"transcript_refine": {"mode": "require"}}}
    summary = steps.require_transcript_refine(proj, defaults)
    assert "done" in summary


@pytest.mark.refine_gate
def test_require_mode_always_blocks_even_unattended(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    defaults = {
        "analysis": {"transcript_refine": {"mode": "require"}},
        "_pipeline_unattended": True,
    }
    with pytest.raises(TranscriptRefineRequiredError):
        require_or_waive_unattended(proj, defaults=defaults, unattended=True)


@pytest.mark.refine_gate
def test_mode_off_skips(minimal_project):
    proj = _with_words(minimal_project)
    defaults = {"analysis": {"transcript_refine": {"mode": "off"}}}
    assert steps.require_transcript_refine(proj, defaults).startswith("skipped")
    assert_refine_clear(proj, defaults=defaults)


@pytest.mark.refine_gate
def test_edit_service_blocked_when_pending(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(TranscriptRefineRequiredError):
        EditService(ws).propose_tighten()


@pytest.mark.refine_gate
def test_edit_service_allowed_when_done(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_done(proj)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    EditService(ws).propose_tighten()


@pytest.mark.refine_gate
def test_focus_step_blocked_when_pending(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    defaults = {
        "analysis": {"transcript_refine": {"mode": "require"}},
        "focus": {"enabled": False},
    }
    with pytest.raises(TranscriptRefineRequiredError):
        steps.analyze_focus_cuts(proj, defaults)


@pytest.mark.refine_gate
def test_runner_unattended_flag_waives(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    runner = PipelineRunner(
        defaults={"analysis": {"transcript_refine": {"mode": "waive_unattended"}}}
    )
    run = runner.run(proj, only_step="require_transcript_refine", unattended=True)
    assert run.steps[0].status == "ok"
    assert "waived" in (run.steps[0].message or "")


@pytest.mark.refine_gate
def test_cli_service_done_waive_brief(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = TranscriptRefineService(ws)
    brief = svc.brief()
    assert "status" in brief
    assert brief["word_counts"]["host"] == 2
    done = svc.mark_done(notes="episode pass", source="cli")
    assert done["status"] == "done"
    assert svc.status()["clear"] is True
    mark_refine_pending(ws.project)
    waived = svc.waive(reason="fixture", source="cli")
    assert waived["status"] == "waived"


@pytest.mark.refine_gate
def test_waive_requires_reason(minimal_project):
    proj = _with_words(minimal_project)
    with pytest.raises(ValueError, match="reason"):
        mark_refine_waived(proj, reason="  ")


@pytest.mark.refine_gate
def test_mcp_refine_tools(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "refine_ws"))
    proj = load_project(Path(path))
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.1)],
        )
    ]
    mark_refine_pending(proj)
    save_project(proj, Path(path))
    status = json.loads(mcp_server.transcript_refine_status_tool(path))
    assert status["status"] == "pending"
    brief = json.loads(mcp_server.transcript_refine_brief_tool(path))
    assert "deferred_queue_count" in brief
    done = json.loads(mcp_server.transcript_refine_done_tool(path, notes="ok"))
    assert done["status"] == "done"
    clear = json.loads(mcp_server.transcript_refine_status_tool(path))
    assert clear["clear"] is True

    proj2 = load_project(Path(path))
    mark_refine_pending(proj2)
    save_project(proj2, Path(path))
    waived = json.loads(mcp_server.transcript_refine_waive_tool(path, reason="test waive"))
    assert waived["status"] == "waived"
    assert precorrect_fingerprint(load_project(Path(path)))


@pytest.mark.refine_gate
def test_invalid_mode_defaults_to_waive_unattended(minimal_project):
    from podcast_mcp.edits.transcript_refine_status import refine_mode_from_defaults

    assert refine_mode_from_defaults({"analysis": {"transcript_refine": {"mode": "nope"}}}) == (
        "waive_unattended"
    )


@pytest.mark.refine_gate
def test_is_unattended_env(monkeypatch, minimal_project):
    from podcast_mcp.edits.transcript_refine_status import is_unattended

    monkeypatch.delenv("PODCAST_BATCH", raising=False)
    assert is_unattended() is False
    monkeypatch.setenv("PODCAST_BATCH", "1")
    assert is_unattended() is True


@pytest.mark.refine_gate
def test_load_status_corrupt_and_non_dict(minimal_project):
    from podcast_mcp.edits.transcript_refine_status import load_status, status_path

    proj = _with_words(minimal_project)
    path = status_path(proj)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not-json", encoding="utf-8")
    with pytest.raises(ValueError, match="corrupt"):
        load_status(proj)
    path.write_text("[1,2]", encoding="utf-8")
    with pytest.raises(ValueError, match="JSON object"):
        load_status(proj)


@pytest.mark.refine_gate
def test_brief_reads_precorrect_report_and_low_conf(minimal_project):
    from podcast_mcp.edits.transcript_refine_status import build_refine_brief

    proj = _with_words(minimal_project)
    proj.transcripts[0].words[0].confidence = 0.2
    proj.transcripts[0].words[1].suppressed = True
    art = proj.artifacts_dir()
    art.mkdir(parents=True, exist_ok=True)
    (art / "transcript_precorrect_report.json").write_text(
        json.dumps(
            {
                "deferred_queue": [{"kind": "low_similarity"}],
                "garble_hits": [{"text": "x"}],
            }
        ),
        encoding="utf-8",
    )
    (art / "transcript_precorrect_report.json").write_text(
        "{bad",
        encoding="utf-8",
    )
    brief_bad = build_refine_brief(proj)
    assert brief_bad["deferred_queue_count"] == 0
    (art / "transcript_precorrect_report.json").write_text(
        json.dumps(
            {
                "deferred_queue": [{"kind": "low_similarity"}],
                "garble_hits": [{"text": "x"}],
            }
        ),
        encoding="utf-8",
    )
    brief = build_refine_brief(proj)
    assert brief["deferred_queue_count"] == 1
    assert brief["garble_hits_count"] == 1
    assert brief["low_confidence_open_words"] == 1


@pytest.mark.refine_gate
def test_service_assert_clear_and_cli(minimal_project):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(TranscriptRefineRequiredError):
        assert_refine_clear(ws.project)
    runner = CliRunner()
    assert (
        runner.invoke(
            app, ["transcript", "refine-status", "--project", str(minimal_project)]
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            app, ["transcript", "refine-brief", "--project", str(minimal_project)]
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            app,
            [
                "transcript",
                "refine-done",
                "--project",
                str(minimal_project),
                "--notes",
                "ok",
            ],
        ).exit_code
        == 0
    )
    p = load_project(minimal_project)
    mark_refine_pending(p)
    save_project(p, minimal_project)
    assert (
        runner.invoke(
            app,
            [
                "transcript",
                "refine-waive",
                "--project",
                str(minimal_project),
                "--reason",
                "batch",
            ],
        ).exit_code
        == 0
    )
    p2 = load_project(minimal_project)
    mark_refine_pending(p2)
    save_project(p2, minimal_project)
    assert (
        runner.invoke(
            app,
            [
                "pipeline",
                "run",
                "--project",
                str(minimal_project),
                "--only",
                "require_transcript_refine",
                "--unattended",
            ],
        ).exit_code
        == 0
    )
