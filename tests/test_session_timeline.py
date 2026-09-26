from __future__ import annotations

import pytest

from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    _build_index,
    clip_timeline_overlap_to_source,
    clip_timeline_point_to_source,
    map_timeline_spans_over_clips,
    origin_track_id_for_clip,
    timebase_qc_report,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.timebase import SourceSec, TimelineSec


def _project(tmp_path, clips: list[Clip]) -> EpisodeProject:
    p = EpisodeProject.create("st_test", str(tmp_path / "ws"))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=300.0),
        )
    ]
    p.timeline.clips = clips
    return p


def _compressed_clips() -> list[Clip]:
    """Source 0-60 kept, 60-90 cut, 90-200 kept, 200-220 cut, 220-300 kept."""
    return [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=60.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=90.0, source_end=200.0, timeline_start=60.0),
        Clip(id="c3", track_id="host", source_start=220.0, source_end=300.0, timeline_start=170.0),
    ]


@pytest.fixture
def identity_project(tmp_path):
    return _project(
        tmp_path,
        [Clip(id="c1", track_id="host", source_start=0.0, source_end=300.0, timeline_start=0.0)],
    )


@pytest.fixture
def compressed_project(tmp_path):
    return _project(tmp_path, _compressed_clips())


def test_identity_maps_both_ways(identity_project):
    st = SessionTimeline(identity_project)
    assert st.is_identity("host")
    assert st.source_to_timeline("host", SourceSec(42.0)) == pytest.approx(42.0)
    assert st.timeline_to_source("host", TimelineSec(42.0)) == pytest.approx(42.0)
    assert st.max_drift("host") == 0.0


def test_no_clips_is_identity(tmp_path):
    p = _project(tmp_path, [])
    st = SessionTimeline(p)
    assert st.is_identity("host")
    assert st.source_to_timeline("host", SourceSec(7.0)) == pytest.approx(7.0)
    assert st.timeline_to_source("host", TimelineSec(7.0)) == pytest.approx(7.0)
    assert st.map_source_span("host", SourceSec(1.0), SourceSec(2.0)) == [(1.0, 2.0)]


def test_source_to_timeline_after_cuts(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.source_to_timeline("host", SourceSec(30.0)) == pytest.approx(30.0)
    assert st.source_to_timeline("host", SourceSec(100.0)) == pytest.approx(70.0)
    assert st.source_to_timeline("host", SourceSec(250.0)) == pytest.approx(200.0)


def test_source_point_in_cut_returns_none(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.source_to_timeline("host", SourceSec(75.0)) is None
    assert st.source_to_timeline("host", SourceSec(210.0)) is None


def test_timeline_to_source_after_cuts(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.timeline_to_source("host", TimelineSec(30.0)) == pytest.approx(30.0)
    assert st.timeline_to_source("host", TimelineSec(70.0)) == pytest.approx(100.0)
    assert st.timeline_to_source("host", TimelineSec(200.0)) == pytest.approx(250.0)


def test_timeline_point_past_end_returns_none(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.timeline_to_source("host", TimelineSec(500.0)) is None


def test_map_source_span_splits_across_cut(compressed_project):
    st = SessionTimeline(compressed_project)
    # Source 50-100 spans the 60-90 cut; survivors are 50-60 and 90-100,
    # which land timeline-adjacent (50-60 and 60-70) and merge.
    spans = st.map_source_span("host", SourceSec(50.0), SourceSec(100.0))
    assert len(spans) == 1
    assert spans[0][0] == pytest.approx(50.0)
    assert spans[0][1] == pytest.approx(70.0)


def test_map_source_span_fully_cut_is_empty(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.map_source_span("host", SourceSec(65.0), SourceSec(85.0)) == []


def test_map_timeline_span_recovers_source_ranges(compressed_project):
    st = SessionTimeline(compressed_project)
    spans = st.map_timeline_span("host", TimelineSec(55.0), TimelineSec(65.0))
    assert len(spans) == 2
    assert spans[0][0] == pytest.approx(55.0)
    assert spans[0][1] == pytest.approx(60.0)
    assert spans[1][0] == pytest.approx(90.0)
    assert spans[1][1] == pytest.approx(95.0)


def test_source_to_timeline_clamped(compressed_project):
    st = SessionTimeline(compressed_project)
    # Inside the 60-90 cut -> the join where the gap closed.
    assert st.source_to_timeline_clamped("host", SourceSec(75.0)) == pytest.approx(60.0)
    # Beyond the last clip -> timeline end.
    assert st.source_to_timeline_clamped("host", SourceSec(400.0)) == pytest.approx(250.0)
    # Mapped points pass through unchanged.
    assert st.source_to_timeline_clamped("host", SourceSec(100.0)) == pytest.approx(70.0)


def test_word_intervals_timeline_projects_words(compressed_project):
    compressed_project.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="early", start=10.0, end=11.0),
                TranscriptWord(text="cutaway", start=70.0, end=71.0),
                TranscriptWord(text="late", start=100.0, end=101.0),
                TranscriptWord(text="bleed", start=102.0, end=103.0, suppressed=True),
            ],
        )
    )
    st = SessionTimeline(compressed_project)
    intervals = st.word_intervals_timeline("host", TimelineSec(0.0), TimelineSec(250.0))
    assert len(intervals) == 2
    assert intervals[0][0] == pytest.approx(10.0)
    # "late" at source 100 lands at timeline 70 after the 30s cut.
    assert intervals[1][0] == pytest.approx(70.0)
    assert intervals[1][1] == pytest.approx(71.0)

    with_suppressed = st.word_intervals_timeline(
        "host", TimelineSec(0.0), TimelineSec(250.0), include_suppressed=True
    )
    assert len(with_suppressed) == 3


def test_word_intervals_timeline_window_clamps(compressed_project):
    compressed_project.transcripts.append(
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="late", start=100.0, end=101.0)],
        )
    )
    st = SessionTimeline(compressed_project)
    assert st.word_intervals_timeline("host", TimelineSec(0.0), TimelineSec(60.0)) == []
    clipped = st.word_intervals_timeline("host", TimelineSec(70.5), TimelineSec(250.0))
    assert clipped[0][0] == pytest.approx(70.5)


