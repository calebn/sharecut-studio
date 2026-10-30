"""Synthesised room tone for a fill much longer than the clean room tone there is (#2699).

A fill longer than the clean stretch it is cut from replays that stretch, however its repeats
are placed and joined (``room_tone_tiles.py``): a listener finds a repeat of noise that comes
back within a few seconds (Agus et al. 2010; Rajendran et al. 2016), and the longer the gap,
the more of it is repeat. A steady room is its spectrum and its level, so past
``SYNTH_MAX_REPLAY_SEC`` of replay the fill is noise synthesised to the spectrum and level of
that clean stretch (the method gate fill and bleed fill use, ``gate_fill.synthesise_noise``),
which has no period inside its ``SYNTH_FILE_SEC`` file (a fill past that length tiles it).

Only a steady room is synthesised. A spectrum alone does not make a sound that is not
stationary noise (McDermott and Simoncelli 2011), so a stretch whose level moves by more
than ``NOISE_SPREAD_DB`` between half seconds, or that has a tone standing ``TONAL_PEAK_DB``
over its neighbours (mains hum, a fan), keeps its recorded audio and the tiling. So does a
stretch under ``MIN_ROOM_SEC``, whose spectrum is too poorly measured to reproduce, and one
whose synthesised level lands more than ``LEVEL_TOLERANCE_DB`` from the stretch's own.

The result is a source like a recorded bed: a content-addressed FLAC under the workspace,
registered in ``sources[]`` so every consumer that resolves a clip's or a mute fill's
``source_id`` (render, proxies, pad samples, export) reads it unchanged. The id and file name
come from the basis audio, so a preview on a scratch copy and the approve register the same
source. Each fill reads from its own place in the file, derived from its position.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.gate_fill import (
    MIN_FILL_HZ,
    MIN_ROOM_SEC,
    NOISE_SPREAD_DB,
    measure_noise_psd,
    synthesise_noise,
)
from podcast_mcp.engines.room_tone import (
    POOL_SAMPLE_SEC,
    OwnQuietSample,
    RecordedBedSample,
    RoomToneSelection,
    SampleAbsent,
    Span,
    room_tone_bed,
    room_tone_span,
)
from podcast_mcp.engines.room_tone_tiles import seed_fraction
from podcast_mcp.models import EpisodeProject, SourceRecording
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.dsp import rms_db
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.tracks import track_audio_path
from podcast_mcp.util.workspace_paths import resolve_under_workspace

# Bump when the synthesis or its guards change: ids, files and preview keys change with it.
SYNTH_REV = 1
# Seconds of a fill the clean audio may replay before the fill is synthesised instead.
# Listeners hear repeated noise at periods of several seconds, and regular repeats more
# easily (Rajendran et al. 2016); the literature does not fix a number, so this one is a
# judgment: a second of replay is a stutter nobody hears, 1.3 s over an 18.7 s bed is not
# worth a synthesised fill's cost, and the Mac lab judges where it sounds.
SYNTH_MAX_REPLAY_SEC = 1.0
SYNTH_FILE_SEC = 60.0
SYNTH_RATE = 48000
# Under raw/, beside the recorded beds: a relocated workspace copy keeps raw/ but drops artifacts/.
SYNTH_DIR = "raw/room-tone-synth"
SYNTH_ID_PREFIX = "synth-room-tone-"
STEADY_WINDOW_SEC = 0.5
TONAL_PEAK_DB = 10.0
TONAL_NEIGHBOURS = 6
LEVEL_TOLERANCE_DB = 0.5
PROBE_SEC = 2.0
WRITE_CHUNK = 1 << 16


@dataclass(frozen=True)
class SynthSample(RecordedBedSample):
    """A span of the synthesised file ``path`` (``source_id`` in ``sources[]`` once registered)."""

    rel_path: str
    duration_sec: float


@dataclass(frozen=True)
class _Basis:
    kind: str
    path: Path
    start: float
    end: float


@dataclass(frozen=True)
class _Analysis:
    digest: str
    psd: np.ndarray
    nfft: int


def room_tone_for_gap(
    project: EpisodeProject,
    track_id: str,
    *,
    gap_sec: float,
    seed_sec: float,
    near_sec: float,
    near_source_id: str | None,
    timeline_sec: float | None = None,
    duration_sec: float,
    avoid: Sequence[Span] = (),
    also_taken: Sequence[Span] = (),
) -> RoomToneSelection:
    """``room_tone_span`` for ``gap_sec`` seconds, or synthesised tone when that would replay
    more than ``SYNTH_MAX_REPLAY_SEC`` of the clean audio it finds.

    ``seed_sec`` is the fill's position (source seconds for a mute, timeline seconds for a
    pad): it picks where in the synthesised file the fill reads. The other arguments are
    ``room_tone_span``'s. The synthesised source is registered on ``project``.
    """

    def span(request_sec: float) -> RoomToneSelection:
        return room_tone_span(
            project,
            track_id,
            near_sec=near_sec,
            near_source_id=near_source_id,
            timeline_sec=timeline_sec,
            duration_sec=request_sec,
            avoid=avoid,
            also_taken=also_taken,
        )

    selection = span(duration_sec)
    if gap_sec <= _replayed_sec(selection) + SYNTH_MAX_REPLAY_SEC:
        return selection
    basis = _basis(project, track_id, selection)
    if basis is None:
        return selection
    if basis.end - basis.start < MIN_ROOM_SEC and isinstance(selection, OwnQuietSample):
        pooled = span(POOL_SAMPLE_SEC)
        if gap_sec <= _replayed_sec(pooled) + SYNTH_MAX_REPLAY_SEC:
            return selection
        basis = _basis(project, track_id, pooled)
        if basis is None:
            return selection
    synthesised = _synthesise(project, track_id, basis, gap_sec, seed_sec)
    return selection if synthesised is None else synthesised


def _replayed_sec(selection: RoomToneSelection) -> float:
    """Seconds of recorded audio the tiler replays for ``selection``."""
    if isinstance(selection, SampleAbsent):
        return float("inf")
    if isinstance(selection, OwnQuietSample):
        return selection.sample.end - selection.sample.start
    return selection.end - selection.start


def room_tone_synth_digest() -> str:
    """What decides whether a fill is synthesised: part of a preview's cache key."""
    return f"{_params()}"


