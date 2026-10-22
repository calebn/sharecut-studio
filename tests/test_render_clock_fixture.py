"""Where the render places each clip on its lane's clock, pinned to a fixture.

``gui/web/src/audio/renderClock.test.ts`` reads the same file, so the browser's
render clock and ``timeline_render.placed_track_audio`` cannot drift apart (#1888).
Regenerate after an intended change with ``REGEN_RENDER_CLOCK=1 pytest`` on this file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from podcast_mcp.engines.audio import (
    At,
    CrossfadeAudio,
    MixAudio,
    SequenceAudio,
    SourceAudio,
    duration,
    sources,
)
from podcast_mcp.engines.clips_ops import crossfade_borrow_sec, join_render_fields
from podcast_mcp.engines.timeline_render import placed_track_audio
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, MediaAsset, Track, TrackRole

_FIXTURE = Path(__file__).parent / "fixtures" / "render_clock" / "cases.json"

_CUT = ClipJoinMode.CUT
_FADE = ClipJoinMode.FADE
_XFADE = ClipJoinMode.CROSSFADE


def _clip(
    clip_id: str,
    track: str,
    start: float,
    end: float,
    mode: ClipJoinMode = _CUT,
    fade_in: int = 0,
    fade_out: int = 0,
    room: float = 10.0,
) -> Clip:
    """A clip playing ``room`` seconds into its recording, so a blend can borrow before it."""
    return Clip(
        id=clip_id,
        track_id=track,
        source_start=room,
        source_end=room + end - start,
        timeline_start=start,
        fade_in_ms=fade_in,
        fade_out_ms=fade_out,
        join_in_mode=mode,
    )


_RECORDING_SEC = 100.0

_CASES: dict[str, list[Clip]] = {
    "no_crossfade_is_identity": [
        _clip("a", "host", 0, 5),
        _clip("b", "host", 5, 9, _FADE, 100, 100),
        _clip("c", "host", 12, 14),
    ],
    "one_blending_join_moves_nothing": [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 9, _XFADE, 200, 0),
        _clip("c", "host", 9, 12),
    ],
    "a_chain_of_blends_moves_nothing_and_a_gap_stays": [
        _clip("a", "host", 0, 4, fade_out=300),
        _clip("b", "host", 4, 8, _XFADE, 300, 400),
        _clip("c", "host", 8, 11, _XFADE, 400, 0),
        _clip("d", "host", 15, 18),
    ],
    "blocked_crossfade_does_not_shift": [
        _clip("a", "host", 0, 5, fade_out=0),
        _clip("b", "host", 5, 9, _XFADE, 200, 0),
        _clip("c", "host", 9, 12),
    ],
    "a_short_clip_borrows_at_most_a_quarter_of_its_length": [
        _clip("a", "host", 0, 5, fade_out=400),
        _clip("b", "host", 5, 5.1, _XFADE, 400, 0),
        _clip("c", "host", 5.1, 8),
    ],
    "no_room_before_the_right_clip_joins_without_a_blend": [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 9, _XFADE, 200, 0, room=0.0),
        _clip("c", "host", 9, 12),
    ],
    "a_gap_inside_the_tolerance_closes_up_and_shifts_the_rest": [
        _clip("a", "host", 0, 4, fade_out=250),
        _clip("b", "host", 4.03, 8, _XFADE, 250, 0),
        _clip("c", "host", 8.03, 10),
    ],
    "a_start_within_tolerance_of_the_frontier_snaps_to_it": [
        _clip("a", "host", 0, 4, fade_out=250),
        _clip("b", "host", 4, 8, _XFADE, 250, 0),
        _clip("c", "host", 8.0005, 10),
    ],
    "a_clip_too_short_to_borrow_joins_without_a_blend": [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 5.0005, _XFADE, 200, 0),
        _clip("c", "host", 5.0005, 9),
    ],
    "a_blending_lane_stays_in_step_with_a_plain_one": [
        _clip("h1", "host", 0, 5, fade_out=200),
        _clip("h2", "host", 5, 9, _XFADE, 200, 0),
        _clip("h3", "host", 9, 12),
        _clip("g1", "guest", 0, 6),
        _clip("g2", "guest", 6, 12),
    ],
    "an_enclosing_clip_keeps_the_clock_from_the_frontier": [
        _clip("follower", "host", 2, 22),
        _clip("anchor", "host", 5, 11, fade_out=100),
        _clip("later", "host", 11, 13, _XFADE, 100, 0),
    ],
}


def _leaf_starts(audio: object, base: float, out: dict[str, tuple[float, float]]) -> None:
    """Render-clock start and first source second of each clip's leaf."""
    match audio:
        case SourceAudio():
            out[str(audio.clip_id)] = (base, audio.src_start)
        case SequenceAudio():
            at = base
            for part in (audio.head, *audio.tail):
                _leaf_starts(part, at, out)
                at += duration(part)
        case CrossfadeAudio():
            _leaf_starts(audio.left, base, out)
            _leaf_starts(audio.right, base + duration(audio.left) - audio.overlap_sec, out)
        case MixAudio():
            for placed in (audio.head, *audio.tail):
                assert isinstance(placed, At)
                _leaf_starts(placed.audio, base + placed.start_sec, out)
        case _:
            raise AssertionError(type(audio))


