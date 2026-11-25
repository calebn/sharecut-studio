"""A track grid places clip edges with the same half-up rounding as delays (#2496)."""

from __future__ import annotations

import pytest

from podcast_mcp.engines import timeline_render
from podcast_mcp.engines.audio import delay_frames
from podcast_mcp.engines.timeline_render import TrackGrid


@pytest.mark.parametrize("rate", [44_100, 48_000, 96_000])
@pytest.mark.parametrize(
    "frames_and_offset",
    [(0, 0.0), (1, -0.5), (1, 0.5), (2, 0.5), (3, 0.5), (1000, 0.49), (1000, 0.51), (48_000, 0.5)],
)
def test_frame_matches_delay_frames_at_half_samples(rate, frames_and_offset):
    frames, offset = frames_and_offset
    seconds = (frames + offset) / rate
    assert TrackGrid(rate, {}).frame(seconds) == delay_frames(seconds, rate)


def test_frame_takes_its_rounding_from_delay_frames(monkeypatch):
    calls: list[tuple[float, int]] = []

    def spy(seconds: float, rate: int) -> int:
        calls.append((seconds, rate))
        return 7

    monkeypatch.setattr(timeline_render, "delay_frames", spy)
    assert TrackGrid(48_000, {}).frame(0.25) == 7
    assert calls == [(0.25, 48_000)]
