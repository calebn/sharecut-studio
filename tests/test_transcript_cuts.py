from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_cuts import (
    append_remove_decision,
    apply_edit_plan,
    coalesce_edits,
    cut_text_match,
    cut_time_range,
    cut_utterance,
    cut_words,
    format_transcript_timestamps,
    search_transcript,
    time_range_from_utterance,
    time_range_from_words,
)
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
    TranscriptWord,
)


def _project_with_transcript():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="We", start=0.0, end=0.2),
                TranscriptWord(text="talked", start=0.2, end=0.5),
                TranscriptWord(text="about", start=0.5, end=0.7),
                TranscriptWord(text="coffee", start=0.7, end=1.0),
                TranscriptWord(text="today", start=1.0, end=1.3),
            ],
        )
    )
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.3,
                text="We talked about coffee today",
            )
        ]
    )
    return proj


def test_search_transcript_finds_coffee():
    proj = _project_with_transcript()
    matches = search_transcript(proj, "coffee")
    assert len(matches) >= 1
    assert any("coffee" in m.text.lower() for m in matches)


def test_cut_time_range_and_coalesce():
    proj = EpisodeProject.create("t", "/tmp/ws")
    cut_time_range(proj, "host", 1.0, 2.0, review_required=True)
    cut_time_range(proj, "host", 1.5, 2.5, review_required=True)
    merged = coalesce_edits(proj)
    assert merged >= 0
    assert len(proj.edit_decisions) == 1
    assert proj.edit_decisions[0].end == 2.5


def test_cut_text_match():
    proj = _project_with_transcript()
    cuts = cut_text_match(proj, "coffee", review_required=True)
    assert len(cuts) == 1
    assert cuts[0].reason.startswith("nl:match:")


def test_apply_edit_plan():
    proj = EpisodeProject.create("t", "/tmp/ws")
    apply_edit_plan(
        proj,
        [{"track_id": "host", "start": 0.0, "end": 0.5, "reason": "agent:test"}],
    )
    assert len(proj.edit_decisions) == 1
    assert proj.edit_decisions[0].review_required is True


def test_coalesce_keeps_other_types():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0,
            end=1,
        ),
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1,
            end=2,
        ),
        EditDecision(
            id="3",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.5,
            end=3,
        ),
    ]
    coalesce_edits(proj)
    removes = [e for e in proj.edit_decisions if e.type == EditDecisionType.REMOVE]
    assert len(removes) == 1
    assert len(proj.edit_decisions) == 2


def test_search_transcript_empty_query():
    proj = _project_with_transcript()
    assert search_transcript(proj, "   ") == []


def test_search_transcript_track_and_speaker_filters():
    proj = _project_with_transcript()
    assert search_transcript(proj, "coffee", track_id="guest") == []
    assert search_transcript(proj, "coffee", speaker="Guest") == []


def test_ensure_combined_transcript_builds():
    proj = _project_with_transcript()
    proj.combined_transcript = None
    matches = search_transcript(proj, "coffee")
    assert matches
    assert proj.combined_transcript is not None


def test_search_transcript_skips_suppressed_words():
    proj = _project_with_transcript()
    proj.transcripts[0].words.append(
        TranscriptWord(text="secret", start=2.0, end=2.5, suppressed=True)
    )
    assert search_transcript(proj, "secret") == []
    assert search_transcript(proj, "secret", include_suppressed=True)


def test_search_transcript_empty_words_track():
    proj = _project_with_transcript()
    proj.transcripts.append(Transcript(track_id="guest", words=[]))
    matches = search_transcript(proj, "coffee")
    assert matches


def test_time_range_from_words():
    proj = _project_with_transcript()
    start, end = time_range_from_words(proj.transcripts[0], 1, 3)
    assert start == 0.2
    assert end == 1.0


def test_time_range_from_words_empty():
    EpisodeProject.create("t", "/tmp/ws")
    with pytest.raises(ValueError, match="no words"):
        time_range_from_words(Transcript(track_id="host", words=[]), 0, 0)


def test_time_range_from_utterance():
    proj = _project_with_transcript()
    tid, start, _end, text = time_range_from_utterance(proj.combined_transcript, 0)
    assert tid == "host"
    assert start == 0.0
    assert "coffee" in text


def test_time_range_from_utterance_out_of_range():
    proj = _project_with_transcript()
    with pytest.raises(ValueError, match="out of range"):
        time_range_from_utterance(proj.combined_transcript, 99)


def test_append_remove_decision_stores_cut_metadata():
    proj = EpisodeProject.create("t", "/tmp/ws")
    decision = append_remove_decision(
        proj,
        "host",
        1.0,
        2.0,
        reason="test",
        applied=True,
        cut_confidence=0.85,
        boundary_mode="vocal_transcript_guided",
    )
    assert decision.cut_confidence == 0.85
    assert decision.boundary_mode == "vocal_transcript_guided"


def test_append_remove_decision():
    proj = EpisodeProject.create("t", "/tmp/ws")
    decision = append_remove_decision(proj, "host", 1.0, 2.0, reason="test", applied=True)
    assert decision.reason == "test"
    assert decision.applied is True
    assert len(proj.edit_decisions) == 1


def test_append_remove_decision_invalid_range():
    proj = EpisodeProject.create("t", "/tmp/ws")
    with pytest.raises(ValueError, match="end must be greater"):
        append_remove_decision(proj, "host", 2.0, 1.0)


