"""contracts/join-length-limits.json: the DAW join Length slider max matches set_clip_join."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.join_modes import set_clip_join
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "join-length-limits.json"
CASES = json.loads(CONTRACT.read_text(encoding="utf-8"))["cases"]
IDS = [c["name"] for c in CASES]


def _join(case: dict, length_ms: int) -> tuple[int, int]:
    """(left.fade_out_ms, right.fade_in_ms) after a fade SetClipJoin of *length_ms*."""
    cap = case["track_fade_max_ms"]
    left_sec = case["left_duration_sec"]
    p = EpisodeProject.create("join_len", "/tmp/join_len")
    p.timeline.tracks = [
        Track(
            id="t",
            label="T",
            role=TrackRole.DIALOGUE if cap is not None else TrackRole.MUSIC,
            media=MediaAsset(path="raw/t.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="L",
            track_id="t",
            source_start=0.0,
            source_end=left_sec,
            timeline_start=0.0,
            fade_in_ms=case["left_fade_in_ms"],
        ),
        Clip(
            id="R",
            track_id="t",
            # A separate source region (0..duration), not left's source offset by
            # left_sec: keeps the right clip's duration exact instead of losing
            # precision to floating-point subtraction of two large offsets.
            source_start=0.0,
            source_end=case["right_duration_sec"],
            timeline_start=left_sec,
        ),
    ]
    defaults = {"render": {"join_fade_max_ms": cap if cap is not None else 40}}
    set_clip_join(p, "L", "R", "fade", length_ms=length_ms, defaults=defaults)
    left, right = p.clips
    return left.fade_out_ms, right.fade_in_ms


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_slider_max_is_kept_on_both_edges(case: dict) -> None:
    assert _join(case, case["max_ms"]) == (case["max_ms"], case["max_ms"])


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_one_past_the_slider_max_is_clamped_back(case: dict) -> None:
    assert min(_join(case, case["max_ms"] + 1)) == case["max_ms"]
