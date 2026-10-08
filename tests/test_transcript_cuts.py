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


def test_coalesce_keeps_the_next_burst_of_the_cut_that_ends_last():
    proj = EpisodeProject.create("t", "/tmp/ws")
    append_remove_decision(proj, "host", 1.0, 2.0, replace_gap_sec=0.5, next_burst_sec=2.01)
    append_remove_decision(proj, "host", 1.9, 2.5, replace_gap_sec=0.6, next_burst_sec=2.51)
    append_remove_decision(proj, "host", 2.0, 2.2, next_burst_sec=2.21)

    assert coalesce_edits(proj) == 2
    (merged,) = proj.edit_decisions
    assert (merged.end, merged.next_burst_sec) == (2.5, 2.51)


def _hesitation_project():
    """ "so" ends 0.9, a hesitation (um, uh) from 1.0 to 1.7, "like" starts 1.8."""
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="so", start=0.5, end=0.9),
                TranscriptWord(text="um", start=1.0, end=1.3),
                TranscriptWord(text="uh", start=1.35, end=1.7),
                TranscriptWord(text="like", start=1.8, end=2.1),
            ],
        )
    )
    return proj


def test_coalesce_repaces_the_merged_cut_from_its_final_span():
    proj = _hesitation_project()
    # Each cut was padded for its own span: 0.40 s and 0.50 s.
    append_remove_decision(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    append_remove_decision(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    assert coalesce_edits(proj, track_id="host") == 1

    (merged,) = proj.edit_decisions
    assert (merged.start, merged.end) == (1.0, 1.7)
    # The merged cut takes the 0.9 s of air between "so" and "like": 0.85 x 0.9, not max(0.40, 0.50).
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_repaces_with_the_defaults_it_is_given():
    proj = _hesitation_project()
    append_remove_decision(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    append_remove_decision(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )
    defaults = {
        "tighten": {
            "min_gap_after_filler_sec": 0.2,
            "filler_gap_retain_fraction": 0.5,
            "filler_replace_gap_max_sec": 0.6,
        }
    }

    coalesce_edits(proj, track_id="host", defaults=defaults)

    (merged,) = proj.edit_decisions
    assert merged.replace_gap_sec == pytest.approx(0.45)


def test_coalesce_caps_a_long_merged_hesitation_at_the_pad_maximum():
    proj = _hesitation_project()
    proj.transcripts[0].words[-1] = TranscriptWord(text="like", start=3.0, end=3.3)
    append_remove_decision(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    append_remove_decision(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    coalesce_edits(proj, track_id="host")

    (merged,) = proj.edit_decisions
    # 2.1 s of air is past filler_room_tone_max_expand_sec, so the 0.7 s span sets the pad.
    assert merged.replace_gap_sec == pytest.approx(0.595)


def test_coalesce_paces_the_merged_pad_when_only_one_cut_was_padded():
    proj = _hesitation_project()
    append_remove_decision(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    append_remove_decision(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    coalesce_edits(proj, track_id="host")

    (merged,) = proj.edit_decisions
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_keeps_a_pause_shortfall_pad_beside_the_filler_pad():
    proj = _hesitation_project()
    append_remove_decision(
        proj, "host", 1.0, 1.3, reason="pause:0.30s", review_required=False, replace_gap_sec=0.90
    )
    append_remove_decision(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    coalesce_edits(proj, track_id="host")

    (merged,) = proj.edit_decisions
    # The pause's 0.90 s makes up for a retained stretch that prior ripples shortened;
    # it is not a paced pad, so the filler's re-paced 0.765 s does not replace it.
    assert merged.replace_gap_sec == pytest.approx(0.90)


def test_adjacent_nl_cuts_merge_into_one_paced_cut():
    proj = _hesitation_project()

    cut_time_range(proj, "host", 1.0, 1.3, reason="nl:um", review_required=False)
    cut_time_range(proj, "host", 1.3, 1.7, reason="nl:uh", review_required=False)

    (merged,) = proj.edit_decisions
    # The cuts were paced at 0.3825 s and 0.425 s of their own; the merged cut removes 0.78 s
    # of the 0.9 s between "so" and "like": 0.85 x 0.9.
    assert (round(merged.start, 2), round(merged.end, 2)) == (0.94, 1.72)
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_leaves_unpadded_cuts_unpadded():
    proj = _hesitation_project()
    append_remove_decision(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    append_remove_decision(proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False)

    coalesce_edits(proj, track_id="host")

    (merged,) = proj.edit_decisions
    assert merged.replace_gap_sec is None


def test_coalesce_keeps_pending_edits_of_different_authors_apart():
    proj = EpisodeProject.create("t", "/tmp/ws")
    for start, end, reason, author in (
        (1.0, 1.5, "pause:0.80s", None),
        (1.5, 2.0, "guest:suggest", "share:ann"),
        (2.0, 2.5, "guest:suggest", "share:bob"),
        (2.5, 3.0, "guest:suggest", "share:bob"),
        (3.0, 3.5, "pause:0.80s", None),
        (3.5, 4.0, "pause:0.90s", None),
    ):
        append_remove_decision(proj, "host", start, end, reason=reason, author=author)

    assert coalesce_edits(proj) == 2
    assert sorted((e.start, e.end, e.author) for e in proj.edit_decisions) == [
        (1.0, 1.5, None),
        (1.5, 2.0, "share:ann"),
        (2.0, 3.0, "share:bob"),
        (3.0, 4.0, None),
    ]


@pytest.mark.parametrize(
    "modes, expected_merges",
    [
        ((None, None), 1),
        (("vocal_transcript_guided", "vocal_transcript_guided"), 1),
        ((None, "vocal_transcript_guided"), 0),
        (("vocal_transcript_guided", None), 0),
        (("waveform_only", "vocal_transcript_guided"), 0),
        (("vocal_transcript_guided", "waveform_only"), 0),
    ],
)
def test_coalesce_preserves_each_boundary_mode(modes, expected_merges):
    proj = EpisodeProject.create("t", "/tmp/ws")
    left = append_remove_decision(proj, "host", 1.0, 2.0, boundary_mode=modes[0])
    right = append_remove_decision(proj, "host", 1.9, 2.5, boundary_mode=modes[1])

    assert coalesce_edits(proj) == expected_merges
    if expected_merges:
        assert [(e.start, e.end, e.boundary_mode) for e in proj.edit_decisions] == [
            (1.0, 2.5, modes[0])
        ]
    else:
        assert proj.edit_decisions == [left, right]
        assert [(e.start, e.end, e.boundary_mode) for e in proj.edit_decisions] == [
            (1.0, 2.0, modes[0]),
            (1.9, 2.5, modes[1]),
        ]


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
    from podcast_mcp.edits.filler_pacing import FillerPacingResult, PacedPad
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_pace(project, track_id, start, end, defaults=None, cut_kind="nl"):
        return FillerPacingResult(
            start=1.0,
            end=1.50,
            pad=PacedPad(gap_sec=0.3, min_sec=0.28, retain=0.85, max_sec=1.0),
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
    # The pad is paced from the span shipped: 0.85 x 0.62 s.
    assert decision.replace_gap_sec == pytest.approx(0.527)


def test_trailing_energy_clamped_when_next_word_has_lead_in(monkeypatch):
    """know→like: keep lead-in; do not let trailing-energy eat the L onset."""
    from podcast_mcp.edits import transcript_cuts as tc
    from podcast_mcp.edits.filler_pacing import FillerPacingResult, PacedPad
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_pace(project, track_id, start, end, defaults=None, cut_kind="nl"):
        return FillerPacingResult(
            start=1.0,
            end=1.50,
            pad=PacedPad(gap_sec=0.3, min_sec=0.28, retain=0.85, max_sec=1.0),
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
    assert decision.replace_gap_sec == pytest.approx(0.425)


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


def test_coalesce_keeps_reviewable_restart_and_neighbors_separate():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="filler",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.1,
            reason="filler:um",
        ),
        EditDecision(
            id="restart",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.1,
            end=0.2,
            reason="restart:partial:w",
            review_required=True,
        ),
        EditDecision(
            id="repeat",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.2,
            end=0.3,
            reason="repetition:word:i",
            review_required=True,
        ),
        EditDecision(
            id="pause",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.3,
            end=0.4,
            reason="pause:1.0s",
        ),
    ]

    assert coalesce_edits(proj) == 0
    assert [(edit.id, edit.reason) for edit in proj.edit_decisions] == [
        ("filler", "filler:um"),
        ("restart", "restart:partial:w"),
        ("repeat", "repetition:word:i"),
        ("pause", "pause:1.0s"),
    ]


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


def _spans(proj: EpisodeProject) -> list[tuple[str, float, float, bool]]:
    return sorted(
        (e.reason.split(":")[0], e.start, e.end, e.review_required) for e in proj.edit_decisions
    )


def test_coalesce_keeps_a_pause_trim_waiting_for_review_apart_from_the_filler_beside_it():
    # Every pause trim waits for the owner's listen (#1055). Merged into the filler next
    # to it, the trim would hold the filler back from applying on its own.
    proj = EpisodeProject.create("t", "/tmp/ws")
    append_remove_decision(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    append_remove_decision(proj, "host", 1.3, 2.4, reason="pause:1.10s", review_required=True)

    assert coalesce_edits(proj, track_id="host") == 0
    assert _spans(proj) == [("filler", 1.0, 1.3, False), ("pause", 1.3, 2.4, True)]


def test_coalesce_still_merges_pause_trims_with_each_other_and_with_cuts_waiting_for_review():
    proj = EpisodeProject.create("t", "/tmp/ws")
    append_remove_decision(proj, "host", 1.0, 1.3, reason="pause:0.3s", review_required=True)
    append_remove_decision(proj, "host", 1.3, 1.6, reason="pause:0.3s", review_required=True)
    append_remove_decision(proj, "host", 1.6, 1.9, reason="filler:um", review_required=True)

    assert coalesce_edits(proj, track_id="host") == 2
    assert _spans(proj) == [("pause", 1.0, 1.9, True)]


def test_coalesce_still_merges_a_pause_trim_that_applies_on_its_own_with_the_filler_beside_it():
    proj = EpisodeProject.create("t", "/tmp/ws")
    append_remove_decision(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    append_remove_decision(proj, "host", 1.3, 2.4, reason="pause:1.10s", review_required=False)

    assert coalesce_edits(proj, track_id="host") == 1
    assert _spans(proj) == [("filler", 1.0, 2.4, False)]
