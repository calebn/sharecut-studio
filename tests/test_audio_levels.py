"""Level helpers of ``edits/audio_cache.py``: the room floor, the speech level, band levels."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import (
    DIGITAL_SILENCE_DB,
    BandLevels,
    level_profile,
    room_floor_db,
    speech_level_db,
)
from podcast_mcp.util.dsp import LOW_BAND, SPEECH_BAND, frame_band_filtered_db

RATE = 16_000


def test_room_floor_is_a_low_percentile_over_the_frames_asked_for() -> None:
    levels = np.concatenate([np.full(50, -70.0), np.full(50, -20.0)])
    between = np.arange(100) < 50

    assert room_floor_db(levels) == pytest.approx(-70.0)
    assert room_floor_db(levels, percentile=90.0) == pytest.approx(-20.0)
    assert room_floor_db(levels, among=~between) == pytest.approx(-20.0)
    assert room_floor_db(levels, among=between, percentile=50.0) == pytest.approx(-70.0)


def test_speech_level_is_the_90th_percentile_of_the_live_frames() -> None:
    gate = np.full(500, DIGITAL_SILENCE_DB)
    voice = np.linspace(-50.0, -10.0, 100)

    assert speech_level_db(np.concatenate([gate, voice])) == pytest.approx(-14.0)


def test_speech_level_needs_half_a_second_of_live_frames_unless_told_otherwise() -> None:
    few = np.concatenate([np.full(500, DIGITAL_SILENCE_DB), np.full(49, -20.0)])

    assert speech_level_db(few) is None
    assert speech_level_db(few, min_live_sec=0.0) == pytest.approx(-20.0)
    assert speech_level_db(np.full(10, DIGITAL_SILENCE_DB), min_live_sec=0.0) is None


def test_a_whole_track_profile_reads_the_room_over_every_frame_digital_silence_included() -> None:
    # 3 s of room tone at 0.001 and 1 s of voice at 0.1, then 6 s a gate holds at zero.
    samples = np.concatenate(
        [
            np.full(3 * RATE, 0.001, dtype=np.float32),
            np.full(RATE, 0.1, dtype=np.float32),
            np.zeros(6 * RATE, dtype=np.float32),
        ]
    )

    assert level_profile(samples, RATE) == pytest.approx((0.001, 0.1))
    assert level_profile(samples, RATE, whole_track=True) == pytest.approx((1e-10, 0.1), abs=1e-8)


def _signal(seconds: float) -> np.ndarray:
    """Noise with a loud 400 Hz burst from 29.9 s to 30.3 s, straddling the first block edge."""
    x = np.random.default_rng(9).standard_normal(round(seconds * RATE)).astype(np.float32) * 0.001
    i = round(29.9 * RATE)
    n = round(0.4 * RATE)
    x[i : i + n] += 0.1 * np.sin(2 * np.pi * 400.0 * np.arange(n) / RATE).astype(np.float32)
    return x


def _reader(x: np.ndarray, calls: list[float] | None = None):
    def read(start: float, duration: float) -> np.ndarray:
        if calls is not None:
            calls.append(start)
        i = round(start * RATE)
        return x[i : i + round(duration * RATE)]

    return read


@pytest.mark.parametrize("band", [SPEECH_BAND, LOW_BAND])
def test_band_levels_across_a_block_edge_match_the_levels_of_the_whole_signal(band) -> None:
    x = _signal(75.0)
    calls: list[float] = []

    levels = BandLevels(_reader(x, calls), RATE, band).all_levels()
    whole = frame_band_filtered_db(x, RATE, 160, band, floor_db=DIGITAL_SILENCE_DB)

    assert levels is not None and levels.size == 7500
    # The burst straddles the 30 s block edge; the margin read either side of each block
    # keeps the filter's ringing at the edge out of the levels. The first and last few
    # frames of a file are the filter's own end effects, whichever way they are cut.
    assert levels[20:-20] == pytest.approx(whole[20:-20], abs=0.01)
    assert len(calls) == 3


def test_each_block_of_levels_is_read_once_however_often_it_is_asked_for() -> None:
    x = _signal(75.0)
    calls: list[float] = []
    bands = BandLevels(_reader(x, calls), RATE)

    first = bands.all_levels()
    second = bands.all_levels()

    assert first is not None and second is not None and len(calls) == 3
    assert second == pytest.approx(first)


def test_band_levels_end_where_the_audio_ends_whatever_the_media_says() -> None:
    # No duration is given or needed: the recording is as long as its audio. One whose
    # length is a whole number of blocks ends at the first empty read.
    assert BandLevels(_reader(_signal(42.0)), RATE).all_levels().size == 4200
    assert BandLevels(_reader(_signal(60.0)), RATE).all_levels().size == 6000


def test_band_levels_are_none_where_the_audio_is_unreadable_or_empty() -> None:
    def broken(start: float, duration: float) -> np.ndarray:
        raise OSError("no such file")

    def not_finite(start: float, duration: float) -> np.ndarray:
        return np.full(round(duration * RATE), np.nan, dtype=np.float32)

    def nothing(start: float, duration: float) -> np.ndarray:
        return np.empty(0, dtype=np.float32)

    assert BandLevels(_reader(_signal(35.0)), RATE).all_levels() is not None
    assert BandLevels(broken, RATE).all_levels() is None
    assert BandLevels(not_finite, RATE).all_levels() is None
    assert BandLevels(nothing, RATE).all_levels() is None


def test_a_block_that_cannot_be_read_late_in_a_recording_makes_it_unreadable() -> None:
    x = _signal(75.0)

    def fails_late(start: float, duration: float) -> np.ndarray:
        if start > 40.0:
            raise OSError("disk error")
        return _reader(x)(start, duration)

    assert BandLevels(fails_late, RATE).all_levels() is None
