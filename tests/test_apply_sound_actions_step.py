"""The pipeline applies each non-speech sound's suggested action by default (#1434)."""

from __future__ import annotations

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import suggested_actions
from podcast_mcp.edits.acoustic_gap import AcousticGapConfig
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    PipelineRun,
    PipelineStepLog,
    Track,
    TrackRole,
    load_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.pipeline.meta import step_noop_reason
from podcast_mcp.services.pipeline.config import default_enabled_steps


def _decision(did: str, reason: str, start: float) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=start + 0.3,
        reason=reason,
        applied=False,
    )


@pytest.fixture
def sounds_project(minimal_project):
    project = load_project(minimal_project)
    audio = room(seconds=10)
    voice(audio, 0, 0.8)
    voice(audio, 9.2, 9.8)
    audio[16000:144000] = 0
    write_wav(project.workspace_path() / "raw/host.wav", audio)
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    project.edit_decisions = [
        _decision("um", "filler:um", 1.0),
        _decision("laugh", "filler:acoustic:likely_laugh", 3.0),
        _decision("unclear", "filler:acoustic", 5.0),
    ]
    return project


def test_the_defaults_apply_sounds_without_turning_tighten_on():
    defaults = load_defaults()
    assert defaults["tighten"]["enabled"] is False
    assert defaults["tighten"]["apply_non_speech"] is True
    assert step_noop_reason("apply_sound_actions", defaults) is None
    assert "apply_sound_actions" in default_enabled_steps(defaults)
    assert "tighten_from_transcript" not in default_enabled_steps(defaults)


def test_turning_the_setting_off_leaves_every_sound_pending(sounds_project):
    defaults = load_defaults()
    defaults["tighten"]["apply_non_speech"] = False
    assert (
        steps.apply_sound_actions(sounds_project, defaults)
        == "skipped (tighten.apply_non_speech=false)"
    )
    assert "apply_sound_actions" not in default_enabled_steps(defaults)
    assert [e.id for e in sounds_project.edit_decisions if not e.applied] == [
        "um",
        "laugh",
        "unclear",
    ]


def _analysis_ran_in_this_run(project, message: str = "3 proposed") -> None:
    project.pipeline_runs.append(
        PipelineRun(
            id="run",
            started_at="2026-10-19T00:00:00+00:00",
            steps=[
                PipelineStepLog(
                    step="analyze_fillers_pauses",
                    started_at="2026-10-19T00:00:00+00:00",
                    message=message,
                ),
                PipelineStepLog(step="apply_sound_actions", started_at="2026-10-19T00:00:01+00:00"),
            ],
        )
    )


def test_the_step_acts_on_sounds_and_leaves_spoken_proposals_pending(sounds_project, monkeypatch):
    # Tighten analysis ran in this run, so the step uses the proposals it just left.
    defaults = load_defaults()
    defaults["tighten"]["enabled"] = True
    _analysis_ran_in_this_run(sounds_project)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert summary == "Applied 1 lower, 1 leave."
    assert [e.id for e in sounds_project.edit_decisions if not e.applied] == ["um"]
    (clip,) = sounds_project.clips
    assert [(r.start_s, r.gain_db) for r in clip.mute_regions] == [(3.0, -12.0)]


def test_with_tighten_off_the_step_looks_for_sounds_itself(sounds_project, monkeypatch):
    defaults = load_defaults()
    found = [_decision("laugh2", "filler:acoustic:likely_laugh", 7.0)]
    seen = {}

    def propose(project, cfg, *, replace_existing, **_kw):
        seen["replace_existing"] = replace_existing
        return type("Proposal", (), {"decisions": [*found, _decision("um2", "filler:um", 8.0)]})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert seen == {"replace_existing": True}
    assert summary == "Applied 1 lower."
    # The scan's spoken filler was dropped and the sounds it replaced are gone; the old filler stays.
    assert sorted(e.id for e in sounds_project.edit_decisions if not e.applied) == ["um"]


def test_with_tighten_off_the_scan_skips_the_word_probe(sounds_project, monkeypatch):
    defaults = load_defaults()
    seen = {}

    def propose(project, cfg, *, replace_existing, **_kw):
        seen["word_probe"] = AcousticGapConfig.from_tighten(cfg.get("tighten")).word_probe
        seen["caller_word_probe"] = AcousticGapConfig.from_tighten(
            defaults.get("tighten")
        ).word_probe
        return type("Proposal", (), {"decisions": []})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert summary == "no non-speech sounds to act on"
    assert seen == {"word_probe": False, "caller_word_probe": True}


def test_with_tighten_off_the_scan_shares_its_repeat_reads(sounds_project, monkeypatch):
    from podcast_mcp.util import batch_scope

    seen = {}

    def propose(project, cfg, *, replace_existing, **_kw):
        seen["state"] = batch_scope.snapshot()
        return type("Proposal", (), {"decisions": []})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)

    steps.apply_sound_actions(sounds_project, load_defaults())

    scope, block = seen["state"]
    assert scope is not None and block is not None
    assert batch_scope.snapshot() == (None, None)


