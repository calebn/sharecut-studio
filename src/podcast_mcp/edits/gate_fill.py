"""Room tone under a track's source-gate holes, so it never drops to dead air (#1111).

A recorder's noise gate (Zoom records each participant through one) leaves a track at
digital silence between words: the mix falls to dead air where every track is gated, and
a voice seems to cut in and out where one gate dips mid-phrase. The pipeline's
``fill_gate_holes`` step writes, per dialogue track, a fill on the media's clock (the fill
inside each hole, digital silence everywhere else), and render sums it under the media.

**Holes** are read from the media itself. A hole is a run of samples too quiet for a
16-bit sample on every channel (``SILENT_AMPLITUDE``), at least ``MIN_HOLE_SEC`` long,
holding an exact zero, with live audio on both sides. No microphone and converter hold
exact zero for 20 ms; a gate does, and a lossy codec leaves sub-LSB residue at its edges,
which the run takes in. Silence before the first sound or after the last (a late joiner,
padding) is not a gate closing between words and stays. Our own mutes, cuts and pads are
not in the media, so they are never holes, and render applies them to the fill as it
does to the media.

**Fill sources**, tried in order (``FILL_SOURCES``): the track's recorded room-tone bed,
then comfort noise matched to the track's own noise under its speech. No source reads
another track: bleed is never the main audio (#945).

**Comfort noise** follows telephony comfort-noise generation: estimate the noise the track
carries under its own speech, then synthesise noise with that power spectrum. The estimate
is read from, in order:

1. **The gate's hold**: what the gate holds open before closing, after the voice fell
   below its threshold (the *hangover* a telephony encoder sends its SID frames from). It
   is measured per track (``_measure_hold``) on the median level of each ``BLOCK_SEC``
   going back from the closures: the longest *steady run* there (within ``FLAT_DB`` of its
   quietest block, rising slower than ``MAX_RISE_DB_PER_SEC``, at least ``MIN_HOLD_SEC``)
   with the voice back at least ``SPEECH_ABOVE_NOISE_DB`` over it further back. Blocks
   between it and the closure are the gate's release (a ramp, or a codec's quieter last
   frame): all under the run, and no longer than it. A voice's reverberant tail decays
   faster than the rise bound, so a gate that closes on a tail with no hold has no steady
   run.
2. **The track's own room**, when no hold is measured: the quiet runs the room-tone
   sampler finds in its pauses (``edits/room_tone.py``, #1054), once they add up to
   ``MIN_ROOM_SEC``. A gate that stays open through whole pauses has them, and when it
   closes further than ``MAX_HOLD_SEC`` from the voice no hold is measured.

**DC is never room.** A decoder can leave the open gate's audio off zero (Zoom's sits about
8 LSB under it) while the closed gate is exact zero, and the offset drifts as the gate
releases. Every frame and block is measured with its own mean removed, and the fill
carries nothing under ``MIN_FILL_HZ``.

**Digital residue is never room.** A closed gate rounds a near-zero signal to ±1 LSB before
its exact zero, and a gate can dip to that residue while open. Samples within
``RESIDUE_LSB`` steps of the media's quantization (its smallest nonzero sample,
``GateHoles.lsb``) are residue: each closure starts at the last sample above it, and a frame
or block of nothing but residue is skipped.

Both read periodograms (frames of about 20 ms, or one shorter frame per hold) of every
channel, since the fill is written to each channel at the level it measures: a mono
downmix of identical channels reads 3 dB over either. They keep those within
``NOISE_SPREAD_DB`` of the median (a word, a breath or a peer's bleed that a hold or a pause
still carries sits over it; a steady floor sits within it) and average them per frequency
bin. The fill must sit ``MIN_BELOW_SPEECH_DB`` under the track's own speech level, as room
tone must; otherwise it is not a floor and the holes stay silent. Estimators measured
against these and dropped are in [audio-engineering.md § Gate fill].

The noise is synthesised once as a seamless loop (random phases over the spectrum, one
inverse FFT), and each hole reads the loop at its own position on the media's clock, so no
two holes start on the same noise.

**Crossfades.** The fill fades in over the first ``fade_ms`` of each hole and out over its
last, inside the hole, so the gate's edges and the speech they carry keep every sample.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections.abc import Callable, Iterator
from contextlib import closing
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.edits.room_tone import (
    MIN_BELOW_SPEECH_DB,
    BedUnavailable,
    LiveFloor,
    TrackFloor,
    room_tone_bed,
    track_floor,
)
from podcast_mcp.models import EpisodeProject, GateFill, GateFillSource, Track, TrackRole
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.dsp import rms_db
from podcast_mcp.util.pcm_stream import SequentialWindowReader
from podcast_mcp.util.progress import resolve_progress_task
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.workspace_paths import resolve_under_workspace

log = logging.getLogger(__name__)

# Below half a 16-bit step: a 16-bit recording rounds it to zero.
SILENT_AMPLITUDE = 2.0**-16
MIN_HOLE_SEC = 0.02
# Analysis frames of about 20 ms (a power of two), hopped by half.
FRAME_SEC = 0.02
# A hold never reaches back within EDGE_SEC of the gate opening, its own ramp.
EDGE_SEC = 0.01
# Samples within this many quantization steps of zero are a gate's rounding residue.
RESIDUE_LSB = 2.0
# A track's pauses are its room once its quiet runs add up to this.
MIN_ROOM_SEC = 1.0
# The hold is read from the median level of each BLOCK_SEC going back from the closures, up
# to MAX_HOLD_SEC; a block's median needs MIN_CLOSURES closures that reach it. A steady run
# stays within FLAT_DB of its quietest block and rises slower than MAX_RISE_DB_PER_SEC (a
# tail decays 60 dB per RT60, so in a room under 1.5 s it rises faster), over at least
# MIN_HOLD_SEC: fewer blocks give no slope to judge.
BLOCK_SEC = 0.005
MAX_HOLD_SEC = 0.5
FLAT_DB = 3.0
MAX_RISE_DB_PER_SEC = 40.0
MIN_HOLD_SEC = 0.015
MIN_CLOSURES = 8
# Frames read per window, so a long quiet run is never held whole.
READ_FRAMES = 512
# A hold's voice sits at least this far over it, further back from the closure.
SPEECH_ABOVE_NOISE_DB = 10.0
# Periodograms more than this over the median carry a word, a breath or bleed: a steady
# floor keeps nearly every frame within it.
NOISE_SPREAD_DB = 3.0
# The fill carries nothing under this: a decoder's DC offset and its drift are not room.
MIN_FILL_HZ = 20.0
LOOP_SEC = 20.0
WRITE_CHUNK = 1 << 16
GATE_FILL_DIR = "artifacts/gate_fill"
MODES = ("auto", "off")

Span = tuple[float, float]


@dataclass(frozen=True)
class GateHoles:
    """A media file's source-gate holes, as half-open sample ranges."""

    sample_rate: int
    channels: int
    frames: int
    # First and last+1 live sample: the silence outside them is never a hole.
    live: tuple[int, int]
    bounds: tuple[tuple[int, int], ...]
    # The smallest nonzero sample magnitude: one step of the media's quantization.
    lsb: float

    @property
    def spans(self) -> tuple[Span, ...]:
        return tuple((a / self.sample_rate, b / self.sample_rate) for a, b in self.bounds)

    @property
    def seconds(self) -> float:
        return sum(b - a for a, b in self.bounds) / self.sample_rate


