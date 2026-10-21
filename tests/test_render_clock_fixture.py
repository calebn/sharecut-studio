"""Where the render places each clip on its lane's clock, pinned to a fixture.

``gui/web/src/audio/renderClock.test.ts`` reads the same file, so the browser's
render clock and ``timeline_render._place_clips`` cannot drift apart (#1888).
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
)
from podcast_mcp.engines.clips_ops import join_render_fields
from podcast_mcp.engines.timeline_render import _ClipContent, _place_clips, _PreparedClip
from podcast_mcp.models import Clip, ClipJoinMode

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
) -> Clip:
    return Clip(
        id=clip_id,
        track_id=track,
        source_start=0.0,
        source_end=end - start,
        timeline_start=start,
        fade_in_ms=fade_in,
        fade_out_ms=fade_out,
        join_in_mode=mode,
    )


_CASES: dict[str, list[Clip]] = {
    "no_crossfade_is_identity": [
        _clip("a", "host", 0, 5),
        _clip("b", "host", 5, 9, _FADE, 100, 100),
        _clip("c", "host", 12, 14),
    ],
    "one_blending_join_pulls_the_rest_earlier": [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 9, _XFADE, 200, 0),
        _clip("c", "host", 9, 12),
    ],
    "overlaps_add_up_across_a_chain_and_a_gap": [
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
    "overlap_is_capped_at_half_the_right_clip": [
        _clip("a", "host", 0, 5, fade_out=400),
        _clip("b", "host", 5, 5.1, _XFADE, 400, 0),
        _clip("c", "host", 5.1, 8),
    ],
    "a_start_within_tolerance_of_the_frontier_snaps_to_it": [
        _clip("a", "host", 0, 4, fade_out=250),
        _clip("b", "host", 4, 8, _XFADE, 250, 0),
        _clip("c", "host", 8.0005, 10),
    ],
    "a_crossfaded_clip_under_a_millisecond_can_shorten_the_frontier": [
        _clip("a", "host", 0, 5, fade_out=200),
        _clip("b", "host", 5, 5.0005, _XFADE, 200, 0),
        _clip("c", "host", 5.0005, 9),
    ],
    "lanes_shift_independently": [
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


def _leaf_starts(audio: object, base: float, out: dict[str, float]) -> None:
    match audio:
        case SourceAudio():
            out[audio.path.name] = base
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


def _case_rows(clips: list[Clip]) -> list[dict]:
    """Clip rows as the project view reports them, plus where the render places each."""
    lanes: dict[str, list[Clip]] = {}
    for clip in clips:
        lanes.setdefault(clip.track_id, []).append(clip)
    placed: dict[str, float] = {}
    rows: dict[str, dict] = {}
    for lane in lanes.values():
        lane.sort(key=lambda c: c.timeline_start)
        prepared = [
            _PreparedClip(
                clip,
                _ClipContent(
                    clip.timeline_start,
                    clip.timeline_end,
                    SourceAudio(Path(clip.id), clip.source_start, clip.source_end),
                ),
            )
            for clip in lane
        ]
        starts: dict[str, float] = {}
        _leaf_starts(_place_clips(prepared).audio, 0.0, starts)
        placed.update(starts)
        for index, clip in enumerate(lane):
            rows[clip.id] = {
                "id": clip.id,
                "track_id": clip.track_id,
                "source_start": clip.source_start,
                "source_end": clip.source_end,
                "timeline_start": clip.timeline_start,
                "timeline_end": clip.timeline_end,
                "join_in_mode": clip.join_in_mode.value,
                "fade_in_ms": clip.fade_in_ms,
                "fade_out_ms": clip.fade_out_ms,
                **join_render_fields(lane[index - 1] if index else None, clip),
            }
    return [{**rows[clip.id], "placed_start": placed[clip.id]} for clip in clips]


def _build() -> dict:
    return {
        "cases": [{"name": name, "clips": _case_rows(clips)} for name, clips in _CASES.items()],
    }


def test_fixture_matches_the_render() -> None:
    built = _build()
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


def test_cases_cover_a_shifted_and_an_unshifted_lane() -> None:
    moved = {
        row["id"]
        for case in _build()["cases"]
        for row in case["clips"]
        if abs(row["placed_start"] - row["timeline_start"]) > 1e-9
    }
    assert {"b", "c", "d", "h2", "h3", "later"} <= moved
    assert not moved & {"g1", "g2"}
