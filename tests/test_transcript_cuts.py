from __future__ import annotations

import wave

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_application import apply_edit_plan, approve_edits
from podcast_mcp.edits.cut_safety import ResolvedCutScope
from podcast_mcp.edits.transcript_cuts import (
    append_remove_decision,
    coalesce_edits,
    cut_text_match,
    cut_time_range,
    cut_utterance,
    cut_words,
    format_transcript_timestamps,
    time_range_from_utterance,
    time_range_from_words,
)
from podcast_mcp.edits.transcript_search import ensure_combined_transcript, search_transcript
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)


def _pending(project, track_id, start, end, **kwargs):
    from uuid import uuid4

    edit = EditDecision(
        id=uuid4().hex, track_id=track_id, start=start, end=end, applied=False, **kwargs
    )
    project.edit_decisions.append(edit)
    return edit


def _project_with_media(tmp_path):
    project = EpisodeProject.create("t", str(tmp_path))
    for name in ("host", "guest", "a", "b", "take-a", "take-b"):
        path = tmp_path / f"raw/{name}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16_000)
            audio.writeframes(bytes(60 * 16_000 * 2))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            speaker=tid.title(),
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=60),
        )
        for tid in ("host", "guest")
    ]
    return project


def _project_with_transcript(tmp_path):
    proj = _project_with_media(tmp_path)
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


def test_search_transcript_finds_coffee(tmp_path):
    proj = _project_with_transcript(tmp_path)
    matches = search_transcript(proj, "coffee", defaults=load_defaults())
    assert len(matches) >= 1
    assert any("coffee" in m.text.lower() for m in matches)


def test_cut_time_range_and_coalesce(tmp_path):
    proj = _project_with_media(tmp_path)
    cut_time_range(
        proj,
        "host",
        1.0,
        2.0,
        review_required=True,
        use_inaudible_opt=False,
        defaults=load_defaults(),
    )
    cut_time_range(
        proj,
        "host",
        1.5,
        2.5,
        review_required=True,
        use_inaudible_opt=False,
        defaults=load_defaults(),
    )
    merged = coalesce_edits(proj, defaults=load_defaults())
    assert merged >= 0
    assert len(proj.edit_decisions) == 1
    assert proj.edit_decisions[0].end == 2.5


def test_coalesce_keeps_the_next_burst_of_the_cut_that_ends_last(tmp_path):
    proj = _project_with_media(tmp_path)
    _pending(proj, "host", 1.0, 2.0, replace_gap_sec=0.5, next_burst_sec=2.01)
    _pending(proj, "host", 1.9, 2.5, replace_gap_sec=0.6, next_burst_sec=2.51)
    _pending(proj, "host", 2.0, 2.2, next_burst_sec=2.21)

    assert coalesce_edits(proj, defaults=load_defaults()) == 2
    (merged,) = proj.edit_decisions
    assert (merged.end, merged.next_burst_sec) == (2.5, 2.51)


def _hesitation_project(tmp_path):
    """ "so" ends 0.9, a hesitation (um, uh) from 1.0 to 1.7, "like" starts 1.8."""
    proj = _project_with_media(tmp_path)
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


