from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_refine_status import (
    load_status,
    mark_refine_waived,
    precorrect_fingerprint,
)
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.pipeline import PipelineRunner


def _with_words(project_path):
    proj = load_project(project_path)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2),
                TranscriptWord(text="world", start=0.3, end=0.5),
            ],
        )
    ]
    return proj


def test_unknown_only_step_raises(minimal_project):
    proj = load_project(minimal_project)
    runner = PipelineRunner(defaults={})
    with pytest.raises(ValueError, match="unknown step"):
        runner.run(proj, only_step="not_a_step")


def test_from_step_truncates_order(minimal_project):
    load_project(minimal_project)
    runner = PipelineRunner(defaults={})
    selected = runner._select_steps(from_step="balance_tracks", only_step=None)
    names = [n for n, _ in selected]
    assert names[0] == "balance_tracks"
    assert names[-1] == "export_deliverables"


def test_only_step_single(minimal_project):
    load_project(minimal_project)
    runner = PipelineRunner(defaults={})
    selected = runner._select_steps(from_step=None, only_step="merge_transcript")
    assert len(selected) == 1
    assert selected[0][0] == "merge_transcript"


def test_runner_logs_step_on_success(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    from podcast_mcp.models import MediaAsset, Track, TrackRole, save_project

    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    proj.transcripts = []
    save_project(proj, minimal_project)
    runner = PipelineRunner(defaults={"tighten": {"filler_words": [], "max_pause_sec": 99}})
    run = runner.run(proj, only_step="merge_transcript")
    assert run.steps[0].status == "ok"
    assert run.steps[0].message is not None
    assert "utterances" in run.steps[0].message


def test_runner_progress_includes_step_summary(minimal_project, monkeypatch):
    from podcast_mcp.models import load_project
    from podcast_mcp.pipeline import runner as runner_mod
    from podcast_mcp.util.progress import NullProgress

    class CapturingProgress(NullProgress):
        def __init__(self) -> None:
            self.messages: list[str] = []

        def update(self, task_id, current, *, total=None, message=None):
            if message:
                self.messages.append(message)

    proj = load_project(minimal_project)
    progress = CapturingProgress()

    def fake_clean(project, defaults):
        return "highpass on 2 dialogue tracks"

    monkeypatch.setitem(runner_mod._STEP_MAP, "clean_audio", fake_clean)
    runner = PipelineRunner(defaults={})
    run = runner.run(proj, only_step="clean_audio", progress=progress)
    assert run.steps[0].message == "highpass on 2 dialogue tracks"
    assert any(
        m == "Completed clean_audio: highpass on 2 dialogue tracks" for m in progress.messages
    )


def test_runner_threads_cancel_check(minimal_project, monkeypatch):
    from podcast_mcp.pipeline import runner as runner_mod

    seen: dict[str, object] = {}

    def fake_clean(project, defaults):
        seen["check"] = defaults.get("_pipeline_cancel_check")
        seen["unattended"] = defaults.get("_pipeline_unattended")
        return "ok"

    monkeypatch.setitem(runner_mod._STEP_MAP, "clean_audio", fake_clean)
    proj = load_project(minimal_project)

    def not_cancelled() -> bool:
        return False

    runner = PipelineRunner(defaults={})
    runner.run(proj, only_step="clean_audio", cancel_check=not_cancelled, unattended=True)
    assert seen["check"] is not_cancelled
    assert seen["unattended"] is True


def test_runner_raises_when_cancelled_before_step(minimal_project):
    from podcast_mcp.util.progress import CancelledProgress

    proj = load_project(minimal_project)
    runner = PipelineRunner(defaults={})
    with pytest.raises(CancelledProgress, match="cancelled"):
        runner.run(proj, only_step="clean_audio", cancel_check=lambda: True)


@pytest.mark.refine_gate
def test_runner_refreshes_stale_unattended_waiver_after_success(minimal_project, monkeypatch):
    from podcast_mcp.pipeline import runner as runner_mod

    proj = _with_words(minimal_project)

    def mutate_after_gate(project, _defaults):
        project.transcripts[0].words[0].suppressed = True
        return "ok"

    monkeypatch.setattr(
        runner_mod,
        "PIPELINE_STEPS",
        [
            (name, mutate_after_gate if name == "reconcile_transcript" else fn)
            for name, fn in runner_mod.PIPELINE_STEPS
        ],
    )
    steps_after_gate = [
        name
        for name in runner_mod.STEP_NAMES
        if name not in {"require_transcript_refine", "reconcile_transcript"}
    ]

    PipelineRunner(defaults={}).run(
        proj,
        from_step="require_transcript_refine",
        skip_steps=steps_after_gate,
        unattended=True,
    )

    assert load_status(proj)["source"] == "unattended"
    assert load_status(proj)["precorrect_fingerprint"] == precorrect_fingerprint(proj)


@pytest.mark.refine_gate
def test_runner_does_not_refresh_post_gate_text_change(minimal_project, monkeypatch):
    from podcast_mcp.pipeline import runner as runner_mod

    proj = _with_words(minimal_project)

    def change_text(project, _defaults):
        project.transcripts[0].words[0].text = "hola"
        return "ok"

    monkeypatch.setattr(
        runner_mod,
        "PIPELINE_STEPS",
        [
            (name, change_text if name == "reconcile_transcript" else fn)
            for name, fn in runner_mod.PIPELINE_STEPS
        ],
    )
    skip = [
        name
        for name in runner_mod.STEP_NAMES
        if name not in {"require_transcript_refine", "reconcile_transcript"}
    ]
    PipelineRunner(defaults={}).run(
        proj, from_step="require_transcript_refine", skip_steps=skip, unattended=True
    )

    assert load_status(proj)["precorrect_fingerprint"] != precorrect_fingerprint(proj)


@pytest.mark.refine_gate
def test_runner_does_not_refresh_when_gate_mode_off(minimal_project):
    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="older run", source="unattended")
    original = load_status(proj)
    proj.transcripts[0].words[0].text = "hola"

    PipelineRunner(defaults={"analysis": {"transcript_refine": {"mode": "off"}}}).run(
        proj, only_step="require_transcript_refine", unattended=True
    )

    assert load_status(proj) == original