def _case_rows(clips: list[Clip], tmp_path: Path) -> list[dict]:
    """Clip rows as the project view reports them, plus where the render places each."""
    lanes: dict[str, list[Clip]] = {}
    for clip in clips:
        lanes.setdefault(clip.track_id, []).append(clip)
    project = EpisodeProject.create("render_clock", str(tmp_path))
    (tmp_path / "raw").mkdir(parents=True, exist_ok=True)
    project.timeline.tracks = []
    for track_id in lanes:
        (tmp_path / "raw" / f"{track_id}.wav").write_bytes(b"")
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=_RECORDING_SEC),
            )
        )
    placed: dict[str, float] = {}
    rows: dict[str, dict] = {}
    for track_id, lane in lanes.items():
        lane.sort(key=lambda c: c.timeline_start)
        starts: dict[str, tuple[float, float]] = {}
        track = next(t for t in project.tracks if t.id == track_id)
        _leaf_starts(placed_track_audio(project, track, lane).audio, 0.0, starts)
        for index, clip in enumerate(lane):
            base, src_start = starts[clip.id]
            placed[clip.id] = base + clip.source_start - src_start
            rows[clip.id] = {
                "id": clip.id,
                "track_id": clip.track_id,
                "source_start": clip.source_start,
                "source_end": clip.source_end,
                "source_duration_sec": _RECORDING_SEC,
                "timeline_start": clip.timeline_start,
                "timeline_end": clip.timeline_end,
                "join_in_mode": clip.join_in_mode.value,
                "fade_in_ms": clip.fade_in_ms,
                "fade_out_ms": clip.fade_out_ms,
                **join_render_fields(lane[index - 1] if index else None, clip, project),
            }
    return [{**rows[clip.id], "placed_start": placed[clip.id]} for clip in clips]


def _build(tmp_path: Path) -> dict:
    return {
        "cases": [
            {"name": name, "clips": _case_rows(clips, tmp_path / name)}
            for name, clips in _CASES.items()
        ],
    }


def test_fixture_matches_the_render(tmp_path: Path) -> None:
    built = _build(tmp_path)
    if os.environ.get("REGEN_RENDER_CLOCK"):
        _FIXTURE.write_text(json.dumps(built, indent=2) + "\n")
    stored = json.loads(_FIXTURE.read_text())
    assert [c["name"] for c in stored["cases"]] == [c["name"] for c in built["cases"]]
    for want, got in zip(stored["cases"], built["cases"], strict=True):
        for a, b in zip(want["clips"], got["clips"], strict=True):
            assert a["id"] == b["id"]
            assert a["placed_start"] == pytest.approx(b["placed_start"], abs=1e-9), (
                want["name"],
                a["id"],
            )
            assert a == pytest.approx(b), (want["name"], a["id"])


def test_a_blend_moves_no_clip_and_a_closed_gap_still_does(tmp_path: Path) -> None:
    moved = {
        row["id"]
        for case in _build(tmp_path)["cases"]
        for row in case["clips"]
        if abs(row["placed_start"] - row["timeline_start"]) > 1e-9
    }
    assert {"b", "c"} & moved
    for case in _build(tmp_path / "again")["cases"]:
        if case["name"] in {
            "one_blending_join_moves_nothing",
            "a_chain_of_blends_moves_nothing_and_a_gap_stays",
            "a_blending_lane_stays_in_step_with_a_plain_one",
        }:
            for row in case["clips"]:
                if row["id"] != "d":
                    assert row["placed_start"] == pytest.approx(row["timeline_start"], abs=1e-9)


def _borrow_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("borrow", str(tmp_path))
    (tmp_path / "raw").mkdir(parents=True)
    (tmp_path / "raw" / "host.wav").write_bytes(b"")
    project.timeline.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=_RECORDING_SEC),
        )
    ]
    return project