def test_coalesce_repaces_the_merged_cut_from_its_final_span(tmp_path):
    proj = _hesitation_project(tmp_path)
    # Each cut was padded for its own span: 0.40 s and 0.50 s.
    _pending(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    _pending(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 1

    (merged,) = proj.edit_decisions
    assert (merged.start, merged.end) == (1.0, 1.7)
    # The merged cut takes the 0.9 s of air between "so" and "like": 0.85 x 0.9, not max(0.40, 0.50).
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_repaces_with_the_defaults_it_is_given(tmp_path):
    proj = _hesitation_project(tmp_path)
    _pending(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    _pending(
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


def test_coalesce_caps_a_long_merged_hesitation_at_the_pad_maximum(tmp_path):
    proj = _hesitation_project(tmp_path)
    proj.transcripts[0].words[-1] = TranscriptWord(text="like", start=3.0, end=3.3)
    _pending(
        proj, "host", 1.0, 1.3, reason="filler:um", review_required=False, replace_gap_sec=0.40
    )
    _pending(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    coalesce_edits(proj, track_id="host", defaults=load_defaults())

    (merged,) = proj.edit_decisions
    # 2.1 s of air is past filler_room_tone_max_expand_sec, so the 0.7 s span sets the pad.
    assert merged.replace_gap_sec == pytest.approx(0.595)


def test_coalesce_paces_the_merged_pad_when_only_one_cut_was_padded(tmp_path):
    proj = _hesitation_project(tmp_path)
    _pending(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    _pending(
        proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    coalesce_edits(proj, track_id="host", defaults=load_defaults())

    (merged,) = proj.edit_decisions
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_keeps_a_pause_shortfall_pad_apart_from_the_filler_pad(tmp_path):
    proj = _hesitation_project(tmp_path)
    _pending(
        proj, "host", 1.0, 2.3, reason="pause:1.30s", review_required=False, replace_gap_sec=0.90
    )
    _pending(
        proj, "host", 2.35, 2.7, reason="filler:uh", review_required=False, replace_gap_sec=0.50
    )

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 0

    # The pause's 0.90 s makes up for a retained stretch that prior ripples shortened. A
    # pause trim is its own proposal, applied or reviewed, so the filler's pad stays its own.
    assert sorted((e.reason, e.replace_gap_sec) for e in proj.edit_decisions) == [
        ("filler:uh", 0.5),
        ("pause:1.30s", 0.9),
    ]


def test_adjacent_nl_cuts_merge_into_one_paced_cut(tmp_path):
    proj = _hesitation_project(tmp_path)

    cut_time_range(
        proj,
        "host",
        1.0,
        1.3,
        reason="nl:um",
        review_required=False,
        use_inaudible_opt=False,
        defaults=load_defaults(),
    )
    cut_time_range(
        proj,
        "host",
        1.3,
        1.7,
        reason="nl:uh",
        review_required=False,
        use_inaudible_opt=False,
        defaults=load_defaults(),
    )

    (merged,) = proj.edit_decisions
    # The cuts were paced at 0.3825 s and 0.425 s of their own; the merged cut removes 0.78 s
    # of the 0.9 s between "so" and "like": 0.85 x 0.9.
    assert (round(merged.start, 2), round(merged.end, 2)) == (0.94, 1.72)
    assert merged.replace_gap_sec == pytest.approx(0.765)


def test_coalesce_leaves_unpadded_cuts_unpadded(tmp_path):
    proj = _hesitation_project(tmp_path)
    _pending(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    _pending(proj, "host", 1.35, 1.7, reason="filler:uh", review_required=False)

    coalesce_edits(proj, track_id="host", defaults=load_defaults())

    (merged,) = proj.edit_decisions
    assert merged.replace_gap_sec is None


def test_coalesce_keeps_pending_edits_of_different_authors_apart(tmp_path):
    proj = _project_with_media(tmp_path)
    for start, end, reason, author in (
        (1.0, 1.5, "filler:um", None),
        (1.5, 2.0, "guest:suggest", "share:ann"),
        (2.0, 2.5, "guest:suggest", "share:bob"),
        (2.5, 3.0, "guest:suggest", "share:bob"),
        (3.0, 3.5, "filler:um", None),
        (3.5, 4.0, "filler:uh", None),
    ):
        _pending(proj, "host", start, end, reason=reason, author=author)

    assert coalesce_edits(proj, defaults=load_defaults()) == 2
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
def test_coalesce_preserves_each_boundary_mode(tmp_path, modes, expected_merges):
    proj = _project_with_media(tmp_path)
    left = _pending(proj, "host", 1.0, 2.0, boundary_mode=modes[0])
    right = _pending(proj, "host", 1.9, 2.5, boundary_mode=modes[1])

    assert coalesce_edits(proj, defaults=load_defaults()) == expected_merges
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


def test_cut_text_match(tmp_path):
    proj = _project_with_transcript(tmp_path)
    cuts = cut_text_match(proj, "coffee", review_required=True, defaults=load_defaults())
    assert len(cuts) == 1
    assert cuts[0].reason.startswith("nl:match:")


def test_apply_edit_plan(tmp_path):
    proj = _project_with_media(tmp_path)
    created = apply_edit_plan(
        proj,
        [
            {"track_id": "host", "start": 0, "end": 0.5, "reason": "agent:test"},
            {"track_id": "host", "start": 2.2, "end": 3, "reason": "agent:test", "applied": True},
            {"track_id": "host", "start": 1.5, "end": 2.5, "reason": "agent:test", "applied": True},
        ],
        use_inaudible_opt=False,
        defaults=load_defaults(),
    )
    assert len(proj.edit_decisions) == 1
    assert proj.edit_decisions[0].review_required is True
    assert proj.edit_decisions[0].applied is False
    assert len(proj.editorial.edit_log) == 1
    record = proj.editorial.edit_log[0]
    assert record.source_start == pytest.approx(1.5)
    assert record.source_end == pytest.approx(3)
    assert created[1].id == created[2].id == record.decision_ids[0]
    assert created[0].id == proj.edit_decisions[0].id
    assert [row.applied for row in created] == [False, True, True]


def test_coalesce_keeps_other_types(tmp_path):
    proj = _project_with_media(tmp_path)
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
    coalesce_edits(proj, defaults=load_defaults())
    removes = [e for e in proj.edit_decisions if e.type == EditDecisionType.REMOVE]
    assert len(removes) == 1
    assert len(proj.edit_decisions) == 2


def test_search_transcript_empty_query(tmp_path):
    proj = _project_with_transcript(tmp_path)
    assert search_transcript(proj, "   ", defaults=load_defaults()) == []


def test_search_transcript_track_and_speaker_filters(tmp_path):
    proj = _project_with_transcript(tmp_path)
    assert search_transcript(proj, "coffee", track_id="guest", defaults=load_defaults()) == []
    assert search_transcript(proj, "coffee", speaker="Guest", defaults=load_defaults()) == []


def test_ensure_combined_transcript_builds(tmp_path):
    proj = _project_with_transcript(tmp_path)
    proj.combined_transcript = None
    matches = search_transcript(proj, "coffee", defaults=load_defaults())
    assert matches
    assert proj.combined_transcript is not None


def test_search_transcript_skips_suppressed_words(tmp_path):
    proj = _project_with_transcript(tmp_path)
    proj.transcripts[0].words.append(
        TranscriptWord(text="secret", start=2.0, end=2.5, suppressed=True)
    )
    assert search_transcript(proj, "secret", defaults=load_defaults()) == []
    assert search_transcript(proj, "secret", include_suppressed=True, defaults=load_defaults())


def test_search_transcript_empty_words_track(tmp_path):
    proj = _project_with_transcript(tmp_path)
    proj.transcripts.append(Transcript(track_id="guest", words=[]))
    matches = search_transcript(proj, "coffee", defaults=load_defaults())
    assert matches


def test_time_range_from_words(tmp_path):
    proj = _project_with_transcript(tmp_path)
    start, end = time_range_from_words(proj.transcripts[0], 1, 3)
    assert start == 0.2
    assert end == 1.0


def test_time_range_from_words_empty(tmp_path):
    _project_with_media(tmp_path)
    with pytest.raises(ValueError, match="no words"):
        time_range_from_words(Transcript(track_id="host", words=[]), 0, 0)


def test_time_range_from_utterance(tmp_path):
    proj = _project_with_transcript(tmp_path)
    tid, source_id, start, _end, text = time_range_from_utterance(proj.combined_transcript, 0)
    assert tid == "host"
    assert source_id is None
    assert start == 0.0
    assert "coffee" in text


def test_time_range_from_utterance_out_of_range(tmp_path):
    proj = _project_with_transcript(tmp_path)
    with pytest.raises(ValueError, match="out of range"):
        time_range_from_utterance(proj.combined_transcript, 99)


def test_append_remove_decision_stores_cut_metadata(tmp_path):
    proj = _project_with_media(tmp_path)
    decision = append_remove_decision(
        proj,
        "host",
        1.0,
        2.0,
        reason="test",
        cut_confidence=0.85,
        boundary_mode="vocal_transcript_guided",
        defaults=load_defaults(),
    )
    assert decision.cut_confidence == 0.85
    assert decision.boundary_mode == "vocal_transcript_guided"


def test_append_remove_decision(tmp_path):
    proj = _project_with_media(tmp_path)
    decision = append_remove_decision(
        proj, "host", 1.0, 2.0, reason="test", defaults=load_defaults()
    )
    assert decision.reason == "test"
    assert decision.applied is False
    assert len(proj.edit_decisions) == 1


def test_append_remove_decision_invalid_range(tmp_path):
    proj = _project_with_media(tmp_path)
    with pytest.raises(ValueError, match="end must be greater"):
        append_remove_decision(proj, "host", 2.0, 1.0, defaults=load_defaults())


def test_add_remove_decision_invalid_range(tmp_path):
    proj = _project_with_media(tmp_path)
    with pytest.raises(ValueError, match="end must be greater"):
        cut_time_range(proj, "host", 2.0, 1.0, defaults=load_defaults())


def test_add_remove_decision_stores_cut_metadata(tmp_path, monkeypatch):
    from podcast_mcp.edits import transcript_cuts as tc
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _fake_opt(project, track_id, start, end, force_enabled=None, **_kw):
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
    proj = _project_with_media(tmp_path)
    decision = tc.add_remove_decision(
        proj, "host", 1.0, 2.0, reason="nl:test", defaults=load_defaults()
    )
    assert decision.start == pytest.approx(1.01)
    assert decision.end == pytest.approx(1.99)
    assert decision.cut_confidence == 0.91
    assert decision.boundary_mode == "vocal_transcript_guided"


def test_trailing_energy_extends_when_next_word_overlaps(tmp_path, monkeypatch):
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

    def _fake_opt(project, track_id, start, end, force_enabled=None, **_kw):
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
        "podcast_mcp.edits.transcript_cuts.resolve_cut_scope",
        lambda *a, **k: ResolvedCutScope("session_clear", None),
    )
    proj = _project_with_media(tmp_path)
    decision = tc.add_remove_decision(
        proj, "host", 1.0, 1.4, reason="nl:words", defaults=load_defaults()
    )
    assert decision.end == pytest.approx(1.62)
    # The pad is paced from the span shipped: 0.85 x 0.62 s.
    assert decision.replace_gap_sec == pytest.approx(0.527)


def test_trailing_energy_clamped_when_next_word_has_lead_in(tmp_path, monkeypatch):
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

    def _fake_opt(project, track_id, start, end, force_enabled=None, **_kw):
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
        "podcast_mcp.edits.transcript_cuts.resolve_cut_scope",
        lambda *a, **k: ResolvedCutScope("session_clear", None),
    )
    proj = _project_with_media(tmp_path)
    decision = tc.add_remove_decision(
        proj, "host", 1.0, 1.4, reason="nl:words", defaults=load_defaults()
    )
    assert decision.end == pytest.approx(1.50)
    assert decision.replace_gap_sec == pytest.approx(0.425)


def test_coalesce_edits_track_filter(tmp_path):
    proj = _project_with_media(tmp_path)
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
    merged = coalesce_edits(proj, track_id="host", defaults=load_defaults())
    assert merged == 0
    assert len(proj.edit_decisions) == 2


def test_coalesce_edits_non_adjacent(tmp_path):
    proj = _project_with_media(tmp_path)
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
    merged = coalesce_edits(proj, defaults=load_defaults())
    assert merged == 0
    assert len(proj.edit_decisions) == 2


def test_coalesce_keeps_reviewable_restart_and_neighbors_separate(tmp_path):
    proj = _project_with_media(tmp_path)
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

    assert coalesce_edits(proj, defaults=load_defaults()) == 0
    assert [(edit.id, edit.reason) for edit in proj.edit_decisions] == [
        ("filler", "filler:um"),
        ("restart", "restart:partial:w"),
        ("repeat", "repetition:word:i"),
        ("pause", "pause:1.0s"),
    ]


def test_cut_text_match_no_matches(tmp_path):
    proj = _project_with_transcript(tmp_path)
    assert cut_text_match(proj, "nonexistent phrase", defaults=load_defaults()) == []


def test_cut_utterance(tmp_path):
    proj = _project_with_transcript(tmp_path)
    decision = cut_utterance(proj, 0, review_required=False, defaults=load_defaults())
    assert decision.track_id == "host"
    assert decision.reason.startswith("nl:utterance:")


def test_cut_words(tmp_path):
    proj = _project_with_transcript(tmp_path)
    decision = cut_words(proj, "host", 3, 4, review_required=False, defaults=load_defaults())
    assert decision.track_id == "host"
    assert decision.reason == "nl:words"


def test_cut_words_no_transcript(tmp_path):
    proj = _project_with_media(tmp_path)
    with pytest.raises(ValueError, match="No transcript"):
        cut_words(proj, "host", 0, 1, defaults=load_defaults())


def test_transcript_cuts_resolve_source_and_placement(tmp_path):
    proj = _project_with_media(tmp_path)
    proj.clips = [
        Clip(
            id="take-a",
            track_id="host",
            source_id="A",
            source_start=0,
            source_end=10,
            timeline_start=0,
        ),
        Clip(
            id="take-b",
            track_id="host",
            source_id="B",
            source_start=0,
            source_end=10,
            timeline_start=10,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host", source_id="A", words=[TranscriptWord(text="alpha", start=0, end=0.4)]
        ),
        Transcript(
            track_id="host", source_id="B", words=[TranscriptWord(text="beta", start=0, end=0.4)]
        ),
    ]
    proj.sources = [
        SourceRecording(id="A", path="raw/take-a.wav"),
        SourceRecording(id="B", path="raw/take-b.wav"),
    ]
    by_word = cut_words(
        proj, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    assert by_word.exact_range is None
    assert by_word.source_id == "B"
    assert by_word.source_timeline_span.start == 10
    assert by_word.source_timeline_span.end == 10.4

    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host", speaker="Host", start=0, end=0.4, text="alpha", source_id="A"
            ),
            CombinedUtterance(
                track_id="host", speaker="Host", start=0, end=0.4, text="beta", source_id="B"
            ),
        ]
    )
    by_utterance = cut_utterance(proj, 1, use_inaudible_opt=False, defaults=load_defaults())
    assert by_utterance.source_id == "B"
    assert by_utterance.source_timeline_span.start == 10
    saved = load_project(save_project(proj, tmp_path / "episode.sharecut"))
    persisted = next(row for row in saved.edit_decisions if row.id == by_word.id)
    assert persisted.source_id == "B"
    assert persisted.source_timeline_span.start == 10


def test_transcript_cut_uses_selected_source_under_session_ripple(tmp_path, monkeypatch):
    proj = _project_with_media(tmp_path)
    proj.clips = [
        Clip(
            id="take-a",
            track_id="host",
            source_id="A",
            source_start=0,
            source_end=10,
            timeline_start=0,
        ),
        Clip(
            id="take-b",
            track_id="host",
            source_id="B",
            source_start=0,
            source_end=10,
            timeline_start=20,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host", source_id="A", words=[TranscriptWord(text="alpha", start=0.1, end=0.4)]
        ),
        Transcript(
            track_id="host", source_id="B", words=[TranscriptWord(text="beta", start=0.1, end=0.4)]
        ),
    ]
    proj.sources = [
        SourceRecording(id="A", path="raw/take-a.wav"),
        SourceRecording(id="B", path="raw/take-b.wav"),
    ]
    a_before = proj.clips[0].model_dump(mode="json")
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.resolve_cut_scope",
        lambda *args, **kwargs: ResolvedCutScope("session_clear"),
    )

    decision = cut_words(
        proj, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )

    assert decision.source_id == "B"
    assert decision.source_timeline_span.start == 20.1
    assert decision.source_timeline_span.end == pytest.approx(20.4)

    saved = load_project(save_project(proj, tmp_path / "episode.sharecut"))
    persisted = next(row for row in saved.edit_decisions if row.id == decision.id)
    assert persisted.source_id == "B"
    assert persisted.source_timeline_span.start == 20.1
    assert persisted.source_timeline_span.end == pytest.approx(20.4)

    assert approve_edits(proj, [decision.id], defaults=load_defaults()) == 1

    assert proj.clips[0].model_dump(mode="json") == a_before
    b_segments = sorted(
        (
            clip.source_start,
            clip.source_end,
            clip.timeline_start,
            clip.timeline_end,
        )
        for clip in proj.clips
        if clip.source_id == "B"
    )
    assert b_segments == [
        pytest.approx((0, 0.1, 20, 20.1)),
        pytest.approx((0.4, 10, 20.1, 29.7)),
    ]


def test_transcript_cut_refuses_overlapping_unselected_source_without_mutation(
    tmp_path, monkeypatch
):
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    proj = _project_with_media(tmp_path)
    proj.clips = [
        Clip(
            id="take-a",
            track_id="host",
            source_id="A",
            source_start=0,
            source_end=10,
            timeline_start=0,
        ),
        Clip(
            id="take-b",
            track_id="host",
            source_id="B",
            source_start=0,
            source_end=10,
            timeline_start=0,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host", source_id="A", words=[TranscriptWord(text="alpha", start=0.1, end=0.4)]
        ),
        Transcript(
            track_id="host", source_id="B", words=[TranscriptWord(text="beta", start=0.1, end=0.4)]
        ),
    ]
    proj.sources = [
        SourceRecording(id="A", path="raw/take-a.wav"),
        SourceRecording(id="B", path="raw/take-b.wav"),
    ]
    before = proj.model_dump(mode="json")
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.resolve_cut_scope",
        lambda *args, **kwargs: ResolvedCutScope("session_clear"),
    )

    with pytest.raises(ScopeChangedAtApproval, match="selected audio"):
        cut_words(proj, "host", 0, 0, source_id="B", defaults=load_defaults())

    assert proj.model_dump(mode="json") == before


def test_transcript_cut_holds_if_selected_source_moves_before_approval(tmp_path):
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    proj = _project_with_media(tmp_path)
    proj.clips = [
        Clip(
            id="take-b",
            track_id="host",
            source_id="B",
            source_start=0,
            source_end=10,
            timeline_start=10,
        )
    ]
    proj.sources = [SourceRecording(id="B", path="raw/take-b.wav")]
    proj.transcripts = [
        Transcript(
            track_id="host", source_id="B", words=[TranscriptWord(text="beta", start=0.1, end=0.4)]
        )
    ]
    decision = cut_words(proj, "host", 0, 0, source_id="B", defaults=load_defaults())
    proj.clips[0].timeline_start = 20

    with pytest.raises(ScopeChangedAtApproval, match="selected audio no longer has"):
        approve_edits(proj, [decision.id], defaults=load_defaults())

    assert [(clip.timeline_start, clip.source_start, clip.source_end) for clip in proj.clips] == [
        (20, 0, 10)
    ]


def test_combined_projection_rebuilds_from_saved_current_source_transcripts(tmp_path):
    proj = _project_with_media(tmp_path)
    proj.transcripts = [
        Transcript(
            track_id="host", source_id="A", words=[TranscriptWord(text="alpha", start=0, end=0.4)]
        ),
        Transcript(
            track_id="host",
            source_id="B",
            user_edited=True,
            words=[
                TranscriptWord(
                    text="beta",
                    start=0,
                    end=0.4,
                    suppressed=True,
                    audibility_locked=True,
                    timing_edited=True,
                )
            ],
        ),
    ]
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=0, end=0.4, text="old cache")
        ]
    )
    path = save_project(proj, tmp_path / "episode.sharecut")

    reloaded = load_project(path)
    rebuilt = ensure_combined_transcript(reloaded, defaults=load_defaults())
    assert [(u.source_id, u.text) for u in rebuilt.utterances] == [("A", "alpha")]
    edited = reloaded.transcript_for_source("host", "B")
    assert edited is not None
    assert edited.user_edited is True
    assert edited.words[0].suppressed is True
    assert edited.words[0].audibility_locked is True
    assert edited.words[0].timing_edited is True

    reloaded.transcripts[1].words[0] = (
        reloaded.transcripts[1]
        .words[0]
        .model_copy(update={"text": "beta changed", "suppressed": False})
    )
    reloaded.transcripts[1].user_edited = True
    current = ensure_combined_transcript(reloaded, defaults=load_defaults())
    assert [u.text for u in current.utterances] == ["alpha", "beta changed"]


