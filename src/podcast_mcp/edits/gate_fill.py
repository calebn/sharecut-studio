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
reads the gate's *hangover*: what the gate held open before each closure, after the voice
fell below its threshold, which is the noise a telephony encoder sends its SID frames from.
The hold is measured per track, never assumed (``_measure_hold``). Going back from the
closures, the median level of each ``BLOCK_SEC`` stays level while the gate holds open on
the floor and rises where the voice's tail begins; a release ramp or a codec's last frame
may sit a step under the floor right at the closure. A voice's tail slopes, a floor does
not, so a gate that closes on a tail with no hold has no level run and its holes stay
silent. Over the measured hold, frames ``SPEECH_ABOVE_NOISE_DB`` over the median (the odd
closure a word still reaches) are dropped and the rest are averaged per frequency bin; a
hold shorter than a frame is read as one shorter frame per closure. The estimate must also
sit ``MIN_BELOW_SPEECH_DB`` under the track's own speech level, as room tone must
(``edits/room_tone.py``); otherwise it is not a floor and the holes stay silent. Minimum
statistics (Martin 2001) and the quietest tenth of all open frames were measured against
it and read high on gated tracks: [audio-engineering.md § Gate fill].

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

from podcast_mcp.edits.room_tone import MIN_BELOW_SPEECH_DB, SPEECH_PERCENTILE, room_tone_bed
from podcast_mcp.models import EpisodeProject, GateFill, GateFillSource, Track, TrackRole
from podcast_mcp.util.atomic_render import render_atomic
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
# Speech frames skip EDGE_SEC at each hole edge, the gate's own ramp.
EDGE_SEC = 0.01
# The gate's hold is read from the median level of each BLOCK_SEC going back from its
# closures, up to MAX_HOLD_SEC; a block's median needs MIN_CLOSURES closures that reach it.
# The hold is the longest level run there: within FLAT_DB of its own quietest block, rising
# less than FLAT_DB / 2 across it, at least MIN_HOLD_SEC long, with any release edge
# between it and the closure more than FLAT_DB under it, and the voice back above it.
BLOCK_SEC = 0.005
MAX_HOLD_SEC = 0.5
FLAT_DB = 2.0
MIN_HOLD_SEC = 0.015
MIN_CLOSURES = 8
# Frames read per window, so a long open stretch is never held whole.
READ_FRAMES = 512
# The speech level is read from frames this far over the noise estimate.
SPEECH_ABOVE_NOISE_DB = 10.0
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
    # The gate hold the noise was read from, in seconds; None for a recorded bed.
    hold_sec: float | None = None


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
    with closing(chunks):
        for chunk in chunks:
            block = np.asarray(chunk).reshape(-1, channels)
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
    )


def _frame_len(sample_rate: int) -> int:
    return 1 << round(math.log2(FRAME_SEC * sample_rate))


def _power_db(psd: np.ndarray, nfft: int) -> float:
    """Signal power of a one-sided periodogram (``|X|^2 / sum(w^2)`` per bin), in dBFS."""
    power = (psd[0] + psd[-1] + 2.0 * psd[1:-1].sum()) / nfft
    return 10.0 * math.log10(max(float(power), 1e-30))


@dataclass
class _NoiseFrames:
    """What one pass over a track's open stretches keeps for the noise estimate."""

    nfft: int
    hangover: list[np.ndarray]
    frame_db: list[np.ndarray]


def _open_stretches(holes: GateHoles) -> Iterator[tuple[int, int, bool]]:
    """``(start, end, closes)`` of live audio between holes; ``closes`` when a gate shuts at ``end``."""
    start, last = holes.live
    for a, b in holes.bounds:
        yield start, a, True
        start = b
    yield start, last, holes.frames - last >= round(MIN_HOLE_SEC * holes.sample_rate)


def _mono_reader(path: Path, sample_rate: int) -> SequentialWindowReader:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    chunks = FFmpegEngine().stream_mono_f32(path, sample_rate=sample_rate)
    return SequentialWindowReader(chunks, sample_rate)


