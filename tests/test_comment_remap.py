"""Unit + integration tests for timeline comment/chapter remap on ripple."""

from __future__ import annotations

from podcast_mcp.edits.comment_remap import (
    remap_chapters_for_cut,
    remap_comments_for_cut,
    remap_interval_for_cut,
)
from podcast_mcp.edits.timeline_ops import batch_ripple_delete, ripple_delete
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    EpisodeProject,
    MediaAsset,
    TimelineComment,
    Track,
    TrackRole,
)


def test_remap_before_unchanged():
    r = remap_interval_for_cut(1.0, 2.0, 5.0, 7.0)
    assert r is not None
    assert r.start == 1.0 and r.end == 2.0


def test_remap_after_shifts():
    r = remap_interval_for_cut(10.0, 12.0, 5.0, 7.0)
    assert r is not None
    assert r.start == 8.0 and r.end == 10.0


def test_remap_instant_after_shifts():
    r = remap_interval_for_cut(10.0, None, 5.0, 7.0)
    assert r is not None
    assert r.start == 8.0 and r.end is None


def test_remap_fully_inside_dropped():
    assert remap_interval_for_cut(5.5, 6.5, 5.0, 7.0) is None
    assert remap_interval_for_cut(6.0, None, 5.0, 7.0) is None


def test_remap_overlap_prefix_kept():
    r = remap_interval_for_cut(4.0, 6.0, 5.0, 7.0)
    assert r is not None
    assert r.start == 4.0 and r.end == 5.0


def test_remap_overlap_suffix_shifted():
    r = remap_interval_for_cut(6.0, 9.0, 5.0, 7.0)
    assert r is not None
    assert r.start == 5.0 and r.end == 7.0


def test_remap_span_covering_cut():
    r = remap_interval_for_cut(4.0, 10.0, 5.0, 7.0)
    assert r is not None
    assert r.start == 4.0 and r.end == 8.0


def test_remap_comments_and_chapters_lists():
    comments = [
        TimelineComment(
            id="a",
            body="before",
            author="x",
            created_at="t",
            timeline_start=1.0,
            timeline_end=2.0,
        ),
        TimelineComment(
            id="b",
            body="inside",
            author="x",
            created_at="t",
            timeline_start=5.5,
            timeline_end=6.0,
        ),
        TimelineComment(
            id="c",
            body="after",
            author="x",
            created_at="t",
            timeline_start=10.0,
            timeline_end=None,
        ),
    ]
    out = remap_comments_for_cut(comments, 5.0, 7.0)
    assert [c.id for c in out] == ["a", "c"]
    assert out[1].timeline_start == 8.0

    chapters = [
        ChapterMarker(time=1.0, title="Intro"),
        ChapterMarker(time=6.0, title="Gone"),
        ChapterMarker(time=12.0, title="Outro"),
    ]
    ch_out = remap_chapters_for_cut(chapters, 5.0, 7.0)
    assert [c.title for c in ch_out] == ["Intro", "Outro"]
    assert ch_out[1].time == 10.0


def _project_with_anchors() -> EpisodeProject:
    p = EpisodeProject.create("remap_int", "/tmp/remap_ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        ),
    ]
    p.timeline.clips.append(
        Clip(
            id="full_host",
            track_id="host",
            source_start=0.0,
            source_end=20.0,
            timeline_start=0.0,
        )
    )
    p.review.comments = [
        TimelineComment(
            id="before",
            body="b",
            author="a",
            created_at="t",
            timeline_start=1.0,
            timeline_end=2.0,
        ),
        TimelineComment(
            id="after",
            body="a",
            author="a",
            created_at="t",
            timeline_start=12.0,
            timeline_end=14.0,
        ),
        TimelineComment(
            id="inside",
            body="i",
            author="a",
            created_at="t",
            timeline_start=6.0,
            timeline_end=7.0,
        ),
    ]
    p.editorial.chapters = [
        ChapterMarker(time=1.5, title="A"),
        ChapterMarker(time=15.0, title="B"),
    ]
    return p


def test_ripple_delete_remaps_comments_and_chapters():
    p = _project_with_anchors()
    ripple_delete(p, 5.0, 8.0, use_inaudible_opt=False)
    ids = {c.id for c in p.review.comments}
    assert ids == {"before", "after"}
    after = next(c for c in p.review.comments if c.id == "after")
    assert after.timeline_start == 9.0
    assert after.timeline_end == 11.0
    assert [c.title for c in p.editorial.chapters] == ["A", "B"]
    assert p.editorial.chapters[1].time == 12.0


def test_batch_ripple_delete_remaps_right_to_left():
    p = _project_with_anchors()
    # Two cuts on original timeline: [3,4) and [10,11)
    batch_ripple_delete(p, [(3.0, 4.0), (10.0, 11.0)], use_inaudible_opt=False)
    after = next(c for c in p.review.comments if c.id == "after")
    # after was [12,14); remove 1s at 10 then 1s at 3 → shift by 2
    assert after.timeline_start == 10.0
    assert after.timeline_end == 12.0
    assert p.editorial.chapters[1].time == 13.0
