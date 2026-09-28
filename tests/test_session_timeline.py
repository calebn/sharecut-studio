from __future__ import annotations

import pytest

from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    _build_index,
    clip_media_key,
    clip_source_at_timeline,
    clip_timeline_overlap_to_source,
    clip_timeline_point_to_source,
    map_timeline_spans_over_clips,
    origin_track_id_for_clip,
    same_source_timeline_overlaps,
    slip_clip_to_shift,
    timebase_qc_report,
    word_source_span,
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


def test_sources_to_timeline_matches_point_mapping(compressed_project):
    st = SessionTimeline(compressed_project)
    secs = [SourceSec(30.0), SourceSec(75.0), SourceSec(100.0), SourceSec(210.0), SourceSec(250.0)]
    assert st.sources_to_timeline("host", secs) == [st.source_to_timeline("host", s) for s in secs]
    assert st.sources_to_timeline("host", secs)[1] is None


def test_batch_source_mapping_rebuilds_after_in_place_clip_edit(compressed_project):
    st = SessionTimeline(compressed_project)
    spans = [(SourceSec(100.0), SourceSec(101.0))] * 3
    assert st.map_source_spans("host", spans) == [[(70.0, 71.0)]] * 3
    compressed_project.clips[1].timeline_start = 65.0
    assert st.map_source_spans("host", spans) == [[(75.0, 76.0)]] * 3
    assert st.map_source_span("host", *spans[0]) == [(75.0, 76.0)]


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
    misses_before = _build_index.cache_info().misses
    st.source_to_timeline("host", SourceSec(20.0))
    assert _build_index.cache_info().misses == misses_before

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


def test_clip_source_at_timeline_maps_the_placement_line_without_bounds() -> None:
    clip = Clip(id="c", track_id="host", source_start=100.0, source_end=110.0, timeline_start=70.0)
    assert clip_source_at_timeline(clip, 72.5) == pytest.approx(102.5)
    # At timeline_end, where clip_timeline_point_to_source raises.
    assert clip_source_at_timeline(clip, 80.0) == pytest.approx(110.0)


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


def test_timebase_qc_zero_length_words_are_timing_flags(tmp_path):
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
                TranscriptWord(text="a", start=10.0, end=10.0),  # kept, zero-length
                TranscriptWord(
                    text="b", start=95.0, end=94.99
                ),  # kept, inverted within one ASR step
                TranscriptWord(text="c", start=70.0, end=70.0),  # zero-length in cut gap
            ],
        )
    ]
    report = timebase_qc_report(p)
    host = report["tracks"]["host"]
    assert host["zero_length_words"] == 2
    assert host["unmapped_words"] == 1
    assert any("zero ASR duration" in w for w in report["warnings"])
    assert sum("outside clip source" in i for i in report["issues"]) == 1


def test_timebase_qc_zero_length_words_alone_stay_ok(tmp_path):
    p = _project(
        tmp_path,
        [
            Clip(
                id="c1",
                track_id="host",
                source_start=0.0,
                source_end=60.0,
                timeline_start=0.0,
            )
        ],
    )
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="uh", start=5.0, end=5.0)])
    ]
    report = timebase_qc_report(p)
    assert report["ok"] is True
    assert "unmapped_words" not in report["tracks"]["host"]
    assert report["tracks"]["host"]["zero_length_words"] == 1


def test_timebase_qc_zero_length_word_at_clip_source_end_maps(tmp_path):
    p = _project(
        tmp_path,
        [
            Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
            Clip(id="c2", track_id="host", source_start=12.0, source_end=20.0, timeline_start=10.0),
        ],
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=10.0, end=10.0),  # cut begins at the word
                TranscriptWord(text="b", start=11.0, end=11.0),  # inside the cut gap
            ],
        )
    ]
    report = timebase_qc_report(p)
    host = report["tracks"]["host"]
    assert host["zero_length_words"] == 1
    assert host["unmapped_words"] == 1
    mapped = SessionTimeline(p).map_word_spans("host", [(10.0, 10.0), (11.0, 11.0), (12.0, 12.0)])
    assert mapped[0] == [(pytest.approx(9.999), pytest.approx(10.0))]
    assert mapped[1] == []
    assert mapped[2] == [(pytest.approx(10.0), pytest.approx(10.001))]