def _params() -> str:
    """Every constant that changes a synthesised file or whether a fill gets one."""
    return ":".join(
        str(value)
        for value in (
            SYNTH_REV,
            SYNTH_MAX_REPLAY_SEC,
            SYNTH_FILE_SEC,
            LEVEL_TOLERANCE_DB,
            TONAL_PEAK_DB,
            NOISE_SPREAD_DB,
        )
    )


def register_synth_source(project: EpisodeProject, sample: SynthSample) -> None:
    """Make ``sample``'s source known to ``project`` (a no-op when it already is)."""
    if project.source_by_id(sample.source_id) is None:
        project.sources.append(
            SourceRecording(
                id=sample.source_id,
                path=sample.rel_path,
                duration_sec=sample.duration_sec,
                sample_rate=SYNTH_RATE,
                channels=1,
            )
        )


def _basis(project: EpisodeProject, track_id: str, selection: RoomToneSelection) -> _Basis | None:
    if isinstance(selection, SampleAbsent):
        return None
    if isinstance(selection, OwnQuietSample):
        sample = selection.sample
        return _Basis("own", track_audio_path(project, track_id), sample.start, sample.end)
    bed = room_tone_bed(project, track_id)
    if not isinstance(bed, RecordedBedSample):
        return None
    return _Basis("bed", bed.path, bed.start, bed.end)


