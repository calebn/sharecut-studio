"""The ASR silence filter judges a word silent against its own track's levels (#1366).

The same recording at a lower level must flag the same words. Every scenario is written
at several gains as float-range PCM and run through ``refresh_silence_flags``, the one
entry both ``transcribe_tracks`` and the reuse refresh call.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import refresh_silence_flags
from podcast_mcp.models import TranscriptWord

RATE = 16_000
GAINS_DB = (12.0, 0.0, -12.0, -24.0, -36.0)
SPEECH_DB = -24.0
ROOM_DB = -66.0


def _voice(audio: np.ndarray, start: float, end: float, level_db: float, f0: float = 140.0) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    t = np.arange(hi - lo) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    audio[lo:hi] += tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)


def _write(path: Path, samples: np.ndarray, gain_db: float) -> None:
    scaled = np.clip(samples * 10 ** (gain_db / 20), -1.0, 1.0)
    ints = np.rint(scaled * 8388607).astype("<i4")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(3)
        handle.setframerate(RATE)
        handle.writeframes(ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())


def _room(seconds: float, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, 10 ** (ROOM_DB / 20), round(seconds * RATE))


Spans = list[tuple[float, float]]


def _ungated(seconds: float, speech: Spans) -> tuple[np.ndarray, list[TranscriptWord]]:
    audio = _room(seconds, 7)
    for start, end in speech:
        _voice(audio, start, end, SPEECH_DB)
    return audio, [TranscriptWord(text="w", start=s, end=e) for s, e in speech]


def _gated(seconds: float, speech: Spans) -> tuple[np.ndarray, list[TranscriptWord]]:
    audio = np.zeros(round(seconds * RATE))
    for start, end in speech:
        _voice(audio, start, end, SPEECH_DB)
    return audio, [TranscriptWord(text="w", start=s, end=e) for s, e in speech]


def _flags(tmp_path: Path, audio: np.ndarray, gain_db: float, spans: Spans) -> list[bool]:
    path = tmp_path / f"track_{gain_db:+.0f}.wav"
    _write(path, audio, gain_db)
    words = [TranscriptWord(text="w", start=s, end=e) for s, e in spans]
    assert refresh_silence_flags(words, path, AsrOptions()) is not None
    return [w.suspect_hallucination for w in words]


SPOKEN: Spans = [(1.0, 1.7), (3.0, 3.6), (5.0, 5.8), (8.0, 9.0), (11.0, 11.5), (13.0, 14.0)]
INVENTED: Spans = [(2.0, 2.6), (6.5, 7.2), (10.0, 10.6), (15.0, 15.8)]
ALL: Spans = sorted(SPOKEN + INVENTED)
EXPECTED = [span in INVENTED for span in ALL]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_ungated_track_flags_room_tone_words_at_every_level(tmp_path, gain_db):
    audio, _ = _ungated(17.0, SPOKEN)
    assert _flags(tmp_path, audio, gain_db, ALL) == EXPECTED


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_gated_track_flags_digital_silence_words_at_every_level(tmp_path, gain_db):
    audio, _ = _gated(17.0, SPOKEN)
    assert _flags(tmp_path, audio, gain_db, ALL) == EXPECTED


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_sparse_ungated_speaker_flags_the_same_words_at_every_level(tmp_path, gain_db):
    sparse_speech: Spans = [(10.0, 10.8), (31.0, 31.6), (52.0, 52.9)]
    invented: Spans = [(20.0, 20.7), (41.0, 41.8)]
    audio, _ = _ungated(60.0, sparse_speech)
    spans = sorted(sparse_speech + invented)
    assert _flags(tmp_path, audio, gain_db, spans) == [s in invented for s in spans]


def test_one_flag_set_across_all_levels(tmp_path):
    audio, _ = _ungated(17.0, SPOKEN)
    results = {gain: tuple(_flags(tmp_path, audio, gain, ALL)) for gain in GAINS_DB}
    assert len(set(results.values())) == 1
    assert sum(results[0.0]) == len(INVENTED)


def test_soft_but_audible_word_is_not_flagged_at_any_level(tmp_path):
    audio = _room(17.0, 3)
    for start, end in SPOKEN:
        _voice(audio, start, end, SPEECH_DB)
    _voice(audio, 15.0, 15.8, SPEECH_DB - 14.0)
    for gain_db in GAINS_DB:
        assert _flags(tmp_path, audio, gain_db, [(15.0, 15.8)]) == [False]


def test_track_with_no_live_audio_flags_every_word(tmp_path):
    flags = _flags(tmp_path, np.zeros(RATE * 4), 0.0, [(0.5, 1.0), (2.0, 2.5)])
    assert flags == [True, True]


def test_track_with_no_contrast_flags_nothing_but_digital_silence(tmp_path):
    audio = _room(10.0, 5)
    assert _flags(tmp_path, audio, -24.0, [(1.0, 1.5), (6.0, 6.5)]) == [False, False]