def _closure_profile(path: Path, holes: GateHoles) -> np.ndarray:
    """Median level (dBFS) of each block going back from the gate's closures; [0] ends at one.

    Stops at the first block fewer than ``MIN_CLOSURES`` closures reach.
    """
    sr = holes.sample_rate
    block = round(BLOCK_SEC * sr)
    blocks = round(MAX_HOLD_SEC / BLOCK_SEC)
    rows: list[np.ndarray] = []
    with closing(_mono_reader(path, sr)) as reader:
        for start, end, closes in _open_stretches(holes):
            n = min(blocks, (end - start) // block)
            if not closes or n == 0:
                continue
            samples, _ = reader.window_samples(end - n * block, end)
            if samples.size < n * block:
                continue
            power = np.mean(np.square(samples.reshape(n, block), dtype=np.float64), axis=1)
            rows.append(np.pad(power[::-1], (0, blocks - n), constant_values=np.nan))
    if len(rows) < MIN_CLOSURES:
        return np.zeros(0)
    table = np.vstack(rows)
    short = np.flatnonzero(np.sum(~np.isnan(table), axis=0) < MIN_CLOSURES)
    reached = int(short[0]) if short.size else blocks
    return 10.0 * np.log10(np.maximum(np.nanmedian(table[:, :reached], axis=0), 1e-30))


def _level_run(levels: np.ndarray) -> int:
    """Blocks from ``levels[0]`` that stay level: within ``FLAT_DB`` of the quietest so far,
    and with a least-squares rise across them under ``FLAT_DB / 2`` (a voice's tail still
    slopes up away from the closure; a floor does not)."""
    floor = np.minimum.accumulate(levels)
    above = np.flatnonzero(levels > floor + FLAT_DB)
    n = int(above[0]) if above.size else levels.size
    m = np.arange(2, n + 1, dtype=np.float64)
    k = np.arange(n, dtype=np.float64)
    sy, sky = np.cumsum(levels[:n])[1:], np.cumsum(k * levels[:n])[1:]
    sk, skk = m * (m - 1) / 2, (m - 1) * m * (2 * m - 1) / 6
    rise = (m * sky - sk * sy) / (m * skk - sk**2) * m
    level = np.flatnonzero(rise <= FLAT_DB / 2)
    return int(level[-1]) + 2 if level.size else min(n, 1)


def _measure_hold(profile_db: np.ndarray, sample_rate: int) -> tuple[int, int]:
    """``(edge, hold)`` in samples: the gate's release edge just before each closure (a ramp,
    or a codec's last frame), and the hold on the track's floor before that edge: the
    longest level run that qualifies. The hold is 0 when none does."""
    block = round(BLOCK_SEC * sample_rate)
    best = (0, 0)
    for edge in range(profile_db.size):
        run = _level_run(profile_db[edge:])
        floor = profile_db[edge : edge + run]
        if (
            run > best[1]
            and run * BLOCK_SEC >= MIN_HOLD_SEC
            and profile_db[:edge].max(initial=-np.inf) < floor.min() - FLAT_DB
            and profile_db[edge + run :].max(initial=-np.inf)
            >= floor.mean() + SPEECH_ABOVE_NOISE_DB
        ):
            best = (edge, run)
    return best[0] * block, best[1] * block


def _noise_frames(path: Path, holes: GateHoles, release: int, hold: int) -> _NoiseFrames:
    """Speech-level frames over the open stretches, and the hold's frames before each closure."""
    sr = holes.sample_rate
    nfft = _frame_len(sr)
    hop = nfft // 2
    window = np.hanning(nfft)
    norm = float(np.sum(window**2))
    # A hold shorter than a frame is read as one shorter frame per closure, zero-padded.
    held_len = min(nfft, hold)
    held_window = np.hanning(held_len)
    held_norm = float(np.sum(held_window**2))
    held_starts = np.arange(0, hold - held_len + 1, max(1, held_len // 2))
    held_idx = held_starts[:, None] + np.arange(held_len)[None, :]
    edge = round(EDGE_SEC * sr)
    out = _NoiseFrames(nfft=nfft, hangover=[], frame_db=[])
    with closing(_mono_reader(path, sr)) as reader:
        for start, end, closes in _open_stretches(holes):
            held = closes and end - start > release + hold
            a, b = start + edge, (end - release - hold) if held else (end - edge)
            count = 1 + (b - a - nfft) // hop if b - a >= nfft else 0
            for f0 in range(0, count, READ_FRAMES):
                f1 = min(count, f0 + READ_FRAMES)
                samples, _ = reader.window_samples(a + f0 * hop, a + (f1 - 1) * hop + nfft)
                idx = np.arange(f1 - f0)[:, None] * hop + np.arange(nfft)[None, :]
                frames = samples[np.minimum(idx, samples.size - 1)] * window
                psd = np.abs(np.fft.rfft(frames, axis=1)) ** 2 / norm
                power = (psd[:, 0] + psd[:, -1] + 2.0 * psd[:, 1:-1].sum(axis=1)) / nfft
                out.frame_db.append(10.0 * np.log10(np.maximum(power, 1e-30)))
            if not held:
                continue
            tail, _ = reader.window_samples(end - release - hold, end - release)
            if tail.size == hold:
                frames = tail[held_idx] * held_window
                out.hangover.append(np.abs(np.fft.rfft(frames, n=nfft, axis=1)) ** 2 / held_norm)
    return out


def _noise_psd(frames: _NoiseFrames) -> np.ndarray | None:
    """Mean periodogram of the hangover frames that carry no voice, or None unmeasured."""
    if len(frames.hangover) < MIN_CLOSURES:
        return None
    held = np.concatenate(frames.hangover)
    power = held.sum(axis=1)
    return held[power <= np.median(power) * 10 ** (SPEECH_ABOVE_NOISE_DB / 10)].mean(axis=0)


def _comfort_noise(
    project: EpisodeProject, track: Track, path: Path, holes: GateHoles
) -> FillLoop | str:
    del project, track
    profile = _closure_profile(path, holes)
    if profile.size == 0:
        return "no noise measured under its speech"
    release, hold = _measure_hold(profile, holes.sample_rate)
    if not hold:
        return "its gate holds no level floor open before closing, too short to measure"
    hold_sec = hold / holes.sample_rate
    frames = _noise_frames(path, holes, release, hold)
    psd = _noise_psd(frames)
    if psd is None:
        return "no noise measured under its speech"
    noise_db = _power_db(psd, frames.nfft)
    levels = np.concatenate(frames.frame_db) if frames.frame_db else np.zeros(0)
    voiced = levels[levels > noise_db + SPEECH_ABOVE_NOISE_DB]
    if voiced.size == 0:
        return "no speech above its noise"
    speech_db = float(np.percentile(voiced, SPEECH_PERCENTILE))
    if noise_db > speech_db - MIN_BELOW_SPEECH_DB:
        return (
            f"its noise ({noise_db:.1f} dBFS) sits near its speech ({speech_db:.1f} dBFS), "
            "not a floor"
        )
    loop = _synthesise(psd, frames.nfft, holes.sample_rate)
    return FillLoop(samples=loop, level_db=noise_db, noise_db=noise_db, hold_sec=hold_sec)


def _synthesise(psd: np.ndarray, nfft: int, sample_rate: int) -> np.ndarray:
    """A seamless loop of Gaussian noise with power spectrum ``psd`` (random phase, one IFFT)."""
    length = 1 << math.ceil(math.log2(LOOP_SEC * sample_rate))
    seed = int.from_bytes(hashlib.sha256(psd.astype("<f8").tobytes()).digest()[:8], "little")
    white = np.random.default_rng(seed).standard_normal(length)
    shape = np.interp(
        np.fft.rfftfreq(length, 1.0 / sample_rate),
        np.fft.rfftfreq(nfft, 1.0 / sample_rate),
        psd,
    )
    return np.fft.irfft(np.fft.rfft(white) * np.sqrt(shape), length).astype(np.float32)


def _room_tone_bed(
    project: EpisodeProject, track: Track, path: Path, holes: GateHoles
) -> FillLoop | str:
    del path
    from podcast_mcp.engines.align import load_mono_window
    from podcast_mcp.util.dsp import rms_db

    bed = room_tone_bed(project, track.id)
    if bed is None:
        return "no recorded room-tone bed"
    samples = load_mono_window(
        bed[0], start_sec=0.0, duration_sec=bed[1], sample_rate=holes.sample_rate
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
    hold_sec: float | None = None

    def describe(self) -> str:
        if self.fill is not None:
            f = self.fill
            noise = (
                f" (noise under speech {f.noise_db:.1f}, read over a {1000 * self.hold_sec:.0f} ms "
                "gate hold)"
                if f.noise_db is not None and self.hold_sec is not None
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
        return GateFillResult(track.id, fill, len(holes.bounds), hold_sec=made.hold_sec)
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
