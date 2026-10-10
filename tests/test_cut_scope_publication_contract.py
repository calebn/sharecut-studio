from __future__ import annotations

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    pause,
    primary_spans,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.speech_energy_guard import (
    assess_cross_track_speech,
    resolve_cut_scope,
)
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.models import EditDecisionType, TranscriptWord, load_project
from podcast_mcp.services.document import EditService


def _filler(tmp_path, monkeypatch, *, moved=False, guest=None):
    cfg = defaults()
    cfg["tighten"].update({"filler_words": ["um"], "max_pause_sec": 100})
    cfg["tighten"]["speech_energy_guard"].update({"enabled": True, "on_conflict": "track_local"})
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest=guest)
    result.transcripts[0].words.insert(1, TranscriptWord(text="um", start=1, end=1.5))
    if moved:
        audio = room()
        for start, end in ((0, 0.2), (0.8, 1.4), (5, 5.2)):
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / "host.wav", audio)
    kept = pause("kept", start=5.4, end=5.6, gap=None)
    kept.reason = "nl:range"
    kept.review_required = True
    result.edit_decisions = [kept]
    return result, cfg


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_moved_filler_edge_needs_available_assessment_before_publication(
    tmp_path, monkeypatch, failure
):
    result, cfg = _filler(tmp_path, monkeypatch, moved=True)
    control = propose_tighten_edits(result.model_copy(deep=True), cfg, replace_existing=False)
    assert [(d.start, d.end, d.scope) for d in control.decisions] == [
        (pytest.approx(0.78), pytest.approx(1.5), "session")
    ]
    before = result.model_dump(mode="json")
    assessed = []

    def fail_on_moved_span(*args, **kwargs):
        assessed.append((args[2], args[3]))
        if args[2] < 1:
            raise failure("moved source span peer assessment unavailable")
        return assess_cross_track_speech(*args, **kwargs)

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", fail_on_moved_span
    )
    proposal = propose_tighten_edits(result, cfg, replace_existing=False)

    assert assessed == [pytest.approx((1, 1.5)), pytest.approx((0.78, 1.5))]
    assert proposal.skip_counts == {"scope_unavailable": 1}
    assert proposal.decisions == []
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_clear_to_known_peer_scope_flip_needs_available_regate_assessment(
    tmp_path, monkeypatch, failure
):
    result, cfg = _filler(tmp_path, monkeypatch, moved=True, guest="quiet")
    peer = room(seed=1215)
    voice(peer, 0.82, 0.97, db=-12)
    write_wav(tmp_path / "raw" / "guest.wav", peer)
    control = propose_tighten_edits(result.model_copy(deep=True), cfg, replace_existing=False)
    assert [(d.start, d.end, d.scope) for d in control.decisions] == [
        (pytest.approx(0.78), pytest.approx(1.5), "track")
    ]
    assert "track_local:guest" in control.decisions[0].reason
    before = result.model_dump(mode="json")
    assessed = []
    completed_peers = []

    def fail_after_scope_flip(*args, **kwargs):
        assessed.append((args[2], args[3]))
        if len(assessed) == 3:
            raise failure("peer-backed source span unavailable on re-gate")
        guard = assess_cross_track_speech(*args, **kwargs)
        completed_peers.append(guard.blocking_track_ids)
        return guard

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", fail_after_scope_flip
    )
    proposal = propose_tighten_edits(result, cfg, replace_existing=False)

    assert assessed == [
        pytest.approx((1, 1.5)),
        pytest.approx((0.78, 1.5)),
        pytest.approx((0.78, 1.5)),
    ]
    assert completed_peers == [(), ("guest",)]
    assert proposal.skip_counts == {"scope_unavailable": 1}
    assert proposal.decisions == []
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_acoustic_candidate_counts_one_unprefixed_unavailable_skip(tmp_path, monkeypatch, failure):
    cfg = defaults()
    cfg["tighten"].update({"max_pause_sec": 100, "acoustic_gap_filler": {"enabled": True}})
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    result.transcripts[0].words = [
        TranscriptWord(text="before", start=0.2, end=0.4),
        TranscriptWord(text="after", start=2, end=2.2),
    ]
    audio = room(db=-70)
    for start, end in ((0.2, 0.4), (0.8, 1.2), (2, 2.2)):
        voice(audio, start, end)
    write_wav(tmp_path / "raw" / "host.wav", audio)
    control = propose_tighten_edits(result.model_copy(deep=True), cfg)
    assert len(control.decisions) == 1
    assert control.decisions[0].reason.startswith("filler:acoustic")
    assert control.decisions[0].scope == "session"
    assert control.decisions[0].review_required is True
    before = result.model_dump(mode="json")

    def unavailable(*_args, **_kwargs):
        raise failure("acoustic candidate peer assessment unavailable")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    proposal = propose_tighten_edits(result, cfg)

    assert proposal.skip_counts == {"scope_unavailable": 1}
    assert proposal.decisions == []
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("assessment", ["initial", "final"])
@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_pause_cannot_force_session_scope_over_unavailable_assessment(
    tmp_path, monkeypatch, assessment, failure
):
    cfg = defaults()
    configure(monkeypatch, cfg)
    result = project(tmp_path)
    before = result.model_dump(mode="json")
    assessed = []

    def unavailable_pause(*args, **kwargs):
        assessed.append((args[2], args[3]))
        if assessment == "initial" or len(assessed) == 2:
            raise failure("pause source span peer assessment unavailable")
        return assess_cross_track_speech(*args, **kwargs)

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable_pause
    )
    proposal = propose_tighten_edits(result, cfg)

    assert assessed == [pytest.approx((0.2, 4.45))] * (1 if assessment == "initial" else 2)
    assert proposal.skip_counts == {"scope_unavailable": 1}
    assert proposal.decisions == []
    assert result.model_dump(mode="json") == before


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_mute_proposal_stays_publishable_with_a_failing_peer_assessor(
    tmp_path, monkeypatch, failure
):
    result, cfg = _filler(tmp_path, monkeypatch, moved=True, guest="quiet")

    def unavailable(*_args, **_kwargs):
        raise failure("MUTE must not require peer assessment")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    proposal = propose_tighten_edits(result, cfg, replace_existing=False, edit_mode="mute")

    assert [(d.start, d.end, d.type, d.scope) for d in proposal.decisions] == [
        (pytest.approx(0.78), pytest.approx(1.5), EditDecisionType.MUTE, "track")
    ]
    assert proposal.skip_counts == {}
    assert [d.id for d in result.edit_decisions] == ["kept", proposal.decisions[0].id]
    assert primary_spans(result) == [(0, 6, 0)]
    assert primary_spans(result, "guest") == [(0, 6, 0)]


