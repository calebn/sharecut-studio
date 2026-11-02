from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.verdict_cache import _heard
from podcast_mcp.engines.asr_silence import placement_digest
from podcast_mcp.engines.clips_ops import extract_clips_in_timeline_range
from podcast_mcp.engines.lane_window import lane_clip_placements, lane_placements
from podcast_mcp.engines.lane_words import lane_transcripts
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.clip_timing import ClipTiming, QuietSpan, TimingStep

# Source 0-10 s at timeline 5 s: a 2 s hole at source 4 s and a skip of source 8-9 s.
# It plays as source [0,4) at 5, [4,8) at 11 and [9,10) at 15; it ends at 16.
PIECES = [(0.0, 4.0, 5.0), (4.0, 8.0, 11.0), (9.0, 10.0, 15.0)]


def _timing(*, hole: float = 2.0) -> ClipTiming:
    return ClipTiming(
        steps=[
            TimingStep(at=4.0, delta_sec=hole),
            TimingStep(at=8.0, delta_sec=-1.0, quiet=QuietSpan(start_s=7.9, end_s=9.1)),
        ]
    )


def _clip(timing: ClipTiming | None, *, clip_id: str = "c") -> Clip:
    return Clip(
        id=clip_id,
        track_id="host",
        source_id="take",
        source_start=0.0,
        source_end=10.0,
        timeline_start=5.0,
        timing=timing,
    )


def _project(tmp_path: Path, clip: Clip) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [Track(id="host", label="host", role=TrackRole.DIALOGUE)]
    project.clips = [clip]
    return project


def test_the_fixture_clip_plays_as_three_pieces() -> None:
    clip = _clip(_timing())

    assert clip.virtual_pieces() == PIECES
    assert clip.timeline_end == 16.0


def test_the_placement_digest_follows_the_timing_steps(tmp_path: Path) -> None:
    untimed = placement_digest(_project(tmp_path, _clip(None)))
    timed = placement_digest(_project(tmp_path, _clip(_timing())))
    retimed = placement_digest(_project(tmp_path, _clip(_timing(hole=3.0))))

    assert len({untimed, timed, retimed}) == 3


def test_an_untimed_placement_digest_is_the_old_row_digest(tmp_path: Path) -> None:
    from podcast_mcp.util.hashing import short_digest

    project = _project(tmp_path, _clip(None))

    assert placement_digest(project) == short_digest(repr([("host", "take", 0.0, 10.0, 5.0)]))


def test_the_heard_key_follows_the_timing_steps() -> None:
    untimed = _heard(_clip(None), 0.0, 100.0)
    timed = _heard(_clip(_timing()), 0.0, 100.0)
    retimed = _heard(_clip(_timing(hole=3.0)), 0.0, 100.0)

    assert timed != untimed
    assert timed != retimed
    assert timed[-1] == [[4.0, 2.0], [8.0, -1.0]]


def test_an_untimed_heard_key_has_no_timing_part() -> None:
    clip = _clip(None)

    assert _heard(clip, 0.0, 100.0) == [
        "host",
        "take",
        5.0,
        0.0,
        10.0,
        5.0,
        15.0,
        clip.fade_in_ms,
        clip.fade_out_ms,
        clip.join_in_mode.value,
        [],
        [],
        None,
    ]


def test_extract_carries_the_timing_inside_the_extracted_source() -> None:
    clip = _clip(_timing())

    (whole,) = extract_clips_in_timeline_range([clip], 0.0, 100.0)
    assert whole.timing == clip.timing
    assert whole.timeline_end == pytest.approx(16.0)

    (head,) = extract_clips_in_timeline_range([clip], 5.0, 11.0)
    assert (head.source_start, head.source_end) == (0.0, 4.0)
    assert head.timing is None


def test_extract_keeps_only_the_steps_inside_the_sliced_range() -> None:
    clip = _clip(_timing())

    (tail,) = extract_clips_in_timeline_range([clip], 11.0, 100.0)

    assert (tail.source_start, tail.source_end) == (4.0, 10.0)
    assert tail.timing is not None
    assert [(s.at, s.delta_sec) for s in tail.timing.steps] == [(8.0, -1.0)]
    assert tail.timeline_end == pytest.approx(5.0)


def test_extracting_an_untimed_clip_leaves_timing_unset() -> None:
    (got,) = extract_clips_in_timeline_range([_clip(None)], 6.0, 9.0)

    assert got.timing is None
    assert (got.source_start, got.source_end, got.timeline_start) == (1.0, 4.0, 0.0)


def test_a_timed_clip_is_one_placement_per_piece(tmp_path: Path) -> None:
    project = _project(tmp_path, _clip(_timing()))
    track = project.track_by_id("host")

    pairs = lane_clip_placements(project, track)

    assert [(p.src_start, p.src_end, p.tl_start, p.tl_end) for _, p in pairs] == [
        (0.0, 4.0, 5.0, 9.0),
        (4.0, 8.0, 11.0, 15.0),
        (9.0, 10.0, 15.0, 16.0),
    ]
    assert {c.id for c, _ in pairs} == {"c"}
    assert [p.to_session(s) for (_, p), s in zip(pairs, (3.0, 5.0, 9.5), strict=True)] == [
        8.0,
        12.0,
        15.5,
    ]


def test_pieces_that_touch_in_both_clocks_join_and_a_hole_does_not(tmp_path: Path) -> None:
    project = _project(tmp_path, _clip(_timing()))

    got = lane_placements(project, project.track_by_id("host"))

    assert [(p.src_start, p.tl_start, p.tl_end) for p in got] == [
        (0.0, 5.0, 9.0),
        (4.0, 11.0, 15.0),
        (9.0, 15.0, 16.0),
    ]


def test_an_untimed_clip_keeps_its_single_placement(tmp_path: Path) -> None:
    project = _project(tmp_path, _clip(None))

    (pair,) = lane_clip_placements(project, project.track_by_id("host"))

    placement = pair[1]
    assert (placement.src_start, placement.src_end, placement.tl_start, placement.tl_end) == (
        0.0,
        10.0,
        5.0,
        15.0,
    )
    assert placement.excluded_word_spans == ()


def _lane_words(tmp_path: Path, clip: Clip):
    project = _project(tmp_path, clip)
    project.transcripts = [
        Transcript(
            track_id="host",
            source_id="take",
            words=[
                TranscriptWord(text=f"w{n}", start=s, end=s + 0.4, confidence=0.9)
                for n, s in enumerate((1.0, 5.0, 9.2))
            ],
        )
    ]
    (lane,) = lane_transcripts(project, "host")
    return lane


def test_a_word_after_a_step_reads_through_its_own_pieces_shift(tmp_path: Path) -> None:
    lane = _lane_words(tmp_path, _clip(_timing()))

    assert lane.session_span(1.0, 1.4) == pytest.approx((6.0, 6.4))
    assert lane.session_span(5.0, 5.4) == pytest.approx((12.0, 12.4))
    assert lane.session_span(9.2, 9.6) == pytest.approx((15.2, 15.6))


def test_an_untimed_word_reads_through_one_offset(tmp_path: Path) -> None:
    lane = _lane_words(tmp_path, _clip(None))

    assert [lane.session_span(s, s + 0.4) for s in (1.0, 5.0, 9.2)] == pytest.approx(
        [(6.0, 6.4), (10.0, 10.4), (14.2, 14.6)]
    )
