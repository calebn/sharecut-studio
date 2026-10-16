"""The pipeline applies each non-speech sound's suggested action by default (#1434)."""

from __future__ import annotations

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import suggested_actions
from podcast_mcp.edits.acoustic_gap import AcousticGapConfig
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
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


def test_the_step_acts_on_sounds_and_leaves_spoken_proposals_pending(sounds_project, monkeypatch):
    # Tighten analysis is on, so the step uses the proposals already on the project.
    defaults = load_defaults()
    defaults["tighten"]["enabled"] = True
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert summary == "Applied 1 lower, 1 leave."
    assert [e.id for e in sounds_project.edit_decisions if not e.applied] == ["um"]
    (clip,) = sounds_project.clips
    assert [(r.start_s, r.gain_db) for r in clip.mute_regions] == [(3.0, -12.0)]


def test_with_tighten_off_the_step_looks_for_sounds_itself(sounds_project, monkeypatch):
    defaults = load_defaults()
    found = [_decision("laugh2", "filler:acoustic:likely_laugh", 7.0)]
    seen = {}

    def propose(project, cfg, *, replace_existing):
        seen["replace_existing"] = replace_existing
        return type("Proposal", (), {"decisions": [*found, _decision("um2", "filler:um", 8.0)]})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert seen == {"replace_existing": True}
    assert summary == "Applied 1 lower."
    # The scan's spoken filler was dropped and the sounds it replaced are gone; the old filler stays.
    assert sorted(e.id for e in sounds_project.edit_decisions if not e.applied) == ["um"]


def test_with_tighten_off_the_scan_skips_the_word_probe(sounds_project, monkeypatch):
    defaults = load_defaults()
    seen = {}

    def propose(project, cfg, *, replace_existing):
        seen["word_probe"] = AcousticGapConfig.from_tighten(cfg.get("tighten")).word_probe
        seen["caller_word_probe"] = AcousticGapConfig.from_tighten(
            defaults.get("tighten")
        ).word_probe
        return type("Proposal", (), {"decisions": []})()

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)

    summary = steps.apply_sound_actions(sounds_project, defaults)

    assert summary == "no non-speech sounds to act on"
    assert seen == {"word_probe": False, "caller_word_probe": True}