def test_a_blend_borrows_half_the_overlap_from_each_recording(tmp_path: Path) -> None:
    project = _borrow_project(tmp_path)
    left = _clip("a", "host", 0, 5, fade_out=200)
    right = _clip("b", "host", 5, 9, _XFADE, 200, 0)
    assert crossfade_borrow_sec(project, left, right) == pytest.approx(0.1)
    audio = placed_track_audio(project, project.tracks[0], [left, right]).audio
    leaves = {s.clip_id: s for s in sources(audio)}
    assert leaves["a"].src_end == pytest.approx(left.source_end + 0.1)
    assert leaves["b"].src_start == pytest.approx(right.source_start - 0.1)
    assert duration(audio) == pytest.approx(9.0)


def test_the_borrow_shrinks_to_the_room_the_recordings_have(tmp_path: Path) -> None:
    project = _borrow_project(tmp_path)
    left = _clip("a", "host", 0, 5, fade_out=200)
    assert crossfade_borrow_sec(project, left, _clip("b", "host", 5, 9, _XFADE, 200, 0)) > 0
    # Nothing before the right clip's start, nothing after the left clip's end.
    assert (
        crossfade_borrow_sec(project, left, _clip("b", "host", 5, 9, _XFADE, 200, 0, room=0)) == 0
    )
    tail = _clip("a", "host", 0, 5, fade_out=200, room=_RECORDING_SEC - 5)
    assert crossfade_borrow_sec(project, tail, _clip("b", "host", 5, 9, _XFADE, 200, 0)) == 0
    short = _clip("b", "host", 5, 5.2, _XFADE, 400, 0)
    assert crossfade_borrow_sec(project, left, short) == pytest.approx(0.05)
    cut = _clip("b", "host", 5, 9, _CUT)
    assert crossfade_borrow_sec(project, left, cut) == 0


def _join(project: EpisodeProject, window: tuple[float, float] | None):
    left = _clip("a", "host", 0, 5, fade_out=200)
    right = _clip("b", "host", 5, 9, _XFADE, 200, 0)
    return placed_track_audio(project, project.tracks[0], [left, right], window=window).audio


def test_a_window_ending_at_the_seam_keeps_the_edge_fade_off(tmp_path: Path) -> None:
    audio = _join(_borrow_project(tmp_path), (1.0, 5.0))
    (leaf,) = sources(audio)
    assert leaf.clip_id == "a"
    assert leaf.fade_out_sec == 0.0
    # The right clip is outside the window, so nothing is borrowed from it.
    assert leaf.src_end == pytest.approx(_clip("a", "host", 0, 5).source_end)


def test_a_window_edge_inside_the_blend_shrinks_it_to_the_piece_it_has(tmp_path: Path) -> None:
    audio = _join(_borrow_project(tmp_path), (1.0, 5.01))
    assert isinstance(audio, MixAudio)
    blend = audio.head.audio
    assert isinstance(blend, CrossfadeAudio)
    # The right piece is 10 ms long, so the 200 ms blend shrinks to 20 ms.
    assert blend.overlap_sec == pytest.approx(0.02)
    assert all(duration(side) >= blend.overlap_sec for side in (blend.left, blend.right))


def test_the_render_hash_follows_what_a_join_borrows(tmp_path: Path) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.play_audit import track_render_hash

    project = _borrow_project(tmp_path)
    project.timeline.clips = [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 9, _XFADE, 200, 0),
    ]
    defaults = load_defaults()
    blending = track_render_hash(project, "host", defaults=defaults)
    # The recording's length is not in the media identity, but it decides the borrow.
    project.tracks[0].media.duration_sec = 15.05
    assert track_render_hash(project, "host", defaults=defaults) != blending


def test_a_join_with_no_room_reports_no_headroom_and_borrows_nothing(tmp_path: Path) -> None:
    project = _borrow_project(tmp_path)
    left = _clip("a", "host", 0, 5, fade_out=200)
    roomy = _clip("b", "host", 5, 9, _XFADE, 200, 0)
    fields = join_render_fields(left, roomy, project)
    assert fields["join_crossfade_blocked"] is None
    assert fields["join_borrow_sec"] == pytest.approx(0.1)
    assert fields["join_crossfade_ms"] == 200
    cramped = _clip("b", "host", 5, 9, _XFADE, 200, 0, room=0.0)
    fields = join_render_fields(left, cramped, project)
    assert fields["join_crossfade_blocked"] == "no_headroom"
    assert fields["join_crossfade_ms"] == 0
    assert "join_borrow_sec" not in fields
