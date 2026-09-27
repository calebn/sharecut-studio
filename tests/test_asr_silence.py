from __future__ import annotations

import wave

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import (
    digital_silence_fraction,
    flag_silent_words_in_file,
    flag_words_over_silence,
    peak_envelope,
    refresh_silence_flags,
    silent_fraction,
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


def test_file_wrapper_success_and_failure(monkeypatch, tmp_path, caplog):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    words = [_w(0.2, 0.5)]
    assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) == 1

    def boom(*a, **k):
        raise RuntimeError("no decode")

    monkeypatch.setattr(asr_silence, "peak_envelope", boom)
    with caplog.at_level("WARNING"):
        assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) is None
    assert "silence filter skipped" in caplog.text


def test_peak_envelope_native_rate_stereo_high_frequency(tmp_path):
    sr = 44100
    t = np.arange(sr) / sr
    sine = np.round(0.003 * 32767 * np.sin(2 * np.pi * 6000 * t)).astype("<i2")
    zeros = np.zeros(sr, dtype="<i2")
    left = np.concatenate([zeros, zeros])
    right = np.concatenate([zeros, sine])
    path = tmp_path / "s.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(np.column_stack([left, right]).astype("<i2").tobytes())
    peaks, rate = peak_envelope(path)
    assert rate == pytest.approx(100.0)
    assert peaks.size == 200
    assert float(peaks[:100].max()) == 0.0
    assert float(peaks[100:].max()) > 10 ** (-60 / 20)
    words = [_w(0.2, 0.5), _w(1.2, 1.5)]
    assert flag_silent_words_in_file(words, path, peak_dbfs=-60.0) == 1
    assert [w.suspect_hallucination for w in words] == [True, False]


def test_real_decode_of_tone(sample_wav):
    words = [_w(0.5, 1.0)]
    assert flag_silent_words_in_file(words, sample_wav, peak_dbfs=-60.0) == 0
    assert not words[0].suspect_hallucination


def test_silent_fraction_counts_blocks_below_floor():
    peaks = np.array([0.0, 1e-5, 0.5, 0.2], dtype=np.float32)
    assert silent_fraction(peaks, peak_dbfs=-60.0) == 0.5
    assert silent_fraction(np.array([], dtype=np.float32), peak_dbfs=-60.0) == 0.0


def test_digital_silence_fraction_real_decode(tmp_path):
    sr = 8000
    zeros = np.zeros(sr * 3, dtype=np.float32)
    t = np.arange(sr) / sr
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    samples = np.concatenate([zeros, tone])
    ints = np.round(samples * 32767).astype("<i2")
    path = tmp_path / "mostly_silent.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(ints.tobytes())

    frac = digital_silence_fraction(path, peak_dbfs=-60.0)
    assert frac is not None
    assert 0.70 <= frac <= 0.80


def test_digital_silence_fraction_undecodable(monkeypatch, tmp_path, caplog):
    from podcast_mcp.engines import asr_silence

    def boom(*a, **k):
        raise RuntimeError("no decode")

    monkeypatch.setattr(asr_silence, "peak_envelope", boom)
    asr_silence._cached_silent_fraction.cache_clear()
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    with caplog.at_level("WARNING"):
        result = asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert result is None
    assert "digital silence measure skipped" in caplog.text


def test_digital_silence_fraction_cached_per_file_version(monkeypatch, tmp_path):
    import os

    from podcast_mcp.engines import asr_silence

    asr_silence._cached_silent_fraction.cache_clear()
    calls = []

    def fake_envelope(path, **_k):
        calls.append(path)
        return np.array([0.0, 0.0, 0.0, 0.5], dtype=np.float32), 100.0

    monkeypatch.setattr(asr_silence, "peak_envelope", fake_envelope)
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    assert asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0) == 0.75
    assert asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0) == 0.75
    assert len(calls) == 1
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert len(calls) == 2
    asr_silence.digital_silence_fraction(p, peak_dbfs=-50.0)
    assert len(calls) == 3
    asr_silence._cached_silent_fraction.cache_clear()


def test_digital_silence_fraction_missing_file(tmp_path, caplog):
    with caplog.at_level("WARNING"):
        assert digital_silence_fraction(tmp_path / "nope.wav", peak_dbfs=-60.0) is None
    assert "digital silence measure skipped" in caplog.text


def test_refresh_silence_flags_off_clears_and_on_reflags(monkeypatch, tmp_path):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    words = [_w(0.2, 0.5)]
    words[0].suspect_hallucination = True
    path = tmp_path / "a.wav"
    assert refresh_silence_flags(words, path, AsrOptions(silence_filter_enabled=False)) == 0
    assert words[0].suspect_hallucination is False
    assert refresh_silence_flags(words, path, AsrOptions()) == 1
    assert words[0].suspect_hallucination is True
