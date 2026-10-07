from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.word_onset import (
    OnsetKind,
    next_onset,
    voice_end,
    voice_floor_db,
    voice_onset,
    voice_separates,
)
from podcast_mcp.engines.audio_audit import TrackRmsCache

RATE = 16_000
QUIET_DB = -42.0


def _db(level_db: float) -> float:
    return float(10 ** (level_db / 20))


def _voice(n: int, *, f0: float = 150.0, level_db: float = -20.0) -> np.ndarray:
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    return tone / np.sqrt(np.mean(tone**2)) * _db(level_db)


def _cache(
    *segments: tuple[float, np.ndarray], room_db: float = -95.0, gain_db: float = 0.0
) -> TrackAudioCache:
    """Room noise at ``room_db`` with each ``(start_sec, samples)`` segment added on top,
    all recorded ``gain_db`` hotter."""
    rng = np.random.default_rng(7)
    samples = rng.standard_normal(3 * RATE) * _db(room_db)
    for start, segment in segments:
        i = round(start * RATE)
        samples[i : i + segment.size] += segment
    track = TrackRmsCache((samples * _db(gain_db)).astype(np.float32), RATE)
    return TrackAudioCache(track, track)


def _burst(level_db: float) -> np.ndarray:
    return np.random.default_rng(3).standard_normal(round(0.008 * RATE)) * _db(level_db)


def _ramp(n: int, *, from_db: float, to_db: float, seed: int = 5) -> np.ndarray:
    """White noise whose level moves linearly in dB: the shape of a fricative's rise."""
    gain = np.power(10.0, np.linspace(from_db, to_db, n) / 20.0)
    return np.random.default_rng(seed).standard_normal(n) * gain


def _voice_envelope(*knots: tuple[float, float]) -> tuple[float, np.ndarray]:
    """One unbroken voice whose level follows ``(sec, dB)`` knots; no phase clicks."""
    (t_first, _), (t_last, _) = knots[0], knots[-1]
    times = np.arange(round((t_last - t_first) * RATE)) / RATE + t_first
    db = np.interp(times, [t for t, _ in knots], [level for _, level in knots])
    return t_first, _voice(times.size, level_db=0.0) * np.power(10.0, db / 20.0)


# A filler that decays 16 dB into a low, dark stretch with no quiet in it. The stretch
# creeps up by a dB, so its trough is where it begins (1.38).
_FILLER_DECAY = ((1.0, -20.0), (1.3, -20.0), (1.38, -36.6), (1.45, -35.4))


def test_plosive_out_of_quiet_is_a_burst_even_below_the_audibility_floor():
    burst_at = 1.42
    cache = _cache(
        (1.0, _voice(round(0.3 * RATE))),
        (burst_at, _burst(-50.0)),
        (1.45, _voice(round(0.3 * RATE), level_db=-18.0)),
    )
    onset = next_onset(cache, 1.3, 1.62, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.41)
    assert onset.kind is OnsetKind.BURST


def test_fricative_out_of_quiet_ramps_and_is_gradual():
    # "she" at 1441.71: the high band climbs about 4 dB per frame, not in one jump.
    ramp = _ramp(round(0.1 * RATE), from_db=-90.0, to_db=-50.0)
    cache = _cache(
        (1.0, _voice(round(0.3 * RATE))),
        (1.42, ramp),
        (1.52, _ramp(4000, from_db=-50.0, to_db=-35.0)),
    )
    onset = next_onset(cache, 1.3, 1.7, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.47, abs=0.03)
    assert onset.kind is OnsetKind.GRADUAL


def test_onset_in_continuous_voice_is_the_foot_of_the_rise_not_the_trough():
    # "uh, we" at 706.3-706.5: the level falls into a low, dark stretch and the vowel
    # climbs out of it. The owner still heard "uh" with the cut at the trough.
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.48, -18.0), (1.68, -18.0)))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.43, abs=0.011)
    assert onset.kind is OnsetKind.GRADUAL


@pytest.mark.parametrize("seconds", [0.1, 0.04])
def test_continuous_voice_into_a_ramp_is_gradual(seconds):
    # 0.04 s is a 14 dB per frame climb, the pace of "we" out of its dark stretch
    # (lab 706.45): a new sound, but one a fade-in can cover.
    ramp = _ramp(round(seconds * RATE), from_db=-80.0, to_db=-40.0)
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.65, -35.4)), (1.45, ramp))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.44, abs=0.02)
    assert onset.kind is OnsetKind.GRADUAL


