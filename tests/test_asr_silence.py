from __future__ import annotations

import numpy as np

from podcast_mcp.engines.asr_silence import (
    SILENCE_SAMPLE_RATE,
    flag_silent_words_in_file,
    flag_words_over_silence,
)
from podcast_mcp.models import TranscriptWord

SR = 8000


def _w(start: float, end: float) -> TranscriptWord:
    return TranscriptWord(text="x", start=start, end=end)


def _audio() -> np.ndarray:
    """0-1 s zeros, 1-2 s tone."""
    t = np.arange(SR) / SR
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    return np.concatenate([np.zeros(SR, dtype=np.float32), tone])


def test_flags_zero_span_not_tone():
    words = [_w(0.2, 0.5), _w(1.2, 1.5)]
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 1
    assert [w.suspect_hallucination for w in words] == [True, False]


def test_min_span_widens_zero_length_word():
    words = [_w(1.0, 1.0)]  # widened to 50 ms, so it reaches into the tone
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 0
    assert not words[0].suspect_hallucination


def test_stale_flag_reset_and_past_end_stays_false():
    words = [_w(1.2, 1.5), _w(5.0, 5.5)]
    words[0].suspect_hallucination = True
    words[1].suspect_hallucination = True
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 0
    assert not any(w.suspect_hallucination for w in words)


def test_threshold_respected():
    quiet = np.full(SR, 0.001, dtype=np.float32)  # -60 dBFS peak
    assert flag_words_over_silence([_w(0.1, 0.4)], quiet, SR, peak_dbfs=-50.0) == 1
    assert flag_words_over_silence([_w(0.1, 0.4)], quiet, SR, peak_dbfs=-70.0) == 0


def test_file_wrapper_success_and_failure(monkeypatch, tmp_path):
    from podcast_mcp.engines import audio_audit

    monkeypatch.setattr(audio_audit, "load_mono_full", lambda *a, **k: _audio())
    words = [_w(0.2, 0.5)]
    assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) == 1
    assert SILENCE_SAMPLE_RATE == SR

    def boom(*a, **k):
        raise RuntimeError("no decode")

    monkeypatch.setattr(audio_audit, "load_mono_full", boom)
    assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) is None


def test_real_decode_of_tone(sample_wav):
    words = [_w(0.5, 1.0)]
    assert flag_silent_words_in_file(words, sample_wav, peak_dbfs=-60.0) == 0
    assert not words[0].suspect_hallucination
