"""Split a long unity mix into spans that meet in quiet blocks, so its true peak can be
measured span by span in parallel and still equal the single-pass measurement.

FFmpeg's true-peak meter oversamples through a resampler whose first and last few dozen
output samples of a stream see zeros instead of their real neighbours. Two spans therefore
overlap on one whole quiet block: every sample is measured with its real neighbours in at
least one span, and the edge samples measured without them come from audio so far under the
ceiling that they can never set the trim.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.util.wav import open_wav
from podcast_mcp.util.wav_pcm import decode_integer_pcm

MIN_SPAN_SEC = 60.0
MAX_SPANS = 8
_SEARCH_SEC = 5.0
_BLOCK_SEC = 0.1
# An oversampling interpolator's output is at most the sum of its absolute taps (well
# under 10x) times its loudest input; 24 dB under the ceiling leaves ample room for that.
_QUIET_MARGIN_DB = 24.0


def _wav_layout(path: Path) -> tuple[int, int] | None:
    """``(sample rate, frame count)`` of an integer PCM WAV, or None when unreadable."""
    try:
        with open_wav(path) as audio:
            return audio.getframerate(), audio.getnframes()
    except (wave.Error, OSError, EOFError):
        return None


def _envelope(track_wavs: list[tuple[Path, float]], start: int, frames: int) -> np.ndarray:
    """Per-frame upper bound on the mix's absolute level: each input's loudest channel at its gain."""
    bound = np.zeros(frames)
    for path, gain_db in track_wavs:
        with open_wav(path) as audio:
            if start >= audio.getnframes():
                continue
            audio.setpos(start)
            raw = audio.readframes(frames)
            samples = decode_integer_pcm(
                raw,
                width=audio.getsampwidth(),
                channels=audio.getnchannels(),
                dtype="float64",
            )
        level = np.abs(samples).max(axis=1) * 10 ** (gain_db / 20)
        bound[: len(level)] += level
    return bound


def quiet_spans(
    track_wavs: list[tuple[Path, float]], ceiling_db: float, count: int = MAX_SPANS
) -> list[tuple[float, float | None]]:
    """Up to ``count`` ``(start, end)`` spans in seconds covering the mix; ``end`` None is EOF.

    Each inner boundary is a quiet block near an even split, shared by the spans on both
    sides of it. A boundary with no quiet block within a few seconds is dropped, so a mix
    with no pauses, or inputs that aren't PCM WAVs at one rate, is one span.
    """
    layouts = [layout for path, _ in track_wavs if (layout := _wav_layout(path)) is not None]
    if not layouts or len(layouts) != len(track_wavs) or len({r for r, _ in layouts}) != 1:
        return [(0.0, None)]
    rate = layouts[0][0]
    total = max(frames for _, frames in layouts)
    count = min(count, int(total / (rate * MIN_SPAN_SEC)))
    if count <= 1:
        return [(0.0, None)]
    block = max(1, int(rate * _BLOCK_SEC))
    search = int(rate * _SEARCH_SEC) // block * block
    limit = 10 ** ((ceiling_db - _QUIET_MARGIN_DB) / 20)
    quiet: list[tuple[int, int]] = []
    for k in range(1, count):
        # Search whole blocks inside the mix and after the previous boundary.
        lo = max(quiet[-1][1] if quiet else block, (total * k // count - search) // block * block)
        blocks = (min(total - block, lo + 2 * search) - lo) // block
        if blocks < 1:
            continue
        peaks = _envelope(track_wavs, lo, blocks * block).reshape(-1, block).max(axis=1)
        best = int(peaks.argmin())
        if peaks[best] <= limit:
            quiet.append((lo + best * block, lo + (best + 1) * block))
    starts = [0, *(start for start, _ in quiet)]
    ends: list[int | None] = [*(end for _, end in quiet), None]
    return [(s / rate, None if e is None else e / rate) for s, e in zip(starts, ends, strict=True)]