def test_plosive_in_continuous_voice_is_a_burst():
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.65, -35.4)), (1.5, _burst(-30.0)))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.kind is OnsetKind.BURST


def test_no_onset_before_the_planned_end():
    cache = _cache((1.0, _voice(round(0.3 * RATE))), (2.0, _voice(round(0.3 * RATE))))
    assert next_onset(cache, 1.3, 1.9, quiet_db=QUIET_DB) is None
    onset = next_onset(cache, 1.3, 2.1, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.99)


@pytest.mark.parametrize(
    ("voice_until", "expected"),
    [
        # The voice runs 80 ms past the word end: it ends with its last audible frame,
        # as a voiced run does (lab "So" at 230.78 voices until 230.98).
        (1.08, 1.09),
        # A voice that stops at the word end reports the word end.
        (1.0, 1.0),
    ],
)
def test_voice_end_walks_forward_to_the_first_quiet_frame(voice_until, expected):
    cache = _cache((0.6, _voice(round((voice_until - 0.6) * RATE))))

    assert voice_end(cache, 1.0, 1.5) == pytest.approx(expected, abs=1e-6)


def test_voice_end_is_none_when_the_voice_runs_through_the_ceiling():
    cache = _cache((0.6, _voice(round(0.8 * RATE))))

    assert voice_end(cache, 1.0, 1.3) is None
    assert voice_end(cache, 1.0, 1.5) == pytest.approx(1.41, abs=1e-6)


def test_voice_onset_walks_back_to_the_last_quiet_frame():
    # The next word voices 110 ms before its word start.
    cache = _cache((1.49, _voice(round(0.4 * RATE))))

    assert voice_onset(cache, 1.6, 1.0) == pytest.approx(1.48, abs=1e-6)
    assert voice_onset(cache, 1.6, 1.55) is None


@pytest.mark.parametrize(
    ("room_db", "floor_db"),
    [
        # 27 dB under the speech level (the 90th percentile of live 10 ms frames).
        (-95.0, -47.0),
        # Never within 6 dB of the room (the 10th percentile): a noisy track.
        (-45.0, -39.0),
    ],
)
def test_voice_floor_is_relative_to_the_tracks_speech_and_room(room_db, floor_db):
    # Speech fills 0.9 of 3 s, so the 90th percentile is the speech and the 10th the room.
    cache = _cache((1.0, _voice(round(0.9 * RATE))), room_db=room_db)

    assert voice_floor_db(cache) == pytest.approx(floor_db, abs=1.0)


def test_a_track_of_digital_silence_is_quiet_everywhere():
    track = TrackRmsCache(np.zeros(3 * RATE, dtype=np.float32), RATE)
    cache = TrackAudioCache(track, track)

    assert voice_floor_db(cache) == np.inf
    assert voice_end(cache, 1.0, 1.5) == 1.0
    assert voice_onset(cache, 1.6, 1.0) == 1.6


def test_voice_floor_of_a_gated_track_reads_its_digital_silence_as_room():
    # A noise gate holds the track at digital zero between words (Zoom), and the
    # speech is only 0.3 s of it: the quietest live frames are the words' soft edges.
    samples = np.zeros(3 * RATE)
    for start in (0.5, 1.5):
        word = _voice(round(0.15 * RATE)) * np.hanning(round(0.15 * RATE))
        samples[round(start * RATE) : round(start * RATE) + word.size] = word
    track = TrackRmsCache(samples.astype(np.float32), RATE)

    # 27 dB under the words' 90th percentile, not 6 dB over their faded edges.
    assert voice_floor_db(TrackAudioCache(track, track)) == pytest.approx(-47.0, abs=1.0)


def _noise_envelope(*knots: tuple[float, float]) -> tuple[float, np.ndarray]:
    """Unvoiced noise (a fricative) whose level follows ``(sec, dB)`` knots."""
    (t_first, _), (t_last, _) = knots[0], knots[-1]
    times = np.arange(round((t_last - t_first) * RATE)) / RATE + t_first
    db = np.interp(times, [t for t, _ in knots], [level for _, level in knots])
    return t_first, _ramp(times.size, from_db=0.0, to_db=0.0) * np.power(10.0, db / 20.0)


