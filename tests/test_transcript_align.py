from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.transcript_align import (
    WordToken,
    _first_phrase_before,
    cross_speaker_offsets_from_transcripts,
    find_phrase_interval,
    load_transcripts,
    offset_from_anchor,
    offset_turn_taking_score,
)


def test_find_phrase_interval() -> None:
    words = [
        WordToken("how", 1.0, 1.2, 0.9),
        WordToken("is", 1.2, 1.4, 0.9),
        WordToken("today", 1.4, 1.8, 0.9),
        WordToken("going", 1.8, 2.1, 0.9),
    ]
    hit = find_phrase_interval(words, "today going")
    assert hit == (1.4, 2.1)


def test_offset_turn_taking_prefers_less_overlap() -> None:
    ref = [(0.0, 2.0), (4.0, 6.0)]
    src = [(3.0, 5.0), (7.0, 9.0)]
    result = offset_turn_taking_score(ref, src)
    assert result.offset_sec != 0.0
    assert result.overlap_sec <= result.overlap_at_zero_sec


def test_interval_duration_and_overlap_sweep() -> None:
    from podcast_mcp.engines.transcript_align import interval_duration, overlap_duration

    a = [(0.0, 2.0), (4.0, 6.0)]
    b = [(1.0, 5.0)]
    assert interval_duration(a) == 4.0
    assert overlap_duration(a, b) == 2.0


def test_canned_fixture_anchor_offset() -> None:
    words = load_transcripts(Path("tests/fixtures/canned_transcript_aligned.json"))
    results = cross_speaker_offsets_from_transcripts(
        [("reference", "reference"), ("guest", "guest")],
        words,
        anchors=[
            {
                "reference_speaker": "reference",
                "reference_contains": "today going",
                "source_speaker": "guest",
                "source_contains": "been great",
                "gap_sec": 1.0,
            }
        ],
    )
    guest = results["guest"]
    assert guest.method == "anchor"
    assert guest.offset_sec != 0.0 or guest.anchor_detail


def test_find_phrase_interval_edge_cases():
    assert find_phrase_interval([], "hello") is None
    assert find_phrase_interval([WordToken("hi", 0, 0.5, 0.9)], "") is None
    words = [WordToken("hello", 1.0, 1.5, 0.2)]
    assert find_phrase_interval(words, "hello", min_confidence=0.5) is None
    single = [WordToken("world", 2.0, 2.4, 0.9)]
    assert find_phrase_interval(single, "world") == (2.0, 2.4)


def test_first_phrase_before_filters_by_time():
    words = [
        WordToken("early", 1.0, 1.2, 0.9),
        WordToken("late", 5.0, 5.2, 0.9),
    ]
    assert _first_phrase_before(words, "late", before_sec=2.0) is None
    assert _first_phrase_before(words, "early", before_sec=2.0) == (1.0, 1.2)


def test_offset_from_anchor_start_mode():
    ref = [WordToken("ref", 1.0, 2.0, 0.9)]
    src = [WordToken("src", 4.0, 5.0, 0.9)]
    result = offset_from_anchor(
        ref,
        src,
        reference_contains="ref",
        source_contains="src",
        align_to="start",
    )
    assert result is not None
    assert result.offset_sec == -3.0


def test_cross_speaker_offsets_turn_taking_fallback():
    words = {
        "host": [WordToken("hi", 0.0, 1.0, 0.9)],
        "guest": [WordToken("hey", 3.0, 4.0, 0.9)],
    }
    results = cross_speaker_offsets_from_transcripts(
        [("host", "host"), ("guest", "guest")],
        words,
    )
    assert results["host"].method == "reference"
    assert results["guest"].method == "turn_taking"


def test_cross_speaker_offsets_anchor_start_align():
    ref_words = [WordToken("open", 1.0, 1.5, 0.9)]
    guest_words = [WordToken("start", 3.0, 3.5, 0.9)]
    results = cross_speaker_offsets_from_transcripts(
        [("host", "host"), ("guest", "guest")],
        {"host": ref_words, "guest": guest_words},
        anchors=[
            {
                "reference_speaker": "host",
                "reference_contains": "open",
                "source_speaker": "guest",
                "source_contains": "start",
                "align_to": "start",
            }
        ],
    )
    assert results["guest"].method == "anchor"


