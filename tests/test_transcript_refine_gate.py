"""Transcript refine hard-gate unit tests."""

from __future__ import annotations

import json
import shutil
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
    refine_status_report,
    require_or_waive_unattended,
    reviewed_transcript_fingerprint,
    status_is_clear,
)
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    EditMode,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.pipeline.runner import PipelineRunner
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.media.transcript_refine import TranscriptRefineService
from podcast_mcp.services.pipeline.service import PipelineService

LAB_CASE = Path(__file__).parent / "fixtures" / "lab_tighten" / "caleb_um_pause"


def _lab_case(tmp_path: Path) -> ProjectWorkspace:
    shutil.copytree(LAB_CASE, tmp_path / "episode")
    return ProjectWorkspace.open(tmp_path / "episode" / "episode.project.json")


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
def test_suppression_flag_change_keeps_waiver_clear(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="host accepted", source="user")
    proj.transcripts[0].words[0].suppressed = True
    proj.transcripts[0].words[1].audibility_status = "inaudible"
    assert refine_status_report(proj)["clear"] is True


@pytest.mark.refine_gate
def test_waiver_survives_approving_a_tighten_cut(tmp_path):
    ws = _lab_case(tmp_path)
    refine = TranscriptRefineService(ws)
    refine.waive(reason="host accepted the transcript", source="user")
    PipelineService(ws).run(
        only_step="analyze_fillers_pauses", config={"tighten": {"enabled": True}}
    )
    pending = {e.reason.split(":")[0]: e.id for e in ws.project.edit_decisions if not e.applied}
    assert sorted(pending) == ["filler", "pause"]
    edits = EditService(ws)

    assert edits.approve([pending["filler"]]) == 1
    assert "Um." not in [w.text for w in ws.project.transcript_for_track("caleb").words]
    assert refine.status()["clear"] is True
    authored_fades = [
        (clip.track_id, clip.source_start, clip.fade_in_ms)
        for clip in ws.project.clips
        if clip.fade_in_ms > 0
    ]
    assert len(authored_fades) == 3
    assert edits.approve([pending["pause"]]) == 1
    assert refine.status()["clear"] is True
    assert all(
        fade in [(clip.track_id, clip.source_start, clip.fade_in_ms) for clip in ws.project.clips]
        for fade in authored_fades
    )


@pytest.mark.refine_gate
def test_waiver_survives_premix_render(tmp_path):
    ws = _lab_case(tmp_path)
    refine = TranscriptRefineService(ws)
    refine.waive(reason="host accepted the transcript", source="user")

    def suppressed() -> int:
        return sum(w.suppressed for tr in ws.project.transcripts for w in tr.words)

    assert suppressed() == 0
    assert PipelineService(ws).render_preview()["ok"] is True
    assert suppressed() == 4
    assert refine.status()["clear"] is True


@pytest.mark.refine_gate
def test_word_correction_stales_waiver(tmp_path):
    ws = _lab_case(tmp_path)
    refine = TranscriptRefineService(ws)
    refine.waive(reason="host accepted the transcript", source="user")

    EditService(ws).correct_word("caleb", 0, "Its", expected_text="It's")

    status = refine.status()
    assert (status["clear"], status["stale"]) == (False, True)
    with pytest.raises(TranscriptRefineRequiredError):
        EditService(ws).propose_tighten()


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
    assert reviewed_transcript_fingerprint(load_project(Path(path)))


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
    proj.transcripts[0].words[0].suspect_hallucination = True
    proj.transcripts[0].words[1].suspect_hallucination = True
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
    assert brief["suspect_hallucination_open_words"] == 1
    assert brief["suspect_hallucination_sample"][0]["word_index"] == 0


@pytest.mark.refine_gate
def test_brief_limits_suspect_record_materialization(minimal_project, monkeypatch):
    from podcast_mcp.edits import transcript_correct
    from podcast_mcp.edits.transcript_refine_status import build_refine_brief
    from podcast_mcp.models import TranscriptWord

    proj = _with_words(minimal_project)
    proj.transcripts[0].words = [
        TranscriptWord(text=str(i), start=float(i), end=float(i + 1), suspect_hallucination=True)
        for i in range(25)
    ]
    original = transcript_correct.transcript_word_record
    called = []

    def record(transcript, index):
        called.append(index)
        return original(transcript, index)

    monkeypatch.setattr(transcript_correct, "transcript_word_record", record)
    brief = build_refine_brief(proj)
    assert brief["suspect_hallucination_open_words"] == 25
    assert len(brief["suspect_hallucination_sample"]) == 10
    assert called == list(range(10))


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