def _so_then_ss_uh(*, gain_db: float = 0.0, ss_db: float = -28.0, dip_db: float = -48.0):
    """Two owner cases on one track, speech at -20 dB, so the voice floor is -47 dBFS.

    "So" (lab 230.78): its word time ends at 0.50, its voice holds full level to 0.60
    and then decays at 220 dB/s, as the lab vowel does, into the room.
    "digress." -> "uh" (lab 705.8-706.3): the "ss" at ``ss_db`` from 1.45, a 20 ms dip
    to ``dip_db`` at 1.69, then the "uh" voices; its word time starts late, at 1.95.
    """
    return _cache(
        _voice_envelope((0.2, -80.0), (0.23, -20.0), (0.6, -20.0), (0.6 + 75 / 220, -95.0)),
        _noise_envelope(
            (1.45, -95.0), (1.47, ss_db), (1.62, ss_db), (1.69, dip_db), (1.72, dip_db)
        ),
        _voice_envelope(
            (1.70, dip_db), (1.71, dip_db), (1.74, -30.0), (1.85, -20.0), (2.3, -20.0), (2.4, -90.0)
        ),
        gain_db=gain_db,
    )


@pytest.mark.parametrize("gain_db", [-18.0, -12.0, 0.0, 6.0, 12.0])
def test_voice_edges_are_the_same_at_every_recording_level(gain_db):
    level = _so_then_ss_uh()
    scaled = _so_then_ss_uh(gain_db=gain_db)

    so_end = voice_end(level, 0.5, 1.4)
    uh_onset = voice_onset(level, 1.95, 1.45)

    # "So" voices on past its word time until its decay is 27 dB under the speech;
    # the "uh" voices from the dip.
    assert so_end == pytest.approx(0.6 + 27 / 220, abs=0.02)
    assert uh_onset == pytest.approx(1.70, abs=0.011)
    assert voice_end(scaled, 0.5, 1.4) == pytest.approx(so_end, abs=0.011)
    assert voice_onset(scaled, 1.95, 1.45) == pytest.approx(uh_onset, abs=0.011)


@pytest.mark.parametrize(
    ("ss_db", "dip_db", "onset"),
    [
        # A dip 1 dB over the -47 dBFS floor is still the valley between the "ss" and
        # the "uh", 18 and 26 dB under them (lab 706.00: 19 and 28 dB).
        (-28.0, -46.0, 1.70),
        # So is a dip under the floor.
        (-28.0, -50.0, 1.70),
        # A valley 7 dB over the floor is not where a voice ends, deep as it is: walks
        # would stop at stop closures inside words. The "uh" runs on from "digress.".
        (-22.0, -40.0, None),
        # Nor is a dip the "ss" barely falls into.
        (-28.0, -43.0, None),
    ],
)
def test_a_valley_near_the_floor_ends_a_voice(ss_db, dip_db, onset):
    cache = _so_then_ss_uh(ss_db=ss_db, dip_db=dip_db)

    assert voice_floor_db(cache) == pytest.approx(-47.0, abs=0.5)
    found = voice_onset(cache, 1.95, 1.45)
    assert found == (None if onset is None else pytest.approx(onset, abs=0.011))


@pytest.mark.parametrize(
    ("dip_db", "separated"),
    [
        # A valley 20 dB under the words either side, far over the floor (lab 753.16:
        # -30 dBFS between "well," and "that").
        (-40.0, True),
        # Level within a few dB from word to word (Whisper's "that" at 752.72-752.90,
        # inside the voice of "well,").
        (-23.0, False),
    ],
)
def test_voice_separates_at_any_deep_valley(dip_db, separated):
    _, word = _voice_envelope(
        (1.0, -20.0), (1.4, -20.0), (1.45, dip_db), (1.5, -20.0), (1.9, -20.0)
    )
    cache = _cache((1.0, word))

    assert voice_separates(cache, 1.3, 1.7) is separated
    assert voice_end(cache, 1.3, 1.7) is None


def test_a_ripple_on_the_slope_into_a_dip_is_not_a_valley():
    from podcast_mcp.edits.word_onset import _voice_breaks

    # Lab 705.95-706.03: the "ss" falls through -40 dBFS, eases by half a dB, then
    # dips to -41, 1 dB over the floor, before the "uh". Only the bottom ends "digress.".
    levels = np.array([-24.0, -30.0, -37.0, -40.0, -39.5, -41.0, -41.0, -32.0, -15.0, -15.0])

    breaks = _voice_breaks(levels, -42.3, valley_max_db=-39.3, depth_db=15.0)

    assert breaks.tolist() == [False] * 5 + [True, True] + [False] * 3
