from __future__ import annotations

import pytest

from pause_policy_public_helpers import configure, defaults, project
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_cuts import add_remove_decision
from podcast_mcp.models import TranscriptWord


def _fixture(tmp_path, monkeypatch):
    cfg = defaults()
    cfg["tighten"].update({"filler_words": ["um"], "max_pause_sec": 100})
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    result.transcripts[0].words.insert(1, TranscriptWord(text="um", start=1, end=1.5))
    return result, cfg


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_unavailable_peer_assessment_cannot_save_a_manual_track_punch(
    tmp_path, monkeypatch, failure
):
    result, cfg = _fixture(tmp_path, monkeypatch)
    before = result.model_dump(mode="json")

    def unavailable(*_args, **_kwargs):
        raise failure("literal peer assessment unavailable")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    with pytest.raises(ScopeChangedAtApproval) as held:
        add_remove_decision(
            result,
            "host",
            1,
            1.5,
            defaults=cfg,
            use_inaudible_opt=False,
            review_required=False,
        )

    assert held.value.held[0].reason == "scope_unavailable"
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_unavailable_peer_assessment_cannot_publish_an_automatic_track_punch(
    tmp_path, monkeypatch, failure
):
    result, cfg = _fixture(tmp_path, monkeypatch)

    def unavailable(*_args, **_kwargs):
        raise failure("literal peer assessment unavailable")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert proposal.decisions == []
    assert result.edit_decisions == []
    assert proposal.skip_counts["scope_unavailable"] == 1


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_final_peer_assessment_failure_cannot_publish_after_initial_clearance(
    tmp_path, monkeypatch, failure
):
    from podcast_mcp.edits.speech_energy_guard import assess_cross_track_speech

    result, cfg = _fixture(tmp_path, monkeypatch)
    calls = []

    def unavailable_after_clearance(*args, **kwargs):
        calls.append((args[2], args[3]))
        if len(calls) > 1:
            raise failure("literal final peer assessment unavailable")
        return assess_cross_track_speech(*args, **kwargs)

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech",
        unavailable_after_clearance,
    )
    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert len(calls) >= 2
    assert proposal.decisions == []
    assert result.edit_decisions == []
    assert proposal.skip_counts["scope_unavailable"] == 1


def test_a_clear_manual_cut_preserves_requested_session_scope(tmp_path, monkeypatch):
    result, cfg = _fixture(tmp_path, monkeypatch)

    decision = add_remove_decision(
        result,
        "host",
        1,
        1.5,
        defaults=cfg,
        use_inaudible_opt=False,
        review_required=False,
    )

    assert decision.scope == "session"
    assert decision.review_required is False
    assert [row.id for row in result.edit_decisions] == [decision.id]


def test_a_clear_generated_filler_keeps_session_scope(tmp_path, monkeypatch):
    result, cfg = _fixture(tmp_path, monkeypatch)

    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert len(proposal.decisions) == 1
    assert proposal.decisions[0].scope == "session"
    assert proposal.decisions[0].reason.startswith("filler:")
    assert proposal.decisions[0].review_required is False
    assert [row.id for row in result.edit_decisions] == [proposal.decisions[0].id]