def test_drift_diagnostics(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.drift_at("host", TimelineSec(30.0)) == pytest.approx(0.0)
    assert st.drift_at("host", TimelineSec(70.0)) == pytest.approx(30.0)
    assert st.drift_at("host", TimelineSec(200.0)) == pytest.approx(50.0)
    assert st.max_drift("host") == pytest.approx(50.0)
    assert not st.is_identity("host")


def test_index_cache_reused_and_invalidated_by_clip_change(compressed_project):
    # Global LRU is process-wide; clear so prior tests cannot poison hit/miss counts.
    _build_index.cache_clear()
    st = SessionTimeline(compressed_project)
    st.source_to_timeline("host", SourceSec(10.0))
    hits_before = _build_index.cache_info().hits
    st.source_to_timeline("host", SourceSec(20.0))
    assert _build_index.cache_info().hits > hits_before

    misses_before = _build_index.cache_info().misses
    compressed_project.timeline.clips = compressed_project.timeline.clips[:2]
    assert st.timeline_to_source("host", TimelineSec(100.0)) == pytest.approx(130.0)
    assert _build_index.cache_info().misses > misses_before


def test_duplicated_source_segment_maps_to_earliest_timeline(tmp_path):
    p = _project(
        tmp_path,
        [
            Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
            Clip(id="c2", track_id="host", source_start=5.0, source_end=10.0, timeline_start=10.0),
        ],
    )
    st = SessionTimeline(p)
    assert st.source_to_timeline("host", SourceSec(7.0)) == pytest.approx(7.0)
    # Both placements are covered; adjacent results merge into one interval.
    spans = st.map_source_span("host", SourceSec(5.0), SourceSec(10.0))
    assert spans[0][0] == pytest.approx(5.0)
    assert spans[-1][1] == pytest.approx(15.0)


def test_empty_and_inverted_spans(compressed_project):
    st = SessionTimeline(compressed_project)
    assert st.map_source_span("host", SourceSec(10.0), SourceSec(10.0)) == []
    assert st.map_timeline_span("host", TimelineSec(20.0), TimelineSec(10.0)) == []


def test_timeline_extent(compressed_project):
    st = SessionTimeline(compressed_project)
    extent = st.timeline_extent("host")
    assert extent is not None
    assert extent[0] == pytest.approx(250.0)
    assert extent[1] == pytest.approx(300.0)


def test_clip_timeline_helpers(compressed_project):
    clip = compressed_project.clips[1]
    assert clip_timeline_point_to_source(clip, 70.0) == pytest.approx(100.0)
    assert clip_timeline_overlap_to_source(clip, 70.0, 72.0) == pytest.approx((100.0, 102.0))
    assert clip_timeline_overlap_to_source(clip, 70.0, 70.0) is None

    with pytest.raises(ValueError, match="outside clip"):
        clip_timeline_point_to_source(clip, 0.0)


def test_map_timeline_spans_without_clips_is_identity():
    spans = map_timeline_spans_over_clips([], [(10.0, 20.0)])
    assert spans == [(SourceSec(10.0), SourceSec(20.0))]


def test_timebase_qc_unmapped_words(tmp_path):
    p = _project(
        tmp_path,
        [
            Clip(
                id="c1",
                track_id="host",
                source_start=0.0,
                source_end=60.0,
                timeline_start=0.0,
            ),
            Clip(
                id="c2",
                track_id="host",
                source_start=90.0,
                source_end=200.0,
                timeline_start=60.0,
            ),
        ],
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="gap", start=70.0, end=72.0),
            ],
        )
    ]
    report = timebase_qc_report(p)
    assert report["tracks"]["host"]["unmapped_words"] == 1
    assert any("outside clip source" in i for i in report["issues"])


def test_indexes_parked_clip_by_origin_media(tmp_path):
    p = EpisodeProject.create("st_origin", str(tmp_path / "ws"))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        ),
        Track(
            id="guest",
            label="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=40.0),
        ),
    ]
    p.sources = [
        SourceRecording(id="src_host", path="raw/host.wav", duration_sec=40.0),
    ]
    parked = Clip(
        id="c1",
        track_id="guest",
        source_start=0.0,
        source_end=5.0,
        timeline_start=2.0,
        source_id="src_host",
    )
    p.timeline.clips = [parked]
    assert origin_track_id_for_clip(p, parked) == "host"
    st = SessionTimeline(p)
    assert st.source_to_timeline("host", SourceSec(1.0)) == pytest.approx(3.0)
    assert st.is_identity("guest")


def test_clip_source_to_timeline_shift() -> None:
    from podcast_mcp.engines.session_timeline import clip_source_to_timeline_shift

    lead = Clip(id="a", track_id="t", source_start=4.0, source_end=10.0, timeline_start=0.0)
    late = Clip(id="b", track_id="t", source_start=0.0, source_end=10.0, timeline_start=3.0)
    assert clip_source_to_timeline_shift(lead) == -4.0
    assert clip_source_to_timeline_shift(late) == 3.0
    from podcast_mcp.engines.session_timeline import _Span

    assert (
        clip_source_to_timeline_shift(_Span(timeline_start=2.0, source_start=5.0, source_end=9.0))
        == -3.0
    )