def test_word_source_span_pads_zero_length_words():
    assert word_source_span(1.0, 2.0) == (SourceSec(1.0), SourceSec(2.0))
    for end in (5.0, 4.99):
        start, padded = word_source_span(5.0, end)
        assert start == SourceSec(5.0)
        assert float(padded) == pytest.approx(5.001)


def test_timebase_qc_inverted_words_are_issues(tmp_path):
    p = _project(
        tmp_path,
        [
            Clip(
                id="c1",
                track_id="host",
                source_start=0.0,
                source_end=200.0,
                timeline_start=0.0,
            )
        ],
    )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="x", start=95.0, end=10.0),  # corrupt: bad merge/edit
                TranscriptWord(text="uh", start=5.0, end=5.0),  # Whisper zero-length
            ],
        )
    ]
    report = timebase_qc_report(p)
    host = report["tracks"]["host"]
    assert host["inverted_words"] == 1
    assert host["zero_length_words"] == 1
    assert "unmapped_words" not in host
    assert report["ok"] is False
    assert any("before they start" in i for i in report["issues"])


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


def _max_rel(p: EpisodeProject, tid: str, ref: str) -> float:
    st = SessionTimeline(p)
    return max(
        (abs(st.clip_relative_drift(c, ref)) for c in p.clips if c.track_id == tid), default=0.0
    )


def test_clip_relative_drift_ignores_shared_ripple(tmp_path) -> None:
    def build(guest_shift: float) -> EpisodeProject:
        p = EpisodeProject.create("rel_drift", str(tmp_path / f"ws{guest_shift}"))
        p.timeline.tracks = [
            Track(id=t, label=t, media=MediaAsset(path=f"raw/{t}.wav", duration_sec=300.0))
            for t in ("host", "guest")
        ]
        clips = []
        for tid in ("host", "guest"):
            shift = guest_shift if tid == "guest" else 0.0
            clips.append(
                Clip(
                    id=f"{tid}_a",
                    track_id=tid,
                    source_start=0.0,
                    source_end=60.0,
                    timeline_start=shift,
                )
            )
            clips.append(
                Clip(
                    id=f"{tid}_b",
                    track_id=tid,
                    source_start=90.0,
                    source_end=300.0,
                    timeline_start=60.0 + shift,
                )
            )
        p.timeline.clips = clips
        return p

    assert _max_rel(build(0.0), "guest", "host") == pytest.approx(0.0)
    # A pure offset (no ripple around it) shows up in full.
    flat = build(35.6)
    flat.timeline.clips = [
        Clip(id="h", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0),
        Clip(id="g", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=35.6),
    ]
    assert _max_rel(flat, "guest", "host") == pytest.approx(35.6, abs=0.01)
    assert _max_rel(build(0.0), "nope", "host") == 0.0


def _drift_project(tmp_path, name: str, host: list[Clip], guest: list[Clip]) -> EpisodeProject:
    p = EpisodeProject.create(name, str(tmp_path / name))
    p.timeline.tracks = [
        Track(id=t, label=t, media=MediaAsset(path=f"raw/{t}.wav", duration_sec=300.0))
        for t in ("host", "guest")
    ]
    p.timeline.clips = [*host, *guest]
    return p


def test_clip_relative_drift_sees_reference_edit_inside_clip(tmp_path) -> None:
    g = Clip(id="g", track_id="guest", source_start=0, source_end=98, timeline_start=0)
    p = _drift_project(
        tmp_path,
        "inside",
        [
            Clip(id="h1", track_id="host", source_start=0, source_end=80, timeline_start=0),
            Clip(id="h2", track_id="host", source_start=82, source_end=100, timeline_start=80),
        ],
        [g],
    )
    assert abs(SessionTimeline(p).clip_relative_drift(g, "host")) == pytest.approx(2.0, abs=1e-6)


