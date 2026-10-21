"""Small shared numpy DSP primitives (level, pitch-lag autocorrelation, runs).

Callers keep their own thresholds and policy; these helpers only measure, so
level floors and pitch ranges cannot silently drift between private copies.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from podcast_mcp.util.batch_scope import in_scope, scoped

# What a frame of zeros reads: the one absolute level a detector may compare with, since
# it is the same at any recording gain (docs/audio-engineering.md § Detection levels).
DIGITAL_SILENCE_DB = -200.0
# Below this linear RMS a frame is treated as digital silence.
DIGITAL_SILENCE_RMS = 10 ** (DIGITAL_SILENCE_DB / 20)


def clamp01(value: float) -> float:
    """Clamp a scalar to the unit interval."""
    return float(max(0.0, min(1.0, value)))


def clamp(value: float, lo: float | None = None, hi: float | None = None) -> float:
    """Clamp ``value`` to ``[lo, hi]``; a ``None`` bound is open and ``lo`` wins if ``hi < lo``."""
    if hi is not None:
        value = min(value, hi)
    if lo is not None:
        value = max(value, lo)
    return value


def linear_rms(samples: np.ndarray, *, epsilon: float = 0.0) -> float:
    """Linear RMS with caller-selected squared-amplitude floor."""
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)) + epsilon))


def rms_db(samples: np.ndarray, *, floor_db: float = DIGITAL_SILENCE_DB) -> float:
    """RMS level in dBFS; empty or digitally silent input returns ``floor_db``."""
    if samples.size == 0:
        return floor_db
    rms = linear_rms(samples)
    if rms < DIGITAL_SILENCE_RMS:
        return floor_db
    return 20.0 * math.log10(rms)


def db_to_amplitude(db: float) -> float:
    """Linear amplitude factor for a level in dB (0 dB -> 1.0, -6 dB -> ~0.501)."""
    return float(10.0 ** (db / 20.0))


def frame_rms_db(
    samples: np.ndarray,
    frame: int,
    hop: int,
    *,
    max_frames: int | None = None,
    floor_db: float = DIGITAL_SILENCE_DB,
) -> np.ndarray:
    """Vectorized per-frame RMS dB for overlapping ``frame``-sample windows every ``hop``."""
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    if max_frames is not None:
        windows = windows[:max_frames]
    rms = np.sqrt(np.mean(np.square(windows, dtype=np.float64), axis=1))
    out = np.full(rms.shape, floor_db, dtype=np.float64)
    loud = rms >= DIGITAL_SILENCE_RMS
    out[loud] = 20.0 * np.log10(rms[loud])
    return out


class BandShape(Protocol):
    """The gain a zero-phase band applies, and how much white noise it passes."""

    def gain(self, freqs: np.ndarray) -> np.ndarray:
        """Amplitude gain at ``freqs`` (Hz)."""
        ...

    def noise_bandwidth(self, sample_rate: int) -> float:
        """The width (Hz) of a flat band that passes as much white noise."""
        ...


@dataclass(frozen=True)
class HighPassBand:
    """A raised-cosine high-pass: stopped at ``low_stop`` Hz, passed from ``low_pass``.

    The edge is a half cosine, so a tone on the ramp reads ``(1 - cos(pi * x)) / 2`` of its
    amplitude, ``x`` the share of the ramp it is across.
    """

    low_stop: float
    low_pass: float

    def gain(self, freqs: np.ndarray) -> np.ndarray:
        rise = np.clip((freqs - self.low_stop) / (self.low_pass - self.low_stop), 0.0, 1.0)
        return (1.0 - np.cos(np.pi * rise)) / 2.0

    def noise_bandwidth(self, sample_rate: int) -> float:
        # A half-cosine ramp passes 3/8 of its width.
        return (self.low_pass - self.low_stop) * 3.0 / 8.0 + (sample_rate / 2.0 - self.low_pass)


@dataclass(frozen=True)
class GaussianBand:
    """A band whose gain is a Gaussian of frequency: ``exp(-(f - center)^2 / (2 sigma^2))``.

    A narrow band rings for as long as its edges are sharp: a raised-cosine one from 80 to
    160 Hz read as sound for 140 ms past a loud word that had stopped. A Gaussian has no
    sidelobes, its impulse response a Gaussian envelope a few ``1 / (2 pi sigma)`` seconds
    long, and the same band read 50 ms.
    """

    center: float
    sigma: float

    def gain(self, freqs: np.ndarray) -> np.ndarray:
        return np.exp(-((freqs - self.center) ** 2) / (2.0 * self.sigma**2))

    def noise_bandwidth(self, sample_rate: int) -> float:
        return self.sigma * math.sqrt(math.pi)


# The speech band: a raised-cosine high-pass, stopped at 100 Hz and passed from 160 Hz.
# Room rumble reaches past 100 Hz, and what a band passes of it is room the levels read
# (a 25-110 Hz rumble put the room 7 dB high through a band from 120 Hz, swinging, and a
# breath 12 dB over the true room stayed under the line). A breath sits at 300 Hz to
# 3.5 kHz; a voice keeps its harmonics; only a sound carried by content under 160 Hz alone
# reads lower (130 Hz by 6 dB, 120 Hz by 12).
SPEECH_BAND = HighPassBand(low_stop=100.0, low_pass=160.0)
# The low band reads what the speech band cannot: a tonal tail or a beat at 100 to 160 Hz
# (a room mode ringing after a word, two hums beating) that is audible after the render's
# 80 Hz high-pass at conversation level. A Gaussian around 120 Hz, 30 Hz wide: 2 dB down at
# 100 and 140 Hz, 8 dB at 80 and 160, 17 at 60. It only adds sounds; its room, line and
# ceiling are its own (``edits/room_model.py``).
LOW_BAND = GaussianBand(center=120.0, sigma=30.0)


def next_fast_len(n: int) -> int:
    """The smallest length ``>= n`` whose only prime factors are 2, 3 and 5.

    The FFT is fast at such a length and slow at a prime one (a pause plus 10 s is any
    sample count at all), so callers pad to it.
    """
    best = 1 << max(0, n - 1).bit_length()
    five = 1
    while five < best:
        smooth = five
        while smooth < best:
            length = smooth
            while length < n:
                length *= 2
            best = min(best, length)
            smooth *= 3
        five *= 5
    return best


def band_filter(samples: np.ndarray, sample_rate: int, band: BandShape) -> np.ndarray:
    """``samples`` through ``band``: zero-phase, applied over the whole array.

    A noise gate's digital silence stays digital silence: the filter's ringing is not let
    into the gate's zeros.
    """
    if samples.size < 64:
        return samples
    size = next_fast_len(samples.size)
    spectrum = np.fft.rfft(samples, n=size)
    spectrum *= band.gain(np.fft.rfftfreq(size, d=1.0 / sample_rate))
    filtered = np.fft.irfft(spectrum, n=size)[: samples.size]
    return np.where(samples != 0.0, filtered, 0.0).astype(samples.dtype, copy=False)


def frame_band_filtered_db(
    samples: np.ndarray,
    sample_rate: int,
    frame: int,
    band: BandShape,
    *,
    floor_db: float = DIGITAL_SILENCE_DB,
) -> np.ndarray:
    """Per-frame dB level of ``samples`` through ``band``, on :func:`frame_rms_db`'s grid.

    Room rumble, desk thumps and the mains fundamental sit below the speech band and can be
    10 dB over a room tone's broadband air, hiding every breath and fade that rides on
    them. Of mains hum's harmonics, 100 Hz is removed, 120 Hz is 12 dB down and 150 Hz
    passes (0.6 dB down), so what is left of a hum shows in the levels as the room's own.
    A frame reads no louder than it does unfiltered: the filter spreads a loud
    neighbour's energy a few frames each way, and that ringing is no sound of the frame's
    own.
    """
    full = frame_rms_db(samples, frame, frame, floor_db=floor_db)
    heard = frame_rms_db(band_filter(samples, sample_rate, band), frame, frame, floor_db=floor_db)
    return np.minimum(full, heard)


def frame_level_noise_db(band: BandShape, sample_rate: int, frame_sec: float) -> float:
    """The std, in dB, of one frame's level over stationary Gaussian noise in ``band``.

    A frame of band-limited noise estimates its power from ``2 * bandwidth * frame_sec``
    independent samples, so even a perfectly steady room reads a few tenths of a dB
    apart from frame to frame (about 2 dB in the narrow low band). No room is steadier
    than this, which makes it the least spread a measured room can have.
    """
    return (10.0 / math.log(10.0)) / math.sqrt(band.noise_bandwidth(sample_rate) * frame_sec)


def frame_band_db(
    samples: np.ndarray,
    sample_rate: int,
    frame: int,
    hop: int,
    *,
    lo_hz: float,
    floor_db: float = DIGITAL_SILENCE_DB,
) -> np.ndarray:
    """Per-frame dB level of the signal's content at or above ``lo_hz``.

    Same frame grid as :func:`frame_rms_db`; a frame of full-band white noise reads
    about its RMS level plus ``10 * log10(1 - 2 * lo_hz / sample_rate)``.
    """
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    window = np.hanning(frame)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop] * window
    power = np.abs(np.fft.rfft(windows, axis=1)) ** 2
    band = np.fft.rfftfreq(frame, d=1.0 / sample_rate) >= lo_hz
    mean_square = 2.0 * np.sum(power[:, band], axis=1) / (frame * float(np.sum(window**2)))
    out = np.full(mean_square.shape, floor_db, dtype=np.float64)
    loud = mean_square >= DIGITAL_SILENCE_RMS**2
    out[loud] = 10.0 * np.log10(mean_square[loud])
    return out


def frame_peak_db(
    samples: np.ndarray, frame: int, hop: int, *, floor_db: float = DIGITAL_SILENCE_DB
) -> np.ndarray:
    """Per-frame sample peak in dB on the :func:`frame_rms_db` frame grid."""
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    peak = np.abs(windows).max(axis=1).astype(np.float64)
    out = np.full(peak.shape, floor_db, dtype=np.float64)
    loud = peak >= DIGITAL_SILENCE_RMS
    out[loud] = 20.0 * np.log10(peak[loud])
    return out


def frame_db_stream(
    chunks: Iterable[np.ndarray],
    frame: int,
    hop: int,
    reducers: Sequence[Callable[[np.ndarray, int, int], np.ndarray]],
) -> tuple[np.ndarray, ...]:
    """Per-frame reductions (:func:`frame_rms_db`, :func:`frame_peak_db`) over a chunk stream.

    Same frames and values as on the concatenated samples, holding one chunk plus
    fewer than ``frame`` carried samples, in one pass for every reducer. The carry-buffer
    loop has the same shape as ``engines.asr_silence.peak_envelope`` and
    ``engines.waveform_pyramid.build_levels``; those reduce whole blocks or bins, not
    overlapping frames, so they stay separate. A new overlapping-frame reduction is a
    reducer here, not another loop.
    """
    if frame <= 0 or hop <= 0:
        return tuple(np.empty(0, dtype=np.float64) for _ in reducers)
    parts: list[list[np.ndarray]] = [[] for _ in reducers]
    carry = np.zeros(0, dtype=np.float32)
    for chunk in chunks:
        buf = np.concatenate([carry, np.asarray(chunk).reshape(-1)])
        levels = [reduce(buf, frame, hop) for reduce in reducers]
        for part, level in zip(parts, levels, strict=True):
            if level.size:
                part.append(level)
        carry = buf[levels[0].size * hop :] if levels else buf
    return tuple(np.concatenate(part) if part else np.empty(0, dtype=np.float64) for part in parts)


def frame_rms_db_stream(
    chunks: Iterable[np.ndarray], frame: int, hop: int, *, floor_db: float = DIGITAL_SILENCE_DB
) -> np.ndarray:
    """:func:`frame_rms_db` over a forward-only chunk stream (see :func:`frame_db_stream`)."""
    return frame_db_stream(
        chunks, frame, hop, (lambda buf, f, h: frame_rms_db(buf, f, h, floor_db=floor_db),)
    )[0]


def autocorr_peak(
    samples: np.ndarray,
    sample_rate: int,
    *,
    fmin: float,
    fmax: float,
    interior: bool = False,
) -> tuple[float, float] | None:
    """:func:`_autocorr_peak`, answered once per distinct frame while a batch scope is open.

    Each cut of a batch re-reads the same audio, and the autocorrelation is the costliest
    step of the voicing test. The answer depends on the frame's samples alone, so the
    frame's digest (not its position) is the key: the same audio read at another time, or
    after an earlier cut moved it, is the same answer.
    """
    if not in_scope():
        return _autocorr_peak(samples, sample_rate, fmin=fmin, fmax=fmax, interior=interior)
    digest = hashlib.blake2b(
        np.ascontiguousarray(samples).tobytes(), digest_size=16, person=samples.dtype.str.encode()
    ).digest()
    return scoped(
        ("autocorr_peak", sample_rate, fmin, fmax, interior, samples.shape, digest),
        lambda: _autocorr_peak(samples, sample_rate, fmin=fmin, fmax=fmax, interior=interior),
    )


def _autocorr_peak(
    samples: np.ndarray,
    sample_rate: int,
    *,
    fmin: float,
    fmax: float,
    interior: bool = False,
) -> tuple[float, float] | None:
    """Strongest normalized autocorrelation peak over pitch lags ``[sr/fmax, sr/fmin)``.

    Returns ``(f0_hz, normalized_peak)`` where the peak is divided by the
    zero-lag energy of the mean-removed frame, or ``None`` when the frame has no
    energy or is too short to cover the lag range (lags are capped at half the
    frame so the estimate always has at least two periods of support).

    ``interior`` counts only lags where the correlation is a local maximum. Low-frequency
    noise has an autocorrelation that only falls, so its strongest value sits on the
    shortest lag and reads as a high-pitched voice; a periodic signal has a true peak.
    ``None`` when no lag is one.
    """
    x = samples.astype(np.float64, copy=True)
    x -= np.mean(x) if x.size else 0.0
    energy = float(np.dot(x, x))
    if energy <= 1e-12:
        return None
    min_lag = max(1, int(sample_rate / fmax))
    max_lag = min(int(sample_rate / fmin), x.size // 2)
    if max_lag <= min_lag + 2:
        return None
    corr = np.correlate(x, x, mode="full")[x.size - 1 :]
    seg = corr[min_lag:max_lag]
    if interior:
        around = corr[min_lag - 1 : max_lag + 1]
        seg = np.where((seg > around[:-2]) & (seg >= around[2:]), seg, -np.inf)
        if not np.isfinite(seg).any():
            return None
    lag = int(np.argmax(seg)) + min_lag
    return float(sample_rate) / float(lag), float(corr[lag]) / energy


def voicing_probes(
    samples: np.ndarray,
    sample_rate: int,
    *,
    probe_sec: float,
    hop_sec: float,
    fmin: float,
    fmax: float,
    interior: bool = False,
) -> np.ndarray:
    """Normalized speech-pitch autocorrelation peak of each ``probe_sec`` frame every ``hop_sec``.

    A frame :func:`autocorr_peak` cannot score (silent, too short for the lag range, or
    with ``interior`` no true peak) scores 0.0. Input shorter than one probe is scored as
    a single frame; empty input yields an empty array.
    """
    if samples.size == 0:
        return np.empty(0, dtype=np.float64)
    frame = min(samples.size, max(1, round(sample_rate * probe_sec)))
    hop = max(1, round(sample_rate * hop_sec))
    scores = []
    for start in range(0, samples.size - frame + 1, hop):
        peak = autocorr_peak(
            samples[start : start + frame], sample_rate, fmin=fmin, fmax=fmax, interior=interior
        )
        scores.append(peak[1] if peak is not None else 0.0)
    return np.asarray(scores, dtype=np.float64)


def high_band_energy_fraction(
    samples: np.ndarray,
    sample_rate: int,
    *,
    split_hz: float,
    lo_hz: float,
    hi_hz: float,
) -> float:
    """Share of the ``[lo_hz, hi_hz]`` spectral energy that lies at or above ``split_hz``.

    One Hann-windowed spectrum over the whole input; silent or too-short input
    scores 0.0.
    """
    if samples.size < 2:
        return 0.0
    x = samples.astype(np.float64, copy=True)
    x -= np.mean(x)
    power = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    freqs = np.fft.rfftfreq(x.size, d=1.0 / sample_rate)
    band = (freqs >= lo_hz) & (freqs <= hi_hz)
    total = float(np.sum(power[band]))
    if total <= 1e-20:
        return 0.0
    return float(np.sum(power[band & (freqs >= split_hz)]) / total)


def bool_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Half-open ``(start, end)`` index spans of contiguous ``True`` values."""
    flags = np.asarray(mask, dtype=bool)
    if flags.size == 0:
        return []
    edges = np.diff(np.concatenate(([False], flags, [False])).astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [(int(s), int(e)) for s, e in zip(starts, ends, strict=True)]


def bridge_short_dips(mask: np.ndarray, max_dip: int) -> np.ndarray:
    """Copy of ``mask`` with interior ``False`` runs of at most ``max_dip`` filled."""
    out = np.asarray(mask, dtype=bool).copy()
    if max_dip <= 0:
        return out
    for start, end in bool_runs(~out):
        if start > 0 and end < out.size and end - start <= max_dip:
            out[start:end] = True
    return out


def valley_depth_db(levels: np.ndarray, k: int) -> float:
    """How far the level climbs out of frame ``k`` on its shallower side.

    Walking out either way, the level climbs to some peak before it falls under frame
    ``k``; the shallower of the two peaks over frame ``k`` is the depth of the dip it
    bottoms. A ripple on the slope down into a deeper dip is no valley, so it gets only
    the height it climbs before the deeper dip (lab 705.98: -40 dBFS on the way down
    from the ``ss`` to the -43 dBFS dip). The first or last frame has no side to
    climb on: depth 0.
    """
    bottom = levels[k]
    depth = math.inf
    for side in (levels[k - 1 :: -1] if k > 0 else levels[:0], levels[k + 1 :]):
        under = side < bottom
        reach = int(np.argmax(under)) if under.any() else side.size
        depth = min(depth, float(side[:reach].max() - bottom) if reach else 0.0)
    return depth


def is_valley(levels: np.ndarray, k: int, depth_db: float) -> bool:
    """Whether frame ``k`` is the bottom of a dip ``depth_db`` deep on both sides."""
    return valley_depth_db(levels, k) >= depth_db


def valley_basins(levels: np.ndarray, depth_db: float) -> np.ndarray:
    """Frames inside a valley ``depth_db`` deep: its bottom and the frames around it that
    sit in its lower half.

    A valley is the stretch between two sounds, not one frame: the frames on its flanks
    are as far from either sound as from the bottom. Half its own depth is measured
    from the dip itself, so the basin is the same at every recording level.
    """
    basin = np.zeros(levels.size, dtype=bool)
    for k in range(levels.size):
        depth = valley_depth_db(levels, k)
        if depth < depth_db:
            continue
        midline = levels[k] + depth / 2
        lo = hi = k
        while lo > 0 and levels[lo - 1] <= midline:
            lo -= 1
        while hi + 1 < levels.size and levels[hi + 1] <= midline:
            hi += 1
        basin[lo : hi + 1] = True
    return basin