@dataclass(frozen=True)
class FillLoop:
    """Mono fill audio at the track's rate, read at ``index % len`` on the media's clock."""

    samples: np.ndarray
    level_db: float
    noise_db: float | None
    # How the noise was read ("from 31.2 s of its own room"); None for a recorded bed.
    basis: str | None = None


FillSourceFn = Callable[[EpisodeProject, Track, Path, GateHoles], FillLoop | str]


def detect_gate_holes(path: Path) -> GateHoles:
    """The source-gate holes of the media at ``path`` (cached per file revision)."""
    resolved = path.resolve(strict=True)
    return _detect(resolved, file_revision(resolved))


@lru_cache(maxsize=8)
def _detect(path: Path, revision: FileRevision) -> GateHoles:
    del revision  # part of the cache key: a replaced file is read again
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    sr, channels, chunks = FFmpegEngine().stream_pcm_f32(path)
    min_len = max(1, round(MIN_HOLE_SEC * sr))
    bounds: list[tuple[int, int]] = []
    pos = 0
    # The media starts inside a silent run: one that ends before any live sample leads.
    in_run, run_start, run_zero = True, 0, False
    first_live: int | None = None
    last_live = 0
    lsb = math.inf
    with closing(chunks):
        for chunk in chunks:
            block = np.asarray(chunk).reshape(-1, channels)
            magnitude = np.abs(block[block != 0.0])
            lsb = min(lsb, float(magnitude.min())) if magnitude.size else lsb
            silent = np.all(np.abs(block) < SILENT_AMPLITUDE, axis=1)
            zeros = np.concatenate(([0], np.cumsum(np.all(block == 0.0, axis=1))))
            live = np.flatnonzero(~silent)
            if live.size:
                first_live = pos + int(live[0]) if first_live is None else first_live
                last_live = pos + int(live[-1]) + 1
            edges = np.diff(silent.astype(np.int8), prepend=np.int8(in_run))
            for i in (int(j) for j in np.flatnonzero(edges)):
                if edges[i] > 0:
                    in_run, run_start, run_zero = True, pos + i, False
                    continue
                run_zero = run_zero or zeros[i] > zeros[max(run_start - pos, 0)]
                interior = first_live is not None and first_live < run_start
                if interior and run_zero and pos + i - run_start >= min_len:
                    bounds.append((run_start, pos + i))
                in_run = False
            if in_run:
                run_zero = run_zero or zeros[-1] > zeros[max(run_start - pos, 0)]
            pos += block.shape[0]
    return GateHoles(
        sample_rate=sr,
        channels=channels,
        frames=pos,
        live=(first_live or 0, last_live),
        bounds=tuple(bounds),
        lsb=0.0 if math.isinf(lsb) else lsb,
    )