def test_format_transcript_timestamps(tmp_path):
    proj = _project_with_transcript(tmp_path)
    text = format_transcript_timestamps(proj, defaults=load_defaults())
    assert "[0]" in text
    assert "Host" in text
    assert "coffee" in text


def _spans(proj: EpisodeProject) -> list[tuple[str, float, float, bool]]:
    return sorted(
        (e.reason.split(":")[0], e.start, e.end, e.review_required) for e in proj.edit_decisions
    )


def test_coalesce_keeps_a_pause_trim_waiting_for_review_apart_from_the_filler_beside_it(tmp_path):
    # Every pause trim waits for the owner's listen (#1055). Merged into the filler next
    # to it, the trim would hold the filler back from applying on its own.
    proj = _project_with_media(tmp_path)
    _pending(proj, "host", 1.0, 1.3, reason="filler:um", review_required=False)
    _pending(proj, "host", 1.3, 2.4, reason="pause:1.10s", review_required=True)

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 0
    assert _spans(proj) == [("filler", 1.0, 1.3, False), ("pause", 1.3, 2.4, True)]


def test_coalesce_keeps_pause_trims_apart_from_each_other_and_from_cuts_waiting_for_review(
    tmp_path,
):
    proj = _project_with_media(tmp_path)
    _pending(proj, "host", 1.0, 1.3, reason="pause:0.3s", review_required=True)
    _pending(proj, "host", 1.3, 1.6, reason="pause:0.3s", review_required=True)
    _pending(proj, "host", 1.6, 1.9, reason="filler:um", review_required=True)

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 0
    assert _spans(proj) == [
        ("filler", 1.6, 1.9, True),
        ("pause", 1.0, 1.3, True),
        ("pause", 1.3, 1.6, True),
    ]


