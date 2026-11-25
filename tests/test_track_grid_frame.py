"""A track grid places clip edges with the same half-up rounding as delays (#2496)."""

from __future__ import annotations

import pytest

from podcast_mcp.engines import audio, timeline_render
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


@pytest.mark.parametrize("rate", [44_100, 48_000])
@pytest.mark.parametrize("frames_and_offset", [(1, 0.5), (2, 0.5), (1000, 0.49), (1000, 0.51)])
def test_mute_envelope_and_frame_mapping_round_half_up_like_delays(rate, frames_and_offset):
    frames, offset = frames_and_offset
    seconds = (frames + offset) / rate
    expected = delay_frames(seconds, rate)
    envelope = audio.MuteEnvelope(seconds, seconds, seconds, seconds).samples(rate)
    assert (envelope.first, envelope.last) == (expected, expected)
    assert (envelope.fade_out, envelope.fade_in) == (expected, expected)
    assert audio.SourceFrameMapping(rate, 0, ()).endpoint(seconds) == expected


def test_mute_envelope_and_frame_mapping_take_their_rounding_from_delay_frames(monkeypatch):
    calls: list[tuple[float, int]] = []

    def spy(seconds: float, rate: int) -> int:
        calls.append((seconds, rate))
        return 7

    monkeypatch.setattr(audio, "delay_frames", spy)
    envelope = audio.MuteEnvelope(0.5, 1.5, 0.25, 0.125).samples(48_000, source_start=1.0, origin=2)
    assert (envelope.first, envelope.last, envelope.fade_out, envelope.fade_in) == (5, 5, 7, 7)
    assert calls == [(1.5, 48_000), (2.5, 48_000), (0.25, 48_000), (0.125, 48_000)]
    calls.clear()
    assert audio.SourceFrameMapping(48_000, 3, ()).endpoint(0.75) == 4
    assert audio.SourceFrameMapping(48_000, 0, ()).endpoint(0.75, ceil=True) == 36_000
    assert calls == [(0.75, 48_000)]
