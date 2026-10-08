from __future__ import annotations

import re
from math import isclose
from pathlib import Path

from podcast_mcp.edits.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    abutting_pairs,
    clips_abut,
    clips_for_track,
    remove_timeline_range_from_clips,
    split_clip_at,
)
from podcast_mcp.edits.ripple import apply_trim_geometry, plan_trim
from podcast_mcp.models import Clip, EditMode, EpisodeProject, MediaAsset, Track, TrackRole

ROOT = Path(__file__).resolve().parents[1]


def _clip(tl_start: float, src_start: float, dur: float, tid: str = "host") -> Clip:
    return Clip(
        id=f"c_{tl_start}",
        track_id=tid,
        source_start=src_start,
        source_end=src_start + dur,
        timeline_start=tl_start,
    )


def test_split_clip_at() -> None:
    c = _clip(0.0, 0.0, 10.0)
    before, after = split_clip_at(c, 4.0)
    assert before.source_end == 4.0
    assert after.source_start == 4.0
    assert after.timeline_start == 4.0


def test_remove_timeline_range() -> None:
    clips = [_clip(0.0, 0.0, 5.0), _clip(5.0, 5.0, 5.0)]
    out = remove_timeline_range_from_clips(clips, 2.0, 7.0)
    assert len(out) == 2
    assert out[0].source_end == 2.0
    assert out[1].timeline_start == 2.0
    assert out[1].source_start == 7.0


def test_ripple_trim_removal_at_peer_clip_start_does_not_split() -> None:
    project = EpisodeProject.create("ripple", "/tmp/ripple")
    project.tracks = [
        Track(
            id=track_id,
            label=track_id,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=600),
        )
        for track_id in ("t0", "t1")
    ]
    project.clips = [
        Clip(
            id="t0_c0",
            track_id="t0",
            timeline_start=14.739,
            source_start=23.8572,
            source_end=31.3051,
        ),
        Clip(
            id="t1_c0",
            track_id="t1",
            timeline_start=22.1864,
            source_start=2.0851,
            source_end=13.3539,
        ),
    ]

    plan = plan_trim(project, "t0_c0", "out", 31.3046, EditMode.RIPPLE)
    apply_trim_geometry(project, plan)

    peer_clips = [clip for clip in project.clips if clip.track_id == "t1"]
    assert len(peer_clips) == 1
    peer = peer_clips[0]
    assert isclose(peer.timeline_start, 22.1864, abs_tol=1e-9)
    assert isclose(peer.source_start, 2.0856, abs_tol=1e-9)
    assert peer.source_end == 13.3539


def test_clips_for_track_is_canonically_sorted() -> None:
    project = EpisodeProject.create("sort", "/tmp/sort")
    project.timeline.clips = [_clip(2.0, 2.0, 1.0), _clip(0.0, 0.0, 1.0)]

    assert [clip.timeline_start for clip in clips_for_track(project, "host")] == [0.0, 2.0]


def test_clips_abut_follows_join_gap_tolerance() -> None:
    left = _clip(0.0, 0.0, 1.0)

    assert clips_abut(left, _clip(1.0, 5.0, 1.0))
    assert clips_abut(left, _clip(1.0 + JOIN_GAP_TOLERANCE_SEC / 2, 5.0, 1.0))
    assert not clips_abut(left, _clip(1.0 + JOIN_GAP_TOLERANCE_SEC + 1e-3, 5.0, 1.0))
    # Overlaps count as abutting.
    assert clips_abut(left, _clip(0.5, 5.0, 1.0))


def test_abutting_pairs_skips_gapped_neighbours() -> None:
    a = _clip(0.0, 0.0, 1.0)
    b = _clip(1.0 + JOIN_GAP_TOLERANCE_SEC / 2, 5.0, 1.0)
    c = _clip(b.timeline_end + JOIN_GAP_TOLERANCE_SEC + 0.5, 9.0, 1.0)

    assert abutting_pairs([a, b, c]) == [(a, b)]
    assert abutting_pairs([a]) == []


def test_join_gap_tolerance_matches_the_gui() -> None:
    ts = (ROOT / "gui/web/src/edit/joinRender.ts").read_text(encoding="utf-8")
    match = re.search(r"export const JOIN_GAP_TOLERANCE_SEC = ([\d.]+);", ts)
    assert match
    assert float(match.group(1)) == JOIN_GAP_TOLERANCE_SEC
