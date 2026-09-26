from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.process import run

log = logging.getLogger(__name__)


class AudioWindowUnavailableError(ValueError):
    """An analysis window decoded no (or too little) audio, e.g. it starts past EOF."""


_MAX_WAV_RATE = 192_000
_MAX_WAV_CHANNELS = 8
_MAX_WAV_WINDOW_BYTES = 16 * 1024 * 1024


@dataclass
class AlignmentResult:
    reference: Path
    source: Path
    offset_sec: float
    correlation_peak: float


def _xcorr_lag_window(
    ref: np.ndarray,
    src: np.ndarray,
    max_lag_samples: int,
    *,
    phat: bool = False,
) -> tuple[np.ndarray, int]:
    """Return correlation samples covering ±max_lag and the index of lag 0.

    FFT xcorr is equivalent to ``np.correlate(..., mode="full")`` but only the
    lags inside the search bound are materialized. ``phat=True`` divides the
    cross-spectrum by its magnitude (GCC-PHAT).
    """
    n = len(ref)
    fft_n = 1 << int(np.ceil(np.log2(2 * n - 1)))
    spec = np.fft.rfft(ref, fft_n) * np.conj(np.fft.rfft(src, fft_n))
    if phat:
        mag = np.abs(spec)
        spec = spec / np.maximum(mag, 1e-12)
    circ = np.fft.irfft(spec, fft_n)
    # circ[k] is lag +k; circ[-k] is lag -k (same layout as correlate full
    # after shifting so lag 0 sits at index max_lag_samples).
    width = 2 * max_lag_samples + 1
    window = np.empty(width, dtype=np.float64)
    window[max_lag_samples] = circ[0]
    take = min(max_lag_samples, n - 1)
    if take:
        window[max_lag_samples + 1 : max_lag_samples + 1 + take] = circ[1 : 1 + take]
        window[max_lag_samples - take : max_lag_samples] = circ[-take:]
    if take < max_lag_samples:
        window[max_lag_samples + 1 + take :] = 0.0
        window[: max_lag_samples - take] = 0.0
    return window, max_lag_samples


GCC_PHAT_MIN_CONFIDENCE = 0.25
_SILENCE_STD = 1e-4


def gcc_phat_offset(
    ref: np.ndarray,
    sig: np.ndarray,
    sample_rate: int,
    *,
    max_lag_s: float,
) -> float:
    """Lag of ``sig`` relative to ``ref`` in seconds, clamped to ±``max_lag_s``.

    GCC-PHAT TDOA for two sensors of one wideband source. Isolated dry keepers
    (independent close-mics) are not that case. Returns 0.0 when the peak is
    not distinct so tests can treat noise as "no lag"; land uses
    ``gcc_phat_result`` / sample counts instead of this 0-on-indistinct helper.
    """
    offset, _confidence = gcc_phat_result(ref, sig, sample_rate, max_lag_s=max_lag_s)
    return 0.0 if offset is None else offset


def gcc_phat_result(
    ref: np.ndarray,
    sig: np.ndarray,
    sample_rate: int,
    *,
    max_lag_s: float,
) -> tuple[float | None, float]:
    """Return ``(offset_sec, confidence)`` for a shared-source TDOA peak.

    ``offset_sec`` is None when the peak is indistinct. Confidence is
    peak-to-sidelobe over ±``max_lag_s`` (default land docs: 0.25 over ±1 s at
    8 kHz). That is a weak test on uncorrelated speech; do not treat None as
    "clocks agree" on remote dry keepers.
    """
    if sample_rate <= 0 or max_lag_s <= 0:
        return None, 0.0
    n = min(len(ref), len(sig))
    if n < 8:
        return None, 0.0
    ref_w = np.asarray(ref[:n], dtype=np.float64)
    sig_w = np.asarray(sig[:n], dtype=np.float64)
    if float(np.std(ref_w)) < _SILENCE_STD or float(np.std(sig_w)) < _SILENCE_STD:
        return None, 0.0
    ref_w = ref_w - np.mean(ref_w)
    sig_w = sig_w - np.mean(sig_w)
    max_lag_samples = min(n - 1, max(1, int(max_lag_s * sample_rate)))
    corr, center = _xcorr_lag_window(ref_w, sig_w, max_lag_samples, phat=True)
    peak_idx = int(np.argmax(np.abs(corr)))
    peak = float(np.abs(corr[peak_idx]))
    if peak <= 0:
        return None, 0.0
    # Exclude samples next to the peak so a one-bin-wide PHAT spike is distinct.
    half = 2
    rest = np.concatenate(
        [np.abs(corr[: max(0, peak_idx - half)]), np.abs(corr[peak_idx + half + 1 :])]
    )
    sidelobe = float(np.max(rest)) if rest.size else 0.0
    confidence = (peak - sidelobe) / peak
    if confidence < GCC_PHAT_MIN_CONFIDENCE:
        return None, confidence
    # Same xcorr layout as estimate_offset_from_arrays: negate so a delayed
    # ``sig`` (zeros then ref) yields a positive lag.
    lag_samples = center - peak_idx
    lag_samples = max(-max_lag_samples, min(max_lag_samples, lag_samples))
    return lag_samples / float(sample_rate), confidence