@pytest.mark.parametrize("policy", ["skip", "review", "track_local"])
def test_known_peer_generated_controls_preserve_conflict_policy(tmp_path, monkeypatch, policy):
    result, cfg = _filler(tmp_path, monkeypatch, guest="quiet")
    peer = room(seed=1215)
    voice(peer, 1.1, 1.3)
    write_wav(tmp_path / "raw" / "guest.wav", peer)
    control = propose_tighten_edits(result.model_copy(deep=True), cfg, replace_existing=False)
    assert [(d.start, d.end, d.scope) for d in control.decisions] == [(1, 1.5, "track")]
    assert "track_local:guest" in control.decisions[0].reason
    cfg["tighten"]["speech_energy_guard"]["on_conflict"] = policy
    before = result.model_dump(mode="json")

    proposal = propose_tighten_edits(result, cfg, replace_existing=False)

    if policy == "skip":
        assert proposal.skip_counts == {"scope": 1}
        assert proposal.decisions == []
        assert result.model_dump(mode="json") == before
    else:
        assert [(d.start, d.end, d.scope) for d in proposal.decisions] == [(1, 1.5, "track")]
        marker = "other_speaking:guest" if policy == "review" else "track_local:guest"
        assert marker in proposal.decisions[0].reason
        assert proposal.decisions[0].review_required is (policy == "review")
        assert proposal.decisions[0].replace_gap_sec is None
        assert [d.id for d in result.edit_decisions] == ["kept", proposal.decisions[0].id]


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_requested_track_bypasses_failed_assessment_and_saved_track_stays_a_punch(
    tmp_path, monkeypatch, failure
):
    cfg = defaults()
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest="quiet")

    def unavailable(*_args, **_kwargs):
        raise failure("intentional track operation must not require peer assessment")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    resolved = resolve_cut_scope(result, "host", 1, 1.5, requested_scope="track", defaults=cfg)
    assert resolved.scope == "track"
    edit = pause("punch", start=1, end=1.5, gap=None)
    edit.scope = resolved.scope
    edit.reason = "nl:range"
    result.edit_decisions = [edit]
    ws = workspace(result)

    assert EditService(ws).approve(["punch"]) == 1

    saved = load_project(ws.path)
    assert primary_spans(saved) == [(0, 1, 0), (1.5, 6, 1.5)]
    assert primary_spans(saved, "guest") == [(0, 6, 0)]
    assert saved.timeline.duration_sec == 6
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["punch"]]


@pytest.mark.parametrize("failure", [OSError, ValueError])
def test_saved_session_approval_unavailable_hold_preserves_saved_bytes(
    tmp_path, monkeypatch, failure
):
    cfg = defaults()
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest="quiet")
    edit = pause("session", start=1, end=1.5, gap=None)
    edit.reason = "nl:range"
    result.edit_decisions = [edit]
    ws = workspace(result)
    before_model = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)
    assessed = []

    def unavailable(*args, **_kwargs):
        assessed.append((args[2], args[3]))
        raise failure("saved session peer assessment unavailable")

    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.assess_cross_track_speech", unavailable
    )
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["session"])

    assert held.value.code == "cut_scope_changed"
    assert [(h.edit_id, h.reason, h.peers) for h in held.value.held] == [
        ("session", "scope_unavailable", ())
    ]
    assert assessed == [(1, 1.5)]
    assert "None of the selected edits were applied." in str(held.value)
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model