def test_clip_relative_drift_ignores_sliver(tmp_path) -> None:
    g = Clip(id="g", track_id="guest", source_start=0, source_end=60.02, timeline_start=0)
    p = _drift_project(
        tmp_path,
        "sliver",
        [
            Clip(id="h1", track_id="host", source_start=0, source_end=60, timeline_start=0),
            Clip(id="h2", track_id="host", source_start=90, source_end=300, timeline_start=60),
        ],
        [g],
    )
    assert SessionTimeline(p).clip_relative_drift(g, "host") == pytest.approx(0.0)


def test_clip_relative_drift_ignores_reference_track_local_hole(tmp_path) -> None:
    """A punch hole on the *reference* track must not read as guest drift.

    ``host`` cut the same 40s of content as ``guest`` but left an extra 1s
    silence hole of its own at the seam (a track-local punch: no ripple, so
    the surrounding clips keep their original offset). Sampling ``guest``'s
    piece that overlaps host's hole used to fall back to host's pre-cut
    clip, reading the whole cut (40s) as drift even though both tracks land
    on the same post-cut offset (#771).
    """
    host = [
        Clip(id="h1", track_id="host", source_start=0, source_end=50, timeline_start=0),
        # 1s timeline gap [50, 51): host's own punch hole, no ripple.
        Clip(id="h2", track_id="host", source_start=91, source_end=150, timeline_start=51),
    ]
    guest = [Clip(id="g2", track_id="guest", source_start=90, source_end=150, timeline_start=50)]
    p = _drift_project(tmp_path, "ref-hole", host, guest)
    assert SessionTimeline(p).clip_relative_drift(guest[0], "host") == pytest.approx(0.0)


def test_clip_relative_drift_still_flags_real_drift_past_reference_hole(tmp_path) -> None:
    """The same reference-hole shape still catches a genuinely offset guest clip."""
    host = [
        Clip(id="h1", track_id="host", source_start=0, source_end=50, timeline_start=0),
        Clip(id="h2", track_id="host", source_start=91, source_end=150, timeline_start=51),
    ]
    guest = [Clip(id="g2", track_id="guest", source_start=95, source_end=155, timeline_start=50)]
    p = _drift_project(tmp_path, "ref-hole-drifted", host, guest)
    assert SessionTimeline(p).clip_relative_drift(guest[0], "host") == pytest.approx(5.0)


def test_clip_relative_drift_visits_only_overlapping_reference_spans(tmp_path, monkeypatch) -> None:
    from podcast_mcp.engines import session_timeline as timeline

    host = [
        Clip(
            id=f"h{i}",
            track_id="host",
            source_start=float(i * 2),
            source_end=float(i * 2 + 2),
            timeline_start=float(i * 2),
        )
        for i in range(200)
    ]
    guest = Clip(
        id="g", track_id="guest", source_start=201.0, source_end=202.0, timeline_start=206.0
    )
    p = _drift_project(tmp_path, "many-cut", host, [guest])
    original = timeline._candidates_timeline
    visited: list[int] = []

    def bounded(index, lo, hi):
        spans = original(index, lo, hi)
        visited.append(len(spans))
        return spans

    monkeypatch.setattr(timeline, "_candidates_timeline", bounded)
    assert abs(SessionTimeline(p).clip_relative_drift(guest, "host")) == pytest.approx(5.0)
    assert visited and max(visited) <= 2


def test_same_source_overlaps_flags_stacked_split_copies(tmp_path) -> None:
    host = [Clip(id="h", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0)]
    guest = [
        Clip(id="c1", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0),
        Clip(id="c2", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0),
    ]
    p = _drift_project(tmp_path, "stacked", host, guest)
    stacks = same_source_timeline_overlaps(p)
    assert len(stacks) == 1
    assert stacks[0].clip_ids == ("c1", "c2")
    assert stacks[0].overlap_sec == pytest.approx(100.0)