def _synthesise(
    project: EpisodeProject, track_id: str, basis: _Basis, gap_sec: float, seed_sec: float
) -> SynthSample | None:
    if basis.end - basis.start < MIN_ROOM_SEC:
        return None
    try:
        analysis = _analyse(str(basis.path), file_revision(basis.path), basis)
    except OSError:
        return None
    if analysis is None:
        return None
    source_id = f"{SYNTH_ID_PREFIX}{track_id}-{analysis.digest}"
    rel_path = f"{SYNTH_DIR}/{track_id}_{analysis.digest}.flac"
    dest = resolve_under_workspace(project, rel_path)
    try:
        if not dest.is_file():
            _write_file(dest, analysis, source_id)
    except Exception:
        return None
    length = min(gap_sec, SYNTH_FILE_SEC)
    start = seed_fraction(seed_sec) * (SYNTH_FILE_SEC - length)
    sample = SynthSample(start, start + length, source_id, dest, rel_path, SYNTH_FILE_SEC)
    register_synth_source(project, sample)
    return sample


@lru_cache(maxsize=32)
def _analyse(path: str, revision: object, basis: _Basis) -> _Analysis | None:
    """The basis' spectrum and identity when it is a steady, untoned room; else None."""
    del revision
    try:
        samples = load_mono_window(
            Path(path),
            start_sec=basis.start,
            duration_sec=basis.end - basis.start,
            sample_rate=SYNTH_RATE,
        )
    except Exception:
        return None
    measured = measure_noise_psd(samples, SYNTH_RATE)
    if measured is None or not _steady(samples) or _tonal(*measured):
        return None
    psd, nfft = measured
    probe = synthesise_noise(psd, nfft, SYNTH_RATE, seed_key="level-probe", length_sec=PROBE_SEC)
    if abs(rms_db(probe) - rms_db(samples - np.mean(samples))) > LEVEL_TOLERANCE_DB:
        return None
    digest = hashlib.sha256(
        f"{_params()}:{basis.kind}:{SYNTH_RATE}".encode()
        + np.asarray(samples, dtype="<f4").tobytes()
    ).hexdigest()[:16]
    return _Analysis(digest, psd, nfft)


def _steady(samples: np.ndarray) -> bool:
    window = round(STEADY_WINDOW_SEC * SYNTH_RATE)
    count = samples.size // window
    if count < 2:
        return False
    pieces = samples[: count * window].reshape(count, window)
    levels = [rms_db(piece - piece.mean()) for piece in pieces]
    return max(levels) - min(levels) <= NOISE_SPREAD_DB


def _tonal(psd: np.ndarray, nfft: int) -> bool:
    """A bin standing ``TONAL_PEAK_DB`` over the median of the bins around it."""
    freqs = np.fft.rfftfreq(nfft, 1.0 / SYNTH_RATE)
    ratio = 10 ** (TONAL_PEAK_DB / 10)
    for index in (int(i) for i in np.flatnonzero(freqs >= MIN_FILL_HZ)):
        low = max(0, index - TONAL_NEIGHBOURS)
        high = min(psd.size, index + TONAL_NEIGHBOURS + 1)
        around = np.delete(psd[low:high], index - low)
        if psd[index] > ratio * np.median(around):
            return True
    return False


def _write_file(dest: Path, analysis: _Analysis, seed_key: str) -> None:
    """Write the synthesised file once."""
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    noise = synthesise_noise(
        analysis.psd, analysis.nfft, SYNTH_RATE, seed_key=seed_key, length_sec=SYNTH_FILE_SEC
    )

    noise = noise[: round(SYNTH_FILE_SEC * SYNTH_RATE)]

    def chunks() -> Iterator[np.ndarray]:
        for first in range(0, noise.size, WRITE_CHUNK):
            yield noise[first : first + WRITE_CHUNK, None]

    render_atomic(
        dest,
        lambda tmp: FFmpegEngine().encode_flac_f32(
            chunks(), tmp, sample_rate=SYNTH_RATE, channels=1
        ),
    )
