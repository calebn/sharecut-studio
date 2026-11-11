from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.asr_silence import placement_digest
from podcast_mcp.engines.clips_ops import extract_clips_in_timeline_range
from podcast_mcp.engines.lane_window import lane_clip_placements, lane_placements
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    Track,
    TrackRole,
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


def test_extract_carries_the_timing_inside_the_extracted_source() -> None:
    clip = _clip(_timing())

    (whole,) = extract_clips_in_timeline_range([clip], 0.0, 100.0, cut_fade_ms=None)
    assert whole.timing == clip.timing
    assert whole.timeline_end == pytest.approx(16.0)

    (head,) = extract_clips_in_timeline_range([clip], 5.0, 11.0, cut_fade_ms=None)
    assert (head.source_start, head.source_end) == (0.0, 4.0)
    assert head.timing is None


def test_extract_keeps_only_the_steps_inside_the_sliced_range() -> None:
    clip = _clip(_timing())

    (tail,) = extract_clips_in_timeline_range([clip], 11.0, 100.0, cut_fade_ms=None)

    assert (tail.source_start, tail.source_end) == (4.0, 10.0)
    assert tail.timing is not None
    assert [(s.at, s.delta_sec) for s in tail.timing.steps] == [(8.0, -1.0)]
    assert tail.timeline_end == pytest.approx(5.0)


def test_extracting_an_untimed_clip_leaves_timing_unset() -> None:
    (got,) = extract_clips_in_timeline_range([_clip(None)], 6.0, 9.0, cut_fade_ms=None)

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


def test_a_hole_or_a_skip_between_pieces_keeps_them_separate_stretches(tmp_path: Path) -> None:
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


@pytest.mark.parametrize(
    ("window", "first_source", "first_timeline"),
    [
        ((9.0, 12.0), 4.0, 2.0),
        ((9.5, 100.0), 4.0, 1.5),
        ((7.0, 100.0), 2.0, 0.0),
        ((11.0, 100.0), 4.0, 0.0),
        ((9.0, 100.0), 4.0, 2.0),
    ],
)
def test_extract_places_a_window_opening_in_a_hole_at_the_next_piece(
    window: tuple[float, float], first_source: float, first_timeline: float
) -> None:
    clip = _clip(_timing())

    got = extract_clips_in_timeline_range([clip], *window, cut_fade_ms=None)

    assert (got[0].source_start, got[0].timeline_start) == pytest.approx(
        (first_source, first_timeline)
    )


def test_a_timed_peer_clip_is_laid_out_once_per_piece_in_a_removal(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.edits.speech_energy_guard import _removal_cells
    from podcast_mcp.models import MediaAsset

    timing = ClipTiming(steps=[TimingStep(at=4.0, delta_sec=2.0)])
    project = _project(tmp_path, _clip(timing))
    track = project.track_by_id("host")
    track.media = MediaAsset(path="raw/h.wav", duration_sec=60, sample_rate=16_000, channels=1)

    got = _removal_cells(
        project, "host", 0.0, 60.0, None, removal_span=(12.0, 13.0), defaults=load_defaults()
    )

    assert got.sole == [(round(12.0 * got.rate), round(13.0 * got.rate))]
    assert got.shared == []
    assert [(run.dest, run.length) for run in got.runs] == [(got.sole[0][0], got.rate)]
    assert got.runs[0].first == round(5.0 * got.rate)


def test_an_untimed_peer_clip_removal_is_one_stretch(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.edits.speech_energy_guard import _removal_cells
    from podcast_mcp.models import MediaAsset

    project = _project(tmp_path, _clip(None))
    project.track_by_id("host").media = MediaAsset(
        path="raw/h.wav", duration_sec=60, sample_rate=16_000, channels=1
    )

    got = _removal_cells(
        project, "host", 0.0, 60.0, None, removal_span=(7.0, 8.0), defaults=load_defaults()
    )

    assert got.sole == [(7 * got.rate, 8 * got.rate)]
    assert [(r.dest, r.first, r.length) for r in got.runs] == [
        (7 * got.rate, 2 * got.rate, got.rate)
    ]


def test_a_mute_region_across_a_step_is_excluded_in_each_piece_it_touches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from podcast_mcp.engines import lane_window
    from podcast_mcp.models import ClipMuteRegion

    media = tmp_path / "raw" / "h.wav"
    monkeypatch.setattr(lane_window, "resolve_clip_audio_path", lambda *_: media)
    monkeypatch.setattr(lane_window, "probe_media", lambda _: SimpleNamespace(sample_rate=1000))
    clip = _clip(_timing())
    clip.mute_regions = [ClipMuteRegion(start_s=3.0, end_s=5.0, fade_out_ms=0, fade_in_ms=0)]
    project = _project(tmp_path, clip)

    pairs = lane_clip_placements(project, project.track_by_id("host"))

    spans = [p.excluded_word_spans for _, p in pairs]
    assert [len(piece) for piece in spans] == [1, 1, 0]
    assert spans[0][0] == pytest.approx((3.0, 4.0), abs=2e-3)
    assert spans[1][0] == pytest.approx((4.0, 5.0), abs=2e-3)


def test_a_removal_across_a_hole_covers_only_the_source_that_plays(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.edits.speech_energy_guard import _removal_cells
    from podcast_mcp.models import MediaAsset

    timing = ClipTiming(steps=[TimingStep(at=4.0, delta_sec=2.0)])
    project = _project(tmp_path, _clip(timing))
    project.track_by_id("host").media = MediaAsset(
        path="raw/h.wav", duration_sec=60, sample_rate=16_000, channels=1
    )

    got = _removal_cells(
        project, "host", 0.0, 60.0, None, removal_span=(8.0, 12.0), defaults=load_defaults()
    )

    rate = got.rate
    assert got.sole == [(8 * rate, 9 * rate), (11 * rate, 12 * rate)]
    assert got.shared == []
    assert [(r.dest, r.first, r.length) for r in got.runs] == [
        (8 * rate, 3 * rate, rate),
        (11 * rate, 4 * rate, rate),
    ]