def _frame_len(sample_rate: int) -> int:
    return 1 << round(math.log2(FRAME_SEC * sample_rate))


def _open_stretches(holes: GateHoles) -> Iterator[tuple[int, int, bool]]:
    """``(start, end, closes)`` of live audio between holes; ``closes`` when a gate shuts at ``end``."""
    start, last = holes.live
    for a, b in holes.bounds:
        yield start, a, True
        start = b
    yield start, last, holes.frames - last >= round(MIN_HOLE_SEC * holes.sample_rate)


def _reader(path: Path, holes: GateHoles) -> SequentialWindowReader:
    """Forward-only reads of the media's interleaved samples at its own rate (``_window``)."""
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    _, channels, chunks = FFmpegEngine().stream_pcm_f32(path)
    return SequentialWindowReader(chunks, holes.sample_rate * channels)


def _window(reader: SequentialWindowReader, holes: GateHoles, start: int, end: int) -> np.ndarray:
    """Samples ``[start, end)`` as ``(frames, channels)``."""
    samples, _ = reader.window_samples(start * holes.channels, end * holes.channels)
    return samples.reshape(-1, holes.channels)


def _frames(samples: np.ndarray, length: int) -> np.ndarray:
    """``(n, length, channels)`` frames hopped by half, the last ending at ``samples``' end."""
    starts = np.arange(samples.shape[0] - length, -1, -max(1, length // 2))
    return samples[starts[:, None] + np.arange(length)]


def _periodograms(frames: np.ndarray, nfft: int) -> np.ndarray:
    """Hann periodograms (``|X|^2 / sum(w^2)``) of ``(n, length, channels)`` frames, each
    channel's DC removed, zero-padded to ``nfft`` and averaged over the channels."""
    window = np.hanning(frames.shape[1])[:, None]
    ac = frames - frames.mean(axis=1, keepdims=True)
    spectra = np.abs(np.fft.rfft(ac * window, n=nfft, axis=1)) ** 2
    return spectra.mean(axis=2) / float(np.sum(window**2))


def _noise_psd(rows: list[np.ndarray]) -> np.ndarray:
    """Mean of the periodograms within ``NOISE_SPREAD_DB`` of the median."""
    table = np.vstack(rows)
    power = table.sum(axis=1)
    return table[power <= np.median(power) * 10 ** (NOISE_SPREAD_DB / 10)].mean(axis=0)


@dataclass(frozen=True)
class _Noise:
    psd: np.ndarray
    nfft: int
    basis: str


def _room_noise(path: Path, holes: GateHoles, floor: TrackFloor) -> _Noise | None:
    """The mean spectrum of the quiet runs in the track's own pauses, when they add up to
    ``MIN_ROOM_SEC``; frames of nothing but residue are skipped."""
    sr = holes.sample_rate
    nfft = _frame_len(sr)
    hop = nfft // 2
    residue = RESIDUE_LSB * holes.lsb
    rows: list[np.ndarray] = []
    with closing(_reader(path, holes)) as reader:
        for a, b in ((round(a * sr), round(b * sr)) for a, b in floor.runs):
            count = 1 + (b - a - nfft) // hop if b - a >= nfft else 0
            for f0 in range(0, count, READ_FRAMES):
                f1 = min(count, f0 + READ_FRAMES)
                samples = _window(reader, holes, a + f0 * hop, a + (f1 - 1) * hop + nfft)
                if samples.shape[0] < nfft:
                    continue
                frames = _frames(samples, nfft)
                rows.extend(
                    _periodograms(frames[np.max(np.abs(frames), axis=(1, 2)) > residue], nfft)
                )
    if len(rows) * hop < MIN_ROOM_SEC * sr:
        return None
    return _Noise(_noise_psd(rows), nfft, f"from {len(rows) * hop / sr:.1f} s of its own room")


def _before_closures(path: Path, holes: GateHoles) -> Iterator[np.ndarray]:
    """The audio before each gate closure, up to ``MAX_HOLD_SEC``, ending at its last sample
    above the closed gate's residue."""
    sr = holes.sample_rate
    edge = round(EDGE_SEC * sr)
    residue = RESIDUE_LSB * holes.lsb
    with closing(_reader(path, holes)) as reader:
        for start, end, closes in _open_stretches(holes):
            a = max(start + edge, end - round(MAX_HOLD_SEC * sr))
            if not closes or a >= end:
                continue
            samples = _window(reader, holes, a, end)
            above = np.flatnonzero(np.max(np.abs(samples), axis=1) > residue)
            yield samples[: int(above[-1]) + 1] if above.size else samples[:0]


def _closure_profile(path: Path, holes: GateHoles) -> np.ndarray:
    """Median level (dBFS, each block's DC removed) of each block going back from the gate's
    closures, residue-only blocks left out; [0] ends at one. Stops at the first block fewer
    than ``MIN_CLOSURES`` closures reach."""
    block = round(BLOCK_SEC * holes.sample_rate)
    blocks = round(MAX_HOLD_SEC / BLOCK_SEC)
    residue = RESIDUE_LSB * holes.lsb
    rows: list[np.ndarray] = []
    for samples in _before_closures(path, holes):
        n = min(blocks, samples.shape[0] // block)
        tail = samples[samples.shape[0] - n * block :].reshape(n, block, -1)[::-1]
        power = np.mean(np.var(tail, axis=1, dtype=np.float64), axis=1)
        power[np.max(np.abs(tail), axis=(1, 2), initial=0.0) <= residue] = np.nan
        rows.append(np.pad(power, (0, blocks - n), constant_values=np.nan))
    if len(rows) < MIN_CLOSURES:
        return np.zeros(0)
    table = np.vstack(rows)
    short = np.flatnonzero(np.sum(~np.isnan(table), axis=0) < MIN_CLOSURES)
    reached = int(short[0]) if short.size else blocks
    return 10.0 * np.log10(np.maximum(np.nanmedian(table[:, :reached], axis=0), 1e-30))


def _steady_run(levels: np.ndarray) -> int:
    """Blocks from ``levels[0]`` within ``FLAT_DB`` of the quietest so far, cut to the longest
    stretch of at least ``MIN_HOLD_SEC`` whose least-squares rise is at most
    ``MAX_RISE_DB_PER_SEC``; 0 when none."""
    above = np.flatnonzero(levels > np.minimum.accumulate(levels) + FLAT_DB)
    n = int(above[0]) if above.size else levels.size
    m = np.arange(2, n + 1, dtype=np.float64)
    k = np.arange(n, dtype=np.float64)
    sy, sky = np.cumsum(levels[:n])[1:], np.cumsum(k * levels[:n])[1:]
    sk, skk = m * (m - 1) / 2, (m - 1) * m * (2 * m - 1) / 6
    rate = (m * sky - sk * sy) / (m * skk - sk**2) / BLOCK_SEC
    steady = np.flatnonzero((rate <= MAX_RISE_DB_PER_SEC) & (m * BLOCK_SEC >= MIN_HOLD_SEC - 1e-9))
    return int(steady[-1]) + 2 if steady.size else 0


def _measure_hold(profile_db: np.ndarray) -> tuple[int, int]:
    """``(release, hold)`` in blocks: the longest steady run, with the voice back above it,
    and the release between it and the closure under it and no longer. ``(0, 0)`` when no
    run qualifies."""
    best = (0, 0)
    for release in range(profile_db.size):
        run = _steady_run(profile_db[release:])
        steady = profile_db[release : release + run]
        if (
            run > best[1]
            and release <= run
            and profile_db[:release].max(initial=-np.inf) < steady.min()
            and profile_db[release + run :].max(initial=-np.inf)
            >= steady.max() + SPEECH_ABOVE_NOISE_DB
        ):
            best = (release, run)
    return best


def _hold_noise(path: Path, holes: GateHoles) -> _Noise | str:
    """The mean spectrum of the gate's measured hold before each closure (frames of about
    20 ms, or one shorter frame when the hold is shorter), or why there is none."""
    profile = _closure_profile(path, holes)
    if profile.size == 0:
        return "no noise measured under its speech"
    release, hold = _measure_hold(profile)
    if not hold:
        return "its gate holds no steady floor open before closing"
    block = round(BLOCK_SEC * holes.sample_rate)
    nfft = _frame_len(holes.sample_rate)
    a, b = (release + hold) * block, release * block
    rows = [
        _periodograms(_frames(s[s.shape[0] - a : s.shape[0] - b], min(nfft, a - b)), nfft).mean(
            axis=0
        )
        for s in _before_closures(path, holes)
        if s.shape[0] >= a
    ]
    if len(rows) < MIN_CLOSURES:
        return "no noise measured under its speech"
    return _Noise(
        _noise_psd(rows), nfft, f"over {len(rows)} gate holds of {1000 * hold * BLOCK_SEC:.0f} ms"
    )


def _comfort_noise(
    project: EpisodeProject, track: Track, path: Path, holes: GateHoles
) -> FillLoop | str:
    del project, track
    read = track_floor(path)
    if not isinstance(read, LiveFloor):
        return "no noise measured under its speech"
    floor = read.floor
    held = _hold_noise(path, holes)
    noise = held if isinstance(held, _Noise) else _room_noise(path, holes, floor) or held
    if isinstance(noise, str):
        return noise
    if floor.speech_db is None:
        return "no speech above its noise"
    loop = _synthesise(noise.psd, noise.nfft, holes.sample_rate)
    noise_db = rms_db(loop, floor_db=-200.0)
    if noise_db > floor.speech_db - MIN_BELOW_SPEECH_DB:
        return (
            f"its noise ({noise_db:.1f} dBFS) sits near its speech ({floor.speech_db:.1f} dBFS), "
            "not a floor"
        )
    return FillLoop(samples=loop, level_db=noise_db, noise_db=noise_db, basis=noise.basis)


def _synthesise(psd: np.ndarray, nfft: int, sample_rate: int) -> np.ndarray:
    """A seamless loop of Gaussian noise with power spectrum ``psd`` (random phase, one IFFT),
    with nothing under ``MIN_FILL_HZ``."""
    length = 1 << math.ceil(math.log2(LOOP_SEC * sample_rate))
    seed = int.from_bytes(hashlib.sha256(psd.astype("<f8").tobytes()).digest()[:8], "little")
    white = np.random.default_rng(seed).standard_normal(length)
    freqs = np.fft.rfftfreq(length, 1.0 / sample_rate)
    shape = np.interp(freqs, np.fft.rfftfreq(nfft, 1.0 / sample_rate), psd)
    shape[freqs < MIN_FILL_HZ] = 0.0
    return np.fft.irfft(np.fft.rfft(white) * np.sqrt(shape), length).astype(np.float32)


def _room_tone_bed(
    project: EpisodeProject, track: Track, path: Path, holes: GateHoles
) -> FillLoop | str:
    del path
    from podcast_mcp.engines.align import load_mono_window

    bed = room_tone_bed(project, track.id)
    if isinstance(bed, BedUnavailable):
        return "no recorded room-tone bed"
    samples = load_mono_window(
        bed.path, start_sec=0.0, duration_sec=bed.end, sample_rate=holes.sample_rate
    )
    return FillLoop(samples=samples, level_db=rms_db(samples, floor_db=-200.0), noise_db=None)


# Tried in order; the first that yields a loop fills the track. None reads another track.
FILL_SOURCES: tuple[tuple[GateFillSource, FillSourceFn], ...] = (
    (GateFillSource.ROOM_TONE_BED, _room_tone_bed),
    (GateFillSource.COMFORT_NOISE, _comfort_noise),
)


def _fade(length: int, fade: int) -> np.ndarray:
    """Gain over a hole: 0 at both edges, raised-cosine ramps of ``fade`` samples inside."""
    gain = np.ones(length, dtype=np.float32)
    n = min(fade, length // 2)
    if n:
        ramp = (0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)).astype(np.float32)
        gain[:n] = ramp
        gain[length - n :] = ramp[::-1]
    return gain


def _fill_chunks(holes: GateHoles, loop: np.ndarray, fade: int) -> Iterator[np.ndarray]:
    """The fill on the media's clock, ``(frames, channels)`` per chunk."""
    period = loop.size
    pending = list(holes.bounds)
    for c0 in range(0, holes.frames, WRITE_CHUNK):
        c1 = min(holes.frames, c0 + WRITE_CHUNK)
        mono = np.zeros(c1 - c0, dtype=np.float32)
        while pending and pending[0][1] <= c0:
            pending.pop(0)
        for a, b in pending:
            if a >= c1:
                break
            lo, hi = max(a, c0), min(b, c1)
            gain = _fade(b - a, fade)[lo - a : hi - a]
            mono[lo - c0 : hi - c0] = loop[np.arange(lo, hi) % period] * gain
        yield np.repeat(mono[:, None], holes.channels, axis=1)


def _fill_digest(holes: GateHoles, loop: np.ndarray, fade: int) -> str:
    h = hashlib.sha256()
    h.update(f"{holes.sample_rate}:{holes.channels}:{holes.frames}:{fade}".encode())
    h.update(np.asarray(holes.bounds, dtype="<i8").tobytes())
    h.update(np.asarray(loop, dtype="<f4").tobytes())
    return h.hexdigest()[:16]


def _write_fill(
    project: EpisodeProject, track_id: str, holes: GateHoles, loop: np.ndarray, fade: int
) -> str:
    """Write the fill once per content digest; returns its workspace-relative path."""
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    rel = f"{GATE_FILL_DIR}/{track_id}_{_fill_digest(holes, loop, fade)}.flac"
    dest = resolve_under_workspace(project, rel)
    if not dest.is_file():
        render_atomic(
            dest,
            lambda tmp: FFmpegEngine().encode_flac_f32(
                _fill_chunks(holes, loop, fade),
                tmp,
                sample_rate=holes.sample_rate,
                channels=holes.channels,
            ),
        )
    return rel


@dataclass(frozen=True)
class GateFillResult:
    """One track's outcome: its fill, or why it has none."""

    track_id: str
    fill: GateFill | None
    holes: int
    reason: str | None = None
    basis: str | None = None

    def describe(self) -> str:
        if self.fill is not None:
            f = self.fill
            noise = (
                f" (noise under speech {f.noise_db:.1f}, read {self.basis})"
                if f.noise_db is not None and self.basis is not None
                else ""
            )
            what = "comfort noise" if f.source is GateFillSource.COMFORT_NOISE else "room-tone bed"
            return (
                f"{self.track_id}: {f.holes} holes, {f.filled_sec:.1f}s filled with {what} "
                f"at {f.level_db:.1f} dBFS{noise}"
            )
        if not self.holes:
            return f"{self.track_id}: no gate holes"
        return f"{self.track_id}: {self.holes} holes left silent, {self.reason}"


def plan_gate_fill(project: EpisodeProject, track: Track, *, fade_ms: int) -> GateFillResult:
    """Measure ``track``'s holes and write their fill from the first source that has one."""
    assert track.media is not None
    path = resolve_under_workspace(project, track.media.path)
    stat = path.stat()
    holes = detect_gate_holes(path)
    if not holes.bounds:
        return GateFillResult(track.id, None, 0, "no gate holes")
    reasons: list[str] = []
    for source, fn in FILL_SOURCES:
        made = fn(project, track, path, holes)
        if isinstance(made, str):
            reasons.append(made)
            continue
        fade = round(fade_ms / 1000.0 * holes.sample_rate)
        rel = _write_fill(project, track.id, holes, made.samples, fade)
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
            return GateFillResult(track.id, None, len(holes.bounds), "media changed while read")
        fill = GateFill(
            source=source,
            path=rel,
            media_size=stat.st_size,
            media_mtime_ns=stat.st_mtime_ns,
            holes=len(holes.bounds),
            filled_sec=round(holes.seconds, 3),
            level_db=round(made.level_db, 2),
            noise_db=None if made.noise_db is None else round(made.noise_db, 2),
            fade_ms=fade_ms,
        )
        return GateFillResult(track.id, fill, len(holes.bounds), basis=made.basis)
    return GateFillResult(track.id, None, len(holes.bounds), reasons[-1])


def _config(defaults: dict[str, Any]) -> tuple[str, int]:
    cfg = defaults.get("gate_fill") or {}
    mode = str(cfg.get("mode", "auto"))
    if mode not in MODES:
        raise ValueError(f"gate_fill.mode must be one of {MODES}, not {mode!r}")
    fade_ms = int(cfg.get("fade_ms", 10))
    if fade_ms < 0:
        raise ValueError("gate_fill.fade_ms must be >= 0")
    return mode, fade_ms


def fill_gate_holes(project: EpisodeProject, defaults: dict[str, Any]) -> str:
    """Pipeline step: set or clear every dialogue track's ``gate_fill``; returns the summary."""
    mode, fade_ms = _config(defaults)
    tracks = [t for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media]
    if mode == "off":
        cleared = [t.id for t in tracks if t.gate_fill is not None]
        for track in tracks:
            track.gate_fill = None
        return f"off (gate_fill.mode); cleared {len(cleared)} track(s)"
    results: list[GateFillResult] = []
    with resolve_progress_task(
        "fill_gate_holes", "Filling gate holes", total=max(1, len(tracks)), prefer_parent=True
    ) as prog:
        prog.set_phase("measure", f"Measuring {len(tracks)} tracks…")
        for done, track in enumerate(tracks, start=1):
            results.append(plan_gate_fill(project, track, fade_ms=fade_ms))
            prog.advance(1, message=f"Measured {track.id} ({done}/{len(tracks)})")
    # Applied once every track is measured: a failure mid-loop changes no track.
    for track, result in zip(tracks, results, strict=True):
        track.gate_fill = result.fill
    return "; ".join(r.describe() for r in results) or "no dialogue tracks"


def current_gate_fill_path(project: EpisodeProject, track: Track) -> Path | None:
    """The track's fill file while it matches the media it was measured on, else None."""
    fill = track.gate_fill
    if fill is None or track.media is None:
        return None
    try:
        stat = resolve_under_workspace(project, track.media.path).stat()
        path = resolve_under_workspace(project, fill.path)
    except (OSError, ValueError):
        return None
    if (stat.st_size, stat.st_mtime_ns) != (fill.media_size, fill.media_mtime_ns):
        log.debug("gate fill for %s ignored: its media changed since it was measured", track.id)
        return None
    return path if path.is_file() else None


def gate_fill_payload(project: EpisodeProject, track: Track) -> dict[str, Any] | None:
    """What the render hash needs: the fill in force and its file revision."""
    path = current_gate_fill_path(project, track)
    if path is None or track.gate_fill is None:
        return None
    stat = path.stat()
    return {
        "fill": track.gate_fill.model_dump(mode="json"),
        "file": [stat.st_size, stat.st_mtime_ns],
    }