def test_runner_does_not_refresh_stale_unattended_waiver_without_gate(minimal_project, monkeypatch):
    from podcast_mcp.pipeline import runner as runner_mod

    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="batch", source="unattended")
    proj.transcripts[0].words[0].text = "hola"
    stale_fingerprint = load_status(proj)["precorrect_fingerprint"]
    monkeypatch.setitem(runner_mod._STEP_MAP, "clean_audio", lambda _p, _d: "ok")

    PipelineRunner(defaults={}).run(
        proj,
        only_step="clean_audio",
        unattended=True,
    )

    assert load_status(proj)["precorrect_fingerprint"] == stale_fingerprint


def test_runner_does_not_refresh_stale_unattended_waiver_after_failure(
    minimal_project, monkeypatch
):
    from podcast_mcp.pipeline import runner as runner_mod

    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="batch", source="unattended")
    proj.transcripts[0].words[0].text = "hola"
    stale_fingerprint = load_status(proj)["precorrect_fingerprint"]

    def fail(_project, _defaults):
        raise RuntimeError("step failed")

    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", fail)
    with pytest.raises(RuntimeError, match="step failed"):
        PipelineRunner(defaults={}).run(proj, only_step="merge_transcript")

    assert load_status(proj)["precorrect_fingerprint"] == stale_fingerprint


def test_runner_does_not_refresh_stale_unattended_waiver_after_cancellation(
    minimal_project,
):
    from podcast_mcp.util.progress import CancelledProgress

    proj = _with_words(minimal_project)
    mark_refine_waived(proj, reason="batch", source="unattended")
    proj.transcripts[0].words[0].text = "hola"
    stale_fingerprint = load_status(proj)["precorrect_fingerprint"]

    with pytest.raises(CancelledProgress, match="cancelled"):
        PipelineRunner(defaults={}).run(
            proj,
            only_step="clean_audio",
            cancel_check=lambda: True,
        )

    assert load_status(proj)["precorrect_fingerprint"] == stale_fingerprint