def test_offset_turn_taking_empty_intervals():
    empty = offset_turn_taking_score([], [(0.0, 1.0)])
    assert empty.method == "turn_taking"
    assert empty.offset_sec == 0.0


def test_cross_speaker_offsets_empty_speakers():
    assert cross_speaker_offsets_from_transcripts([], {}) == {}


def test_offset_turn_taking_hierarchical_and_cancel() -> None:
    ref = [(0.0, 1.0), (10.0, 11.0)]
    src = [(5.0, 6.0), (15.0, 16.0)]
    result = offset_turn_taking_score(ref, src, max_offset_sec=200.0, step_sec=0.5)
    assert result.method == "turn_taking"
    with pytest.raises(RuntimeError, match="cancelled"):
        offset_turn_taking_score(ref, src, max_offset_sec=200.0, cancel_check=lambda: True)


def test_hierarchical_finds_eight_sec_peak_when_bound_not_multiple_of_eight() -> None:
    """Stage-1 must sample through 0 so +8.0 stays on an 8s grid.

    With max_offset=474.132 (not a multiple of 8), a sweep that starts at
    -max_offset never lands on +8.0 and can lock onto a distant local basin.
    """
    # Three source islands that only all sit in host silences at +8.0.
    # A lone silence near 148s is a weaker local basin for a misaligned grid.
    ref = [(0.0, 8.0), (12.0, 18.0), (22.0, 28.0), (32.0, 148.0), (152.0, 200.0)]
    src = [(0.0, 3.5), (10.0, 13.5), (20.0, 23.5)]
    # Force hierarchical: 474.132 / 0.5 > 240
    result = offset_turn_taking_score(ref, src, max_offset_sec=474.132, step_sec=0.5)
    assert result.method == "turn_taking"
    assert abs(result.offset_sec - 8.0) < 1.0, result.offset_sec
    assert abs(result.offset_sec - 148.0) > 20.0


def test_hierarchical_result_stays_within_max_offset() -> None:
    """Zoom stages may propose past the bound; clamped samples stay searchable."""
    ref = [(0.0, 1.0), (10.0, 11.0)]
    src = [(5.0, 6.0), (15.0, 16.0)]
    result = offset_turn_taking_score(ref, src, max_offset_sec=200.0, step_sec=0.5)
    assert result.method == "turn_taking"
    assert abs(result.offset_sec) <= 200.0 + 1e-6


def test_gap_offset_prior_and_cancel() -> None:
    from podcast_mcp.edits.conversation_align import gap_offset_coarse_fine

    ref = [(0.0, 2.0), (10.0, 12.0)]
    src = [(3.0, 5.0), (13.0, 15.0)]
    first = gap_offset_coarse_fine(
        ref,
        src,
        max_offset_sec=30.0,
        coarse_step=0.5,
        fine_step=0.1,
    )
    prior = gap_offset_coarse_fine(
        ref,
        src,
        max_offset_sec=30.0,
        coarse_step=0.5,
        fine_step=0.1,
        prior_offset=first.offset_sec,
        require_clear_over_prior=True,
    )
    assert prior.method == "gaps_prior"
    assert prior.offset_sec == first.offset_sec
    calls = {"n": 0}

    def cancel_after_coarse() -> bool:
        calls["n"] += 1
        # Linear coarse for max=20 / step=0.5 is ~81 samples; trip during fine refine.
        return calls["n"] > 90

    with pytest.raises(RuntimeError, match="cancelled"):
        gap_offset_coarse_fine(
            ref,
            src,
            max_offset_sec=20.0,
            coarse_step=0.5,
            fine_step=0.1,
            cancel_check=cancel_after_coarse,
        )


def test_turn_taking_score_at_matches_search_score() -> None:
    from podcast_mcp.engines.transcript_align import turn_taking_score_at

    ref = [(0.0, 2.0), (4.0, 6.0)]
    src = [(3.0, 5.0)]
    score, both = turn_taking_score_at(ref, src, 0.0)
    assert both > 0
    assert score == pytest.approx(turn_taking_score_at(ref, src, 0.0)[0])