def test_add_remove_decision_invalid_range():
    proj = EpisodeProject.create("t", "/tmp/ws")
    with pytest.raises(ValueError, match="end must be greater"):
        cut_time_range(proj, "host", 2.0, 1.0)


def test_add_remove_decision_stores_cut_metadata(monkeypatch):
    from podcast_mcp.edits import transcript_cuts as tc
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_opt(project, track_id, start, end, force_enabled=None):
        return OptimizedCutRange(
            start=start + 0.01,
            end=end - 0.01,
            mode="vocal_transcript_guided",
            shifted_start_ms=10.0,
            shifted_end_ms=-10.0,
            confidence=0.91,
            details={},
        )

    monkeypatch.setattr(tc, "optimize_source_cut_range", _fake_opt)
    proj = EpisodeProject.create("t", "/tmp/ws")
    decision = tc.add_remove_decision(proj, "host", 1.0, 2.0, reason="nl:test")
    assert decision.start == pytest.approx(1.01)
    assert decision.end == pytest.approx(1.99)
    assert decision.cut_confidence == 0.91
    assert decision.boundary_mode == "vocal_transcript_guided"


def test_trailing_energy_extends_when_next_word_overlaps(monkeypatch):
    """um→you overlap: trailing-energy may extend past paced end."""
    from podcast_mcp.edits import transcript_cuts as tc
    from podcast_mcp.edits.filler_pacing import FillerPacingResult
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_pace(project, track_id, start, end, defaults=None, cut_kind="nl"):
        return FillerPacingResult(
            start=1.0,
            end=1.50,
            replace_gap_sec=0.28,
            allow_trailing_past_end=True,
        )

    def _fake_opt(project, track_id, start, end, force_enabled=None):
        return OptimizedCutRange(
            start=1.0,
            end=1.62,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=120.0,
            confidence=0.7,
            details={"trailing_energy_extended": True},
        )

    monkeypatch.setattr("podcast_mcp.edits.filler_pacing.apply_filler_pacing", _fake_pace)
    monkeypatch.setattr(tc, "optimize_source_cut_range", _fake_opt)
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        lambda *a, **k: ("session", None),
    )
    proj = EpisodeProject.create("t", "/tmp/ws")
    decision = tc.add_remove_decision(proj, "host", 1.0, 1.4, reason="nl:words")
    assert decision.end == pytest.approx(1.62)
    assert decision.replace_gap_sec == pytest.approx(0.28)


def test_trailing_energy_clamped_when_next_word_has_lead_in(monkeypatch):
    """know→like: keep lead-in; do not let trailing-energy eat the L onset."""
    from podcast_mcp.edits import transcript_cuts as tc
    from podcast_mcp.edits.filler_pacing import FillerPacingResult
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_pace(project, track_id, start, end, defaults=None, cut_kind="nl"):
        return FillerPacingResult(
            start=1.0,
            end=1.50,
            replace_gap_sec=0.28,
            allow_trailing_past_end=False,
        )

    def _fake_opt(project, track_id, start, end, force_enabled=None):
        return OptimizedCutRange(
            start=1.0,
            end=1.62,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=120.0,
            confidence=0.7,
            details={"trailing_energy_extended": True},
        )

    monkeypatch.setattr("podcast_mcp.edits.filler_pacing.apply_filler_pacing", _fake_pace)
    monkeypatch.setattr(tc, "optimize_source_cut_range", _fake_opt)
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        lambda *a, **k: ("session", None),
    )
    proj = EpisodeProject.create("t", "/tmp/ws")
    decision = tc.add_remove_decision(proj, "host", 1.0, 1.4, reason="nl:words")
    assert decision.end == pytest.approx(1.50)
    assert decision.replace_gap_sec == pytest.approx(0.28)


def test_coalesce_edits_track_filter():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0,
            end=1,
        ),
        EditDecision(
            id="2",
            track_id="guest",
            type=EditDecisionType.REMOVE,
            start=0,
            end=1,
        ),
    ]
    merged = coalesce_edits(proj, track_id="host")
    assert merged == 0
    assert len(proj.edit_decisions) == 2


def test_coalesce_edits_non_adjacent():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0,
            end=1,
        ),
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2,
            end=3,
        ),
    ]
    merged = coalesce_edits(proj)
    assert merged == 0
    assert len(proj.edit_decisions) == 2


def test_cut_text_match_no_matches():
    proj = _project_with_transcript()
    assert cut_text_match(proj, "nonexistent phrase") == []


def test_cut_utterance():
    proj = _project_with_transcript()
    decision = cut_utterance(proj, 0, review_required=False)
    assert decision.track_id == "host"
    assert decision.reason.startswith("nl:utterance:")


def test_cut_words():
    proj = _project_with_transcript()
    decision = cut_words(proj, "host", 3, 4, review_required=False)
    assert decision.track_id == "host"
    assert decision.reason == "nl:words"


def test_cut_words_no_transcript():
    proj = EpisodeProject.create("t", "/tmp/ws")
    with pytest.raises(ValueError, match="No transcript"):
        cut_words(proj, "host", 0, 1)


def test_format_transcript_timestamps():
    proj = _project_with_transcript()
    text = format_transcript_timestamps(proj)
    assert "[0]" in text
    assert "Host" in text
    assert "coffee" in text
