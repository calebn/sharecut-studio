from __future__ import annotations

import pytest

from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.pipeline import STEP_NAMES, PipelineRunner
from podcast_mcp.pipeline import runner as runner_mod
from podcast_mcp.pipeline.runner import _STEP_MAP, ORDERED_STEP_NAMES
from podcast_mcp.project_merge import ProjectMergeConflict


def test_pipeline_step_order():
    assert STEP_NAMES[0] == "ingest_tracks"
    assert STEP_NAMES[-1] == "export_deliverables"
    assert len(_STEP_MAP) == 20
    assert len(ORDERED_STEP_NAMES) == 21
    assert STEP_NAMES[STEP_NAMES.index("transcribe_tracks") + 1] == "align_tracks"
    assert STEP_NAMES[STEP_NAMES.index("align_tracks") + 1] == "require_align_accept"
    assert STEP_NAMES[STEP_NAMES.index("require_align_accept") + 1] == "merge_transcript"
    assert STEP_NAMES[STEP_NAMES.index("merge_transcript") + 1] == "render_dialogue_stems"
    assert STEP_NAMES[STEP_NAMES.index("render_dialogue_stems") + 1] == "reconcile_transcript"
    assert STEP_NAMES[STEP_NAMES.index("precorrect_transcript") + 1] == "require_transcript_refine"
    assert STEP_NAMES[STEP_NAMES.index("require_transcript_refine") + 1] == "analyze_focus_cuts"
    assert STEP_NAMES[STEP_NAMES.index("analyze_focus_cuts") + 1] == "focus_from_transcript"
    assert STEP_NAMES[STEP_NAMES.index("focus_from_transcript") + 1] == "analyze_fillers_pauses"
    assert STEP_NAMES[STEP_NAMES.index("assemble_timeline") + 1] == "reconcile_transcript"
    assert STEP_NAMES.count("reconcile_transcript") == 2


def test_runner_resume_from_render_dialogue_stems():
    runner = PipelineRunner(defaults={})
    selected = runner._select_steps("render_dialogue_stems", None)
    names = [name for name, _ in selected]
    assert names[0] == "render_dialogue_stems"
    assert "reconcile_transcript" in names
    assert names.index("precorrect_transcript") < names.index("require_transcript_refine")
    assert names.index("require_transcript_refine") < names.index("analyze_focus_cuts")


def test_ingest_step(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    rel = "raw/host.wav"
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=rel),
        )
    )
    save_project(proj, minimal_project)
    runner = PipelineRunner(defaults={})
    runner.run(proj, only_step="ingest_tracks")
    t = proj.track_by_id("host")
    assert t and t.media and t.media.duration_sec and t.media.duration_sec > 0


def test_runner_keeps_logging_after_a_save_swaps_the_render_section(minimal_project, monkeypatch):
    proj = load_project(minimal_project)
    monkeypatch.setattr(
        runner_mod,
        "PIPELINE_STEPS",
        [(n, (lambda _p, _d: "")) for n in runner_mod.ORDERED_STEP_NAMES],
    )
    run = PipelineRunner(defaults={}).run(
        proj,
        from_step="master_loudness",
        on_step_complete=lambda _step: setattr(proj, "render", proj.render.model_copy(deep=True)),
    )
    logs = proj.pipeline_runs[-1].steps
    assert logs[0].step == "master_loudness"
    assert logs[-1].step == "export_deliverables"
    assert all(s.finished_at for s in logs)
    assert run is proj.pipeline_runs[-1]


def test_runner_keeps_last_completed_step_when_the_step_save_conflicts(
    minimal_project, monkeypatch
):
    proj = load_project(minimal_project)
    proj.last_completed_step = "merge_transcript"
    monkeypatch.setitem(runner_mod._STEP_MAP, "master_loudness", lambda _p, _d: "")

    def conflict(_step: str) -> None:
        raise ProjectMergeConflict(["history.lineage"])

    with pytest.raises(ProjectMergeConflict):
        PipelineRunner(defaults={}).run(
            proj, only_step="master_loudness", on_step_complete=conflict
        )
    assert proj.last_completed_step == "merge_transcript"
    assert proj.pipeline_runs[-1].steps[-1].status == "error"
