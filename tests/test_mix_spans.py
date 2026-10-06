from __future__ import annotations

import wave
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import mix_spans
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.mix_spans import quiet_spans

RATE = 48_000


def _write(path: Path, mono: np.ndarray) -> Path:
    pcm = np.rint(np.clip(mono, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(RATE)
        stream.writeframes(np.repeat(pcm, 2).tobytes())
    return path


def _talk(tmp_path: Path) -> list[tuple[Path, float]]:
    """20 s of words with a 0.2 s pause every second, plus a click whose true peak sits
    between the two samples either side of a nominal split at 8 s. Measured in two parts
    cut there, it peaks 2 dB lower than in one pass."""
    t = np.arange(20 * RATE) / RATE
    words = 0.3 * np.sin(2 * np.pi * 330 * t) * ((t % 1.0) < 0.8)
    click = np.zeros(t.size)
    click[8 * RATE - 3 : 8 * RATE + 3] = [-0.6, -0.6, 0.85, 0.85, -0.6, -0.6]
    return [
        (_write(tmp_path / "host.wav", words), 0.0),
        (_write(tmp_path / "guest.wav", click), 0.0),
    ]


def test_a_split_mix_peaks_where_the_single_pass_does(tmp_path, monkeypatch):
    tracks = _talk(tmp_path)
    eng = FFmpegEngine()
    whole = eng.peak_trim_db(tracks, -1.0)
    monkeypatch.setattr(mix_spans, "MIN_SPAN_SEC", 4.0)

    spans = quiet_spans(tracks, -1.0)

    assert len(spans) == 5
    assert spans[0][0] == 0.0 and spans[-1][1] is None
    for (_, end), (start, _) in pairwise(spans):
        assert end is not None and end - start == pytest.approx(0.1)
        assert (end % 1.0) > 0.8 or (end % 1.0) == pytest.approx(0.0)
    assert whole < -2.0
    assert eng.peak_trim_db(tracks, -1.0) == whole


def test_a_mix_with_no_pause_is_one_span(tmp_path, monkeypatch):
    monkeypatch.setattr(mix_spans, "MIN_SPAN_SEC", 4.0)
    t = np.arange(20 * RATE) / RATE
    tone = _write(tmp_path / "tone.wav", 0.3 * np.sin(2 * np.pi * 330 * t))

    assert quiet_spans([(tone, 0.0)], -1.0) == [(0.0, None)]
