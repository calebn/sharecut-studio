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
from podcast_mcp.util.dsp import frame_speech_band_db

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


def test_band_levels_across_a_block_edge_match_the_levels_of_the_whole_signal() -> None:
    x = _signal(75.0)
    calls: list[tuple[float, float]] = []

    def read(start: float, duration: float) -> np.ndarray:
        calls.append((start, duration))
        i = round(start * RATE)
        return x[i : i + round(duration * RATE)]

    bands = BandLevels(read, RATE)
    got = bands.levels(29.0, 31.5)
    whole = frame_speech_band_db(x, RATE, 160, floor_db=DIGITAL_SILENCE_DB)

    assert got is not None and got.size == 250
    assert got == pytest.approx(whole[2900:3150], abs=0.01)
    # Each 30 s block is read once, with a second either side, however often it is asked for.
    assert len(calls) == 2
    bands.levels(29.0, 31.5)
    bands.levels(10.0, 20.0)
    assert len(calls) == 2


def test_band_levels_end_where_the_audio_ends_and_are_none_past_it_or_where_unreadable() -> None:
    x = _signal(42.0)

    def read(start: float, duration: float) -> np.ndarray:
        i = round(start * RATE)
        return x[i : i + round(duration * RATE)]

    def broken(start: float, duration: float) -> np.ndarray:
        raise OSError("no such file")

    assert BandLevels(read, RATE).levels(40.0, 50.0).size == 200
    assert BandLevels(read, RATE).levels(60.0, 61.0) is None
    assert BandLevels(broken, RATE).levels(0.0, 1.0) is None
    assert (
        BandLevels(lambda start, duration: np.empty(0, dtype=np.float32), RATE).levels(0.0, 1.0)
        is None
    )


def test_band_speech_level_is_one_number_for_the_whole_track_read_once() -> None:
    x = _signal(75.0)
    calls: list[float] = []

    def read(start: float, duration: float) -> np.ndarray:
        calls.append(start)
        i = round(start * RATE)
        return x[i : i + round(duration * RATE)]

    bands = BandLevels(read, RATE, 75.0)
    whole = frame_speech_band_db(x, RATE, 160, floor_db=DIGITAL_SILENCE_DB)

    assert bands.speech_db() == pytest.approx(speech_level_db(whole.astype(np.float32)), abs=0.01)
    assert len(calls) == 3
    bands.speech_db()
    bands.levels(10.0, 20.0)
    assert len(calls) == 3


def test_band_speech_level_is_none_where_the_track_cannot_be_read_or_has_no_length() -> None:
    def broken(start: float, duration: float) -> np.ndarray:
        raise OSError("no such file")

    assert BandLevels(broken, RATE, 60.0).speech_db() is None
    assert BandLevels(lambda start, duration: np.zeros(1), RATE).speech_db() is None