def test_same_source_overlaps_ignores_abutting_and_tolerance(tmp_path) -> None:
    host = [Clip(id="h", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0)]
    abutting = [
        Clip(id="c1", track_id="guest", source_start=0.0, source_end=50.0, timeline_start=0.0),
        Clip(id="c2", track_id="guest", source_start=50.0, source_end=100.0, timeline_start=50.0),
    ]
    p = _drift_project(tmp_path, "abut", host, abutting)
    assert same_source_timeline_overlaps(p) == []

    slightly = [
        Clip(id="c1", track_id="guest", source_start=0.0, source_end=50.03, timeline_start=0.0),
        Clip(id="c2", track_id="guest", source_start=50.0, source_end=100.0, timeline_start=50.0),
    ]
    p2 = _drift_project(tmp_path, "tol", host, slightly)
    assert same_source_timeline_overlaps(p2) == []


def test_same_source_overlaps_ignores_different_media(tmp_path) -> None:
    p = EpisodeProject.create("diff_media", str(tmp_path / "diff_media"))
    p.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=300.0)),
        Track(
            id="guest", label="Guest", media=MediaAsset(path="raw/guest.wav", duration_sec=300.0)
        ),
    ]
    p.sources = [SourceRecording(id="other", path="raw/other.wav", duration_sec=300.0)]
    p.timeline.clips = [
        Clip(id="h", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0),
        Clip(id="c1", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0),
        Clip(
            id="c2",
            track_id="guest",
            source_start=0.0,
            source_end=100.0,
            timeline_start=0.0,
            source_id="other",
        ),
    ]
    assert same_source_timeline_overlaps(p) == []
    host_clips = [c for c in p.clips if c.track_id == "host"]
    assert same_source_timeline_overlaps(p, clips=host_clips) == []


def test_clip_media_key_source_and_primary(tmp_path) -> None:
    p = EpisodeProject.create("media_key", str(tmp_path / "media_key"))
    p.timeline.tracks = [
        Track(
            id="guest", label="Guest", media=MediaAsset(path="raw/guest.wav", duration_sec=300.0)
        ),
    ]
    p.sources = [SourceRecording(id="src_guest", path="raw/guest.wav", duration_sec=300.0)]
    plain = Clip(id="c1", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)
    sourced = Clip(
        id="c2",
        track_id="guest",
        source_start=0.0,
        source_end=10.0,
        timeline_start=10.0,
        source_id="src_guest",
    )
    assert clip_media_key(p, plain) == clip_media_key(p, sourced) == "raw/guest.wav"


def test_slip_clip_to_shift() -> None:
    blade_a = Clip(
        id="a", track_id="guest", source_start=1045.55, source_end=1689.58, timeline_start=1045.55
    )
    assert slip_clip_to_shift(blade_a, 35.6, media_duration=1689.58) == pytest.approx(
        (1009.95, 1653.98, 1045.55)
    )

    whole = Clip(id="b", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0)
    assert slip_clip_to_shift(whole, 5.0, media_duration=100.0) == pytest.approx((0.0, 95.0, 5.0))
    assert slip_clip_to_shift(whole, -5.0, media_duration=100.0) == pytest.approx((5.0, 100.0, 0.0))

    tail = Clip(id="c", track_id="guest", source_start=90.0, source_end=100.0, timeline_start=10.0)
    assert slip_clip_to_shift(tail, -100.0, media_duration=100.0) is None


def test_timebase_qc_report_flags_stacked_clips(tmp_path) -> None:
    host = [Clip(id="h", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0)]
    guest = [
        Clip(id="c1", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0),
        Clip(id="c2", track_id="guest", source_start=0.0, source_end=100.0, timeline_start=0.0),
    ]
    p = _drift_project(tmp_path, "qc_stack", host, guest)
    report = timebase_qc_report(p)
    assert report["ok"] is False
    assert any("stacked copies" in i for i in report["issues"])
    assert report["tracks"]["guest"]["stacked_clips"] == 1
    assert len(report["stacked_clips"]) == 1