@pytest.mark.refine_gate
def test_ripple_delete_pending_refine_prints_clean_error_not_traceback(minimal_project):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    proj = _with_words(minimal_project)
    mark_refine_pending(proj)
    save_project(proj, minimal_project)
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "edit",
            "ripple-delete",
            "--project",
            str(minimal_project),
            "--start",
            "0.0",
            "--end",
            "0.1",
        ],
    )
    assert result.exit_code == 1
    assert "Traceback" not in result.output
    assert result.stderr.startswith("Error: ")
    assert "Transcript refine is required" in result.stderr
    assert "PODCAST_DEBUG=1" in result.stderr


@pytest.mark.refine_gate
@pytest.mark.parametrize("clearance", ["done", "waived"])
def test_no_word_ripples_preserve_refine_clearance_after_reopen(minimal_project, clearance):
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    proj = _with_words(minimal_project)
    proj.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10),
        )
    ]
    proj.timeline.clips = [
        Clip(id="c", track_id="host", source_start=0, source_end=10, timeline_start=0)
    ]
    if clearance == "done":
        mark_refine_done(proj, notes="reviewed")
    else:
        mark_refine_waived(proj, reason="structural edit")
    for word in proj.transcripts[0].words:
        word.start += 3
        word.end += 3
    fingerprint = reviewed_transcript_fingerprint(proj)
    save_project(proj, minimal_project)
    EditService(ProjectWorkspace.open(minimal_project)).cut_range(
        1, 2, use_inaudible_opt=False, mode=EditMode.RIPPLE, track_ids=["host"]
    )
    reopened = ProjectWorkspace.open(minimal_project)
    assert reviewed_transcript_fingerprint(reopened.project) == fingerprint
    assert refine_status_report(reopened.project)["clear"] is True
    assert load_status(reopened.project)["status"] == clearance
    EditService(reopened).cut_range(
        0.6, 1.6, use_inaudible_opt=False, mode=EditMode.RIPPLE, track_ids=["host"]
    )
    again = load_project(minimal_project)
    assert reviewed_transcript_fingerprint(again) == fingerprint
    assert status_is_clear(again)
    assert [word.text for word in again.transcripts[0].words] == ["hello", "world"]

    from podcast_mcp.engines.session_timeline import SessionTimeline, word_source_span

    word = again.transcripts[0].words[0]
    mapped = SessionTimeline(again).map_source_span("host", *word_source_span(word.start, word.end))
    assert mapped[0][0] == pytest.approx(1.0)


@pytest.mark.refine_gate
@pytest.mark.parametrize("clearance", ["done", "waived"])
def test_word_removing_ripple_keeps_refine_clearance_after_reopen(minimal_project, clearance):
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    proj = _with_words(minimal_project)
    proj.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10),
        )
    ]
    proj.timeline.clips = [
        Clip(id="c", track_id="host", source_start=0, source_end=10, timeline_start=0)
    ]
    if clearance == "done":
        mark_refine_done(proj, notes="reviewed")
    else:
        mark_refine_waived(proj, reason="structural edit")
    save_project(proj, minimal_project)
    EditService(ProjectWorkspace.open(minimal_project)).cut_range(
        0, 0.25, use_inaudible_opt=False, mode=EditMode.RIPPLE, track_ids=["host"]
    )
    reopened = ProjectWorkspace.open(minimal_project)
    assert [word.text for word in reopened.project.transcripts[0].words] == ["world"]
    assert refine_status_report(reopened.project)["clear"] is True
    EditService(reopened).cut_range(
        1, 2, use_inaudible_opt=False, mode=EditMode.RIPPLE, track_ids=["host"]
    )
    assert load_status(reopened.project)["status"] == clearance