def read_wav_mono_window(
    path: Path,
    *,
    start_sec: float = 0.0,
    duration_sec: float,
    out_rate: int,
) -> tuple[np.ndarray, int]:
    """Read a bounded PCM window via ``wave`` (never the whole file).

    Returns ``(float64 mono samples at out_rate, PCM bytes read)``. Keepers are
    16-bit PCM. Unsupported widths (including 24-bit packed) yield empty.
    """
    import wave

    start_sec = max(0.0, start_sec)
    duration_sec = max(0.0, duration_sec)
    if duration_sec <= 0 or out_rate <= 0:
        return np.zeros(0, dtype=np.float64), 0
    try:
        with path.open("rb") as fh, wave.open(fh, "rb") as wf:
            in_rate = int(wf.getframerate() or 0)
            channels = max(1, int(wf.getnchannels() or 1))
            width = int(wf.getsampwidth() or 2)
            nframes = int(wf.getnframes() or 0)
            comptype = str(wf.getcomptype() or "NONE")
            if (
                in_rate <= 0
                or nframes <= 0
                or in_rate > _MAX_WAV_RATE
                or channels > _MAX_WAV_CHANNELS
                or width not in (1, 2, 4)
                or comptype != "NONE"
            ):
                return np.zeros(0, dtype=np.float64), 0
            start = min(nframes, round(start_sec * in_rate))
            count = min(nframes - start, round(duration_sec * in_rate))
            frame_bytes = channels * width
            if frame_bytes <= 0 or count <= 0:
                return np.zeros(0, dtype=np.float64), 0
            count = min(count, _MAX_WAV_WINDOW_BYTES // frame_bytes)
            if count <= 0:
                return np.zeros(0, dtype=np.float64), 0
            wf.setpos(start)
            raw = wf.readframes(count)
    except (OSError, wave.Error):
        return np.zeros(0, dtype=np.float64), 0
    bytes_read = len(raw)
    if width == 2:
        pcm = np.frombuffer(raw, dtype="<i2")
    elif width == 1:
        pcm = np.frombuffer(raw, dtype=np.uint8).astype(np.int16) - 128
    elif width == 4:
        pcm = np.frombuffer(raw, dtype="<i4")
    else:
        return np.zeros(0, dtype=np.float64), 0
    if channels > 1:
        usable = (pcm.size // channels) * channels
        pcm = pcm[:usable].reshape(-1, channels).mean(axis=1)
    samples = pcm.astype(np.float64) / (32768.0 if width != 1 else 128.0)
    if in_rate != out_rate and samples.size:
        n_out = max(1, round(samples.size * out_rate / in_rate))
        x = np.linspace(0.0, 1.0, samples.size, endpoint=False)
        xi = np.linspace(0.0, 1.0, n_out, endpoint=False)
        samples = np.interp(xi, x, samples)
    return samples, bytes_read


def load_mono_window(
    path: Path,
    *,
    start_sec: float = 0.0,
    duration_sec: float = 60.0,
    sample_rate: int = 8000,
    ffmpeg: str | None = None,
) -> np.ndarray:
    """Decode a short mono PCM window for correlation (audio only, no DAW metadata).

    16-bit (and 8/32-bit integer) WAV uses ``read_wav_mono_window``; other
    containers fall through to ffmpeg ``-ss``/``-t``.
    """
    try:
        samples, _n = read_wav_mono_window(
            path,
            start_sec=start_sec,
            duration_sec=duration_sec,
            out_rate=sample_rate,
        )
    except (OSError, ValueError):
        samples = np.zeros(0, dtype=np.float64)
    if samples.size:
        return np.asarray(samples, dtype=np.float32)
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-v",
        "error",
        "-ss",
        str(max(0.0, start_sec)),
        "-i",
        str(path),
        "-t",
        str(max(0.1, duration_sec)),
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    r = run(cmd, capture_output=True, check=True)
    samples = np.frombuffer(r.stdout, dtype=np.float32)
    if samples.size == 0:
        raise AudioWindowUnavailableError(f"no audio decoded from {path}")
    return samples


def estimate_offset_from_arrays(
    ref: np.ndarray,
    src: np.ndarray,
    *,
    max_lag_sec: float,
    sample_rate: int,
    reference: Path,
    source: Path,
) -> AlignmentResult:
    n = min(len(ref), len(src))
    if n < sample_rate:
        raise AudioWindowUnavailableError("analysis window too short for correlation")
    ref = ref[:n] - np.mean(ref[:n])
    src = src[:n] - np.mean(src[:n])
    ref_std = float(np.std(ref)) or 1.0
    src_std = float(np.std(src)) or 1.0
    ref = ref / ref_std
    src = src / src_std

    max_lag_samples = int(max_lag_sec * sample_rate)
    corr_window, center_idx = _xcorr_lag_window(ref, src, max_lag_samples)
    peak_idx = int(np.argmax(corr_window))
    lag_samples = peak_idx - center_idx
    offset_sec = -lag_samples / sample_rate
    peak = float(corr_window[peak_idx]) / n

    return AlignmentResult(
        reference=reference,
        source=source,
        offset_sec=offset_sec,
        correlation_peak=peak,
    )


def estimate_offset_sec(
    reference: Path,
    source: Path,
    *,
    max_lag_sec: float = 180.0,
    analysis_start_sec: float = 60.0,
    reference_start_sec: float | None = None,
    source_start_sec: float | None = None,
    analysis_duration_sec: float = 90.0,
    sample_rate: int = 8000,
) -> AlignmentResult:
    """
    Estimate how many seconds to delay ``source`` so it aligns with ``reference``.

    Positive offset means ``source`` content starts later than ``reference``; apply that delay
    to ``source`` when mixing (FFmpeg ``adelay``).
    """
    ref_start = reference_start_sec if reference_start_sec is not None else analysis_start_sec
    src_start = source_start_sec if source_start_sec is not None else analysis_start_sec
    ref = load_mono_window(
        reference,
        start_sec=ref_start,
        duration_sec=analysis_duration_sec,
        sample_rate=sample_rate,
    )
    src = load_mono_window(
        source,
        start_sec=src_start,
        duration_sec=analysis_duration_sec,
        sample_rate=sample_rate,
    )
    return estimate_offset_from_arrays(
        ref,
        src,
        max_lag_sec=max_lag_sec,
        sample_rate=sample_rate,
        reference=reference,
        source=source,
    )


def cross_speaker_offsets(
    speaker_paths: list[tuple[str, list[Path]]],
    *,
    analysis_start_sec: float,
    analysis_duration_sec: float = 60.0,
    max_lag_sec: float = 180.0,
    min_correlation_peak: float = 0.05,
    session_starts_in_file: dict[str, float] | None = None,
) -> dict[str, AlignmentResult]:
    """
    Align each speaker's first source file to the first listed speaker's reference
    (callers order the list so the session reference speaker comes first).

    Returns per-speaker AlignmentResult; subtract offset_sec from extract when trimming.
    """
    if not speaker_paths:
        return {}
    ref_name, ref_paths = speaker_paths[0]
    if not ref_paths:
        return {}
    reference = ref_paths[0]
    starts = session_starts_in_file or {}
    ref_file_start = starts.get(ref_name, 0.0) + analysis_start_sec
    out: dict[str, AlignmentResult] = {
        ref_name: AlignmentResult(
            reference=reference,
            source=reference,
            offset_sec=0.0,
            correlation_peak=1.0,
        )
    }
    for name, paths in speaker_paths[1:]:
        if not paths:
            continue
        src_file_start = starts.get(name, 0.0) + analysis_start_sec
        try:
            result = estimate_offset_sec(
                reference,
                paths[0],
                reference_start_sec=ref_file_start,
                source_start_sec=src_file_start,
                analysis_duration_sec=analysis_duration_sec,
                max_lag_sec=max_lag_sec,
            )
        except AudioWindowUnavailableError as exc:
            # Analysis window past EOF (short recording): no usable correlation.
            log.info("cross-speaker correlation skipped for %s: %s", name, exc)
            result = AlignmentResult(
                reference=reference,
                source=paths[0],
                offset_sec=0.0,
                correlation_peak=0.0,
            )
        if result.correlation_peak < min_correlation_peak:
            out[name] = AlignmentResult(
                reference=reference,
                source=paths[0],
                offset_sec=0.0,
                correlation_peak=result.correlation_peak,
            )
        else:
            out[name] = result
    return out