def _labelled(proj: EpisodeProject) -> list[tuple[float, float, str, bool, str]]:
    return sorted(
        (e.start, e.end, e.reason, e.review_required, e.scope) for e in proj.edit_decisions
    )


def test_coalesce_never_chains_a_review_filler_a_pause_and_an_auto_filler_into_one_cut(tmp_path):
    # The pause is the review item between them: the filler after it stays one that
    # applies on its own, and the pause keeps its label and its air_edges flag.
    proj = _project_with_media(tmp_path)
    _pending(proj, "host", 1.0, 1.3, reason="filler:um:risky", review_required=True)
    _pending(proj, "host", 1.3, 2.4, reason="pause:1.10s:air_edges", review_required=True)
    _pending(proj, "host", 2.4, 2.6, reason="filler:uh", review_required=False)

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 0
    assert _labelled(proj) == [
        (1.0, 1.3, "filler:um:risky", True, "session"),
        (1.3, 2.4, "pause:1.10s:air_edges", True, "session"),
        (2.4, 2.6, "filler:uh", False, "session"),
    ]


@pytest.mark.parametrize(
    ("reason", "scope"),
    [("filler:um:other_speaking:guest", "track"), ("nl:range", "session")],
)
def test_coalesce_never_absorbs_a_session_pause_into_a_cut_that_is_not_its_own(
    tmp_path, reason, scope
):
    proj = _project_with_media(tmp_path)
    first = _pending(proj, "host", 1.0, 1.3, reason=reason, review_required=True)
    first.scope = scope
    _pending(proj, "host", 1.3, 2.4, reason="pause:1.10s", review_required=True)

    assert coalesce_edits(proj, track_id="host", defaults=load_defaults()) == 0
    assert _labelled(proj) == [
        (1.0, 1.3, reason, True, scope),
        (1.3, 2.4, "pause:1.10s", True, "session"),
    ]
