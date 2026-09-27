"""Flag ASR words that sit over digital silence (issue #521).

Whisper sometimes invents text over silent stretches. A word whose own-track
peak is below a very low floor cannot have been spoken on that track, so it is
marked ``suspect_hallucination``. Words are never deleted or retimed.

The track is streamed at its native rate and layout, so there is no resampling and
energy above 4 kHz still counts. It is reduced to a per-block peak envelope, so
memory stays small on long tracks.

Analyze (``suggest_pipeline_tuning``) reuses the same envelope to flag a dialogue
source that is mostly digital silence, a sign of a gated stem worth VAD. The
resulting fraction is cached in-process per file version.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from functools import lru_cache
from hashlib import sha256
from pathlib import Path

import numpy as np

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.models import TranscriptWord
from podcast_mcp.util.dsp import db_to_amplitude
from podcast_mcp.util.project_state import FileRevision, file_revision

log = logging.getLogger(__name__)

PEAK_BLOCK_SEC = 0.01
MIN_SPAN_SEC = 0.05


def silence_filter_fingerprint(
    words: Sequence[TranscriptWord], audio_sha256: str, options: AsrOptions
) -> str:
    """Identify the media, filter policy, spans and stored flag state."""
    digest = sha256()
    digest.update(f"v2:{audio_sha256}:{options.silence_filter_enabled}:".encode())
    if options.silence_filter_enabled:
        digest.update(f"{float(options.silence_peak_dbfs).hex()}:".encode())
    for word in words:
        digest.update(
            f"{word.start.hex()}:{word.end.hex()}:{int(word.suspect_hallucination)};".encode()
        )
    return digest.hexdigest()


def flag_words_over_silence(
    words: Sequence[TranscriptWord],
    peaks: np.ndarray,
    rate: float,
    *,
    peak_dbfs: float,
) -> int:
    """Set ``suspect_hallucination`` on every word; return how many are True.

    ``peaks`` holds absolute sample peaks at ``rate`` values per second (raw samples,
    or a block envelope from :func:`peak_envelope`).
    """
    floor = db_to_amplitude(peak_dbfs)
    total = int(peaks.size)
    flagged = 0
    for w in words:
        w.suspect_hallucination = False
        centre = (w.start + w.end) / 2.0
        half = max(w.end - w.start, MIN_SPAN_SEC) / 2.0
        lo = max(0, int((centre - half) * rate))
        hi = min(total, int(np.ceil((centre + half) * rate)))
        if lo >= hi:
            continue  # span outside the decoded audio: no evidence either way
        if float(np.max(peaks[lo:hi])) < floor:
            w.suspect_hallucination = True
            flagged += 1
    return flagged


def peak_envelope(path: Path, *, block_sec: float = PEAK_BLOCK_SEC) -> tuple[np.ndarray, float]:
    """Stream ``path``; return ``(peaks, rate)``: max |sample| over all channels per block."""
    from podcast_mcp.engines.waveform_pyramid import decode_media

    sample_rate, _channels, chunks = decode_media(path)
    block = max(1, round(sample_rate * block_sec))
    parts: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    try:
        for chunk in chunks:
            frame_peaks = np.abs(chunk).max(axis=1) if chunk.ndim == 2 else np.abs(chunk)
            buf = np.concatenate([carry, frame_peaks.astype(np.float32, copy=False)])
            whole = buf.size // block
            if whole:
                parts.append(buf[: whole * block].reshape(whole, block).max(axis=1))
            carry = buf[whole * block :]
    finally:
        chunks.close()
    if carry.size:
        parts.append(np.array([carry.max()], dtype=np.float32))
    if not parts:
        raise ValueError(f"no audio decoded from {path}")
    return np.concatenate(parts), sample_rate / block


def silent_fraction(peaks: np.ndarray, *, peak_dbfs: float) -> float:
    """Share of ``peaks`` blocks below ``peak_dbfs`` (0.0 for an empty envelope)."""
    if peaks.size == 0:
        return 0.0
    return float(np.count_nonzero(peaks < db_to_amplitude(peak_dbfs)) / peaks.size)


@lru_cache(maxsize=64)
def _cached_silent_fraction(path: str, revision: FileRevision, peak_dbfs: float) -> float:
    """Decode ``path`` once per (``file_revision``, peak_dbfs); ``revision`` is only a cache key."""
    del revision  # cache key only
    peaks, _rate = peak_envelope(Path(path))
    return silent_fraction(peaks, peak_dbfs=peak_dbfs)


def digital_silence_fraction(path: Path, *, peak_dbfs: float) -> float | None:
    """Share of ``path``'s ``PEAK_BLOCK_SEC`` blocks that are digital silence.

    Cached in-process per resolved path, ``file_revision`` (device, inode, size, mtime)
    and ``peak_dbfs``, so a re-run Analyze (GUI button, MCP) does not decode an unchanged
    file again; an atomic replace misses the cache. An in-place rewrite that keeps inode,
    size and mtime is not detected until the process restarts.
    ``None`` (a warning is logged) when the media cannot be read or decoded; failures
    are not cached.
    """
    try:
        return _cached_silent_fraction(str(path.resolve()), file_revision(path), float(peak_dbfs))
    except Exception as exc:
        log.warning("digital silence measure skipped for %s: %s", path, exc)
        return None


def flag_silent_words_in_file(
    words: Sequence[TranscriptWord],
    path: Path,
    *,
    peak_dbfs: float,
) -> int | None:
    """Flag silent words in ``path``; ``None`` (logged as a warning) when it cannot be decoded."""
    try:
        peaks, rate = peak_envelope(path)
    except Exception as exc:
        log.warning("silence filter skipped for %s: %s", path, exc)
        return None
    return flag_words_over_silence(words, peaks, rate, peak_dbfs=peak_dbfs)


def refresh_silence_flags(
    words: Sequence[TranscriptWord], path: Path, options: AsrOptions
) -> int | None:
    """Recompute ``suspect_hallucination`` on ``words`` from ``options``' silence filter.

    Every flag is cleared first. Returns the flagged count (0 when the filter is off), or
    ``None`` when ``path`` cannot be decoded (flags stay cleared, a warning is logged).
    """
    for w in words:
        w.suspect_hallucination = False
    if not options.silence_filter_enabled:
        return 0
    return flag_silent_words_in_file(words, path, peak_dbfs=options.silence_peak_dbfs)