def _stale_run_then_scan(monkeypatch, sounds_project, found):
    seen = {"scans": 0}

    def propose(project, cfg, *, replace_existing, **_kw):
        seen["scans"] += 1
        return type("Proposal", (), {"decisions": found})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **__: True)
    return seen


def test_with_tighten_on_but_analysis_not_run_the_step_ignores_stale_proposals(
    sounds_project, monkeypatch
):
    # ``--from apply_sound_actions``: the proposals on the project come from an earlier run.
    defaults = load_defaults()
    defaults["tighten"]["enabled"] = True
    seen = _stale_run_then_scan(monkeypatch, sounds_project, [])

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert seen["scans"] == 1
    assert summary == "no non-speech sounds to act on"
    assert sounds_project.clips[0].mute_regions == []
    assert [e.id for e in sounds_project.edit_decisions if not e.applied] == ["um"]


def test_an_analysis_that_skipped_does_not_count_as_fresh(sounds_project, monkeypatch):
    defaults = load_defaults()
    defaults["tighten"]["enabled"] = True
    _analysis_ran_in_this_run(sounds_project, message="skipped (tighten.enabled=false)")
    seen = _stale_run_then_scan(monkeypatch, sounds_project, [])

    steps.apply_sound_actions(sounds_project, defaults)

    assert seen["scans"] == 1


def test_a_rerun_does_not_relower_a_lower_the_editor_removed(sounds_project, monkeypatch):
    defaults = load_defaults()
    laugh = _decision("laugh", "filler:acoustic:likely_laugh", 3.0)
    seen = _stale_run_then_scan(monkeypatch, sounds_project, [laugh])

    assert steps.apply_sound_actions(sounds_project, defaults) == "Applied 1 lower."
    (clip,) = sounds_project.clips
    assert [(r.start_s, r.gain_db) for r in clip.mute_regions] == [(3.0, -12.0)]

    clip.mute_regions = []  # the editor removed the lower by hand
    again = _decision("laugh-again", "filler:acoustic:likely_laugh", 3.02)
    seen["scans"] = 0
    monkeypatch.setattr(
        steps,
        "propose_tighten_edits",
        lambda *a, **k: type("Proposal", (), {"decisions": [again]})(),
    )

    assert steps.apply_sound_actions(sounds_project, defaults) == "no non-speech sounds to act on"
    assert clip.mute_regions == []
    assert [e.id for e in sounds_project.edit_decisions if "laugh" in e.id] == []


def test_a_rerun_does_not_propose_a_left_sound_again(sounds_project, monkeypatch):
    defaults = load_defaults()
    unclear = _decision("unclear", "filler:acoustic", 5.0)
    _stale_run_then_scan(monkeypatch, sounds_project, [unclear])
    assert steps.apply_sound_actions(sounds_project, defaults) == "Applied 1 leave."

    monkeypatch.setattr(
        steps,
        "propose_tighten_edits",
        lambda *a, **k: type(
            "Proposal", (), {"decisions": [_decision("unclear2", "filler:acoustic", 5.0)]}
        )(),
    )

    assert steps.apply_sound_actions(sounds_project, defaults) == "no non-speech sounds to act on"
    assert [e.id for e in sounds_project.edit_decisions if e.id.startswith("unclear")] == []


def test_a_sound_nobody_decided_still_gets_its_action(sounds_project, monkeypatch):
    defaults = load_defaults()
    _stale_run_then_scan(
        monkeypatch,
        sounds_project,
        [_decision("a", "filler:acoustic:likely_laugh", 3.0)],
    )
    steps.apply_sound_actions(sounds_project, defaults)
    monkeypatch.setattr(
        steps,
        "propose_tighten_edits",
        lambda *a, **k: type(
            "Proposal", (), {"decisions": [_decision("b", "filler:acoustic:likely_laugh", 6.0)]}
        )(),
    )

    assert steps.apply_sound_actions(sounds_project, defaults) == "Applied 1 lower."


def test_a_runner_run_does_not_trust_the_analysis_log_of_an_earlier_run(
    sounds_project, monkeypatch
):
    # An earlier run analysed fine; this run starts at the sounds step, so its proposals are old.
    from podcast_mcp.pipeline.runner import PipelineRunner

    defaults = load_defaults()
    defaults["tighten"]["enabled"] = True
    _analysis_ran_in_this_run(sounds_project)
    seen = _stale_run_then_scan(monkeypatch, sounds_project, [])

    run = PipelineRunner(defaults).run(sounds_project, only_step="apply_sound_actions")

    assert seen["scans"] == 1
    assert [s.status for s in run.steps if s.step == "apply_sound_actions"] == ["ok"]
    assert sounds_project.pipeline_runs[-1].id == run.id != "run"
