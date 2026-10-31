"""Synthesised room tone for a fill much longer than the clean room tone there is (#2699).

A fill longer than the clean stretch it is cut from replays that stretch, however its repeats
are placed and joined (``room_tone_tiles.py``): a listener finds a repeat of noise that comes
back within a few seconds (Agus et al. 2010; Rajendran et al. 2016), and the longer the gap,
the more of it is repeat. A steady room is its spectrum and its level, so past
``SYNTH_MAX_REPLAY_SEC`` of replay the fill is noise synthesised to the spectrum and level of
that clean stretch (the method gate fill and bleed fill use, ``gate_fill.synthesise_noise``),
which has no period inside its ``SYNTH_FILE_SEC`` file (a fill past ``SYNTH_MAX_FILL_SEC`` tiles it).

Only a steady room is synthesised. A spectrum alone does not make a sound that is not
stationary noise (McDermott and Simoncelli 2011), so a stretch whose level moves by more
than ``NOISE_SPREAD_DB`` between half seconds, or that has a tone reaching the noise in its
critical band (mains hum, a fan; ``TONAL_TO_BAND_DB``), keeps its recorded audio and the tiling. So does a
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
import logging
import math
import re
import wave
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
from podcast_mcp.util.wav import open_wav
from podcast_mcp.util.workspace_paths import resolve_under_workspace

log = logging.getLogger(__name__)

# Bump when the synthesis or its guards change: ids, files and preview keys change with it.
SYNTH_REV = 2
# Seconds of a fill the clean audio may replay before the fill is synthesised instead.
# Listeners hear repeated noise at periods of several seconds, and regular repeats more
# easily (Rajendran et al. 2016); the literature does not fix a number, so this one is a
# judgment: a second of replay is not heard as a repeat, and under it a synthesised fill is
# not worth its cost.
SYNTH_MAX_REPLAY_SEC = 1.0
SYNTH_FILE_SEC = 60.0
# A fill reads at most this much of the file, which leaves SYNTH_FILE_SEC less this of start
# positions to tell fills apart.
SYNTH_MAX_FILL_SEC = 54.0
# Longest fade a mute region adds to the edit it covers (cut_application: fade out and in).
MUTE_FADE_SLACK_SEC = 1.0
SYNTH_RATE = 48000
# Under raw/, beside the recorded beds: a relocated workspace copy keeps raw/ but drops artifacts/.
SYNTH_DIR = "raw/room-tone-synth"
SYNTH_ID_PREFIX = "synth-room-tone-"
STEADY_WINDOW_SEC = 0.5
# A tone is heard once its power reaches the noise in its critical band (Zwicker: a tone in
# noise is masked until about 0 to -5 dB), so this is the end of that range that is lenient toward synthesis.
TONAL_TO_BAND_DB = 0.0
TONAL_NEIGHBOURS = 6
# Equivalent rectangular bandwidth of the ear's filter: 24.7 * (4.37 f / 1000 + 1) Hz
# (Glasberg and Moore 1990).
ERB_BASE_HZ = 24.7
ERB_SLOPE = 4.37
# Below this a line is not heard as a tone at a room's floor level: the hearing threshold is
# about 35 dB higher at 63 Hz than at 1 kHz (ISO 226), and rooms have modes there. Mains hum
# is still caught by its harmonics.
TONAL_MIN_HZ = 100.0
# Analysis frame for the tone check: the power of two nearest this many seconds (about 6 Hz
# bins at 48 kHz).
TONAL_FRAME_SEC = 0.17
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
    rate: int


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
    slack_sec: float = 0.0,
) -> RoomToneSelection:
    """``room_tone_span`` for ``gap_sec`` seconds, or synthesised tone when that would replay
    more than ``SYNTH_MAX_REPLAY_SEC`` of the clean audio it finds.

    ``seed_sec`` is the fill's position (source seconds for a mute, timeline seconds for a
    pad): it picks where in the synthesised file the fill reads. The other arguments are
    ``room_tone_span``'s. ``slack_sec`` lengthens a synthesised span past the gap: a mute's
    rendered region includes its fades, and a span shorter than that would be tiled in two.
    The synthesised source is registered on ``project``.
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
    swapped = basis.end - basis.start < MIN_ROOM_SEC and isinstance(selection, OwnQuietSample)
    pooled = selection
    if swapped:
        pooled = span(POOL_SAMPLE_SEC)
        if isinstance(pooled, SampleAbsent):
            return selection
        if gap_sec <= _replayed_sec(pooled) + SYNTH_MAX_REPLAY_SEC:
            return pooled
        basis = _basis(project, track_id, pooled)
        if basis is None:
            return selection
    synthesised = _synthesise(project, track_id, basis, gap_sec + slack_sec, seed_sec)
    if synthesised is not None:
        return synthesised
    return pooled if swapped else selection


def _replayed_sec(selection: RoomToneSelection) -> float:
    """Seconds of recorded audio the tiler replays for ``selection``."""
    if isinstance(selection, SampleAbsent):
        return float("inf")
    if isinstance(selection, OwnQuietSample):
        return selection.sample.end - selection.sample.start
    return selection.end - selection.start


def room_tone_synth_digest() -> str:
    """What decides whether a fill is synthesised: part of a preview's cache key."""
    return _params()


def _params() -> str:
    """Every constant that changes a synthesised file or whether a fill gets one."""
    return ":".join(
        str(value)
        for value in (
            SYNTH_REV,
            SYNTH_MAX_REPLAY_SEC,
            SYNTH_FILE_SEC,
            SYNTH_MAX_FILL_SEC,
            SYNTH_RATE,
            STEADY_WINDOW_SEC,
            NOISE_SPREAD_DB,
            MIN_ROOM_SEC,
            MIN_FILL_HZ,
            TONAL_FRAME_SEC,
            TONAL_MIN_HZ,
            TONAL_NEIGHBOURS,
            ERB_BASE_HZ,
            ERB_SLOPE,
            TONAL_TO_BAND_DB,
            LEVEL_TOLERANCE_DB,
            PROBE_SEC,
            POOL_SAMPLE_SEC,
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
        revision = file_revision(basis.path)
        analysis = _analyse(str(basis.path), revision, basis)
    except OSError:
        return None
    if analysis is None:
        return None
    name = re.sub(r"[^A-Za-z0-9_-]", "_", track_id)
    source_id = f"{SYNTH_ID_PREFIX}{name}-{analysis.digest}"
    rel_path = f"{SYNTH_DIR}/{name}_{analysis.digest}.flac"
    try:
        dest = resolve_under_workspace(project, rel_path)
        if not dest.is_file():
            _write_file(dest, analysis, source_id)
    except Exception:
        log.warning("room tone synthesis failed; keeping the recorded tiling", exc_info=True)
        return None
    length = min(gap_sec, SYNTH_MAX_FILL_SEC)
    start = seed_fraction(seed_sec) * (SYNTH_FILE_SEC - length)
    sample = SynthSample(
        start,
        start + length,
        source_id,
        dest,
        rel_path,
        SYNTH_FILE_SEC,
        revision=revision,
    )
    register_synth_source(project, sample)
    return sample


@lru_cache(maxsize=32)
def _analyse(path: str, revision: object, basis: _Basis) -> _Analysis | None:
    """The basis' spectrum and identity when it is a steady, untoned room; else None.

    A PCM WAV is read at its own rate, because the reader's resampling is linear and would
    bend the spectrum the synthesis copies; the noise is then realised at ``SYNTH_RATE`` from
    that spectrum (``source_rate``).
    """
    del revision  # only keys the cache: a rewritten file misses it
    rate = _native_rate(Path(path))
    try:
        samples = load_mono_window(
            Path(path),
            start_sec=basis.start,
            duration_sec=basis.end - basis.start,
            sample_rate=rate,
        )
    except Exception:
        log.warning("room tone basis unreadable; keeping the recorded tiling", exc_info=True)
        return None
    measured = measure_noise_psd(samples, rate)
    if measured is None or not _steady(samples, rate) or _tonal(samples, rate):
        return None
    psd, nfft = measured
    probe = synthesise_noise(
        psd, nfft, SYNTH_RATE, source_rate=rate, seed_key="level-probe", length_sec=PROBE_SEC
    )
    if abs(rms_db(probe) - rms_db(samples - np.mean(samples))) > LEVEL_TOLERANCE_DB:
        return None
    digest = hashlib.sha256(
        f"{_params()}:{basis.kind}:{rate}".encode() + np.asarray(samples, dtype="<f4").tobytes()
    ).hexdigest()[:16]
    return _Analysis(digest, psd, nfft, rate)


def _native_rate(path: Path) -> int:
    """The rate of a PCM WAV; ``SYNTH_RATE`` for anything the reader decodes through ffmpeg."""
    try:
        with open_wav(path) as wf:
            return int(wf.getframerate())
    except (OSError, EOFError, wave.Error):
        return SYNTH_RATE


def _steady(samples: np.ndarray, rate: int) -> bool:
    window = round(STEADY_WINDOW_SEC * rate)
    count = samples.size // window
    if count < 2:
        return False
    pieces = samples[: count * window].reshape(count, window)
    levels = [rms_db(piece - piece.mean()) for piece in pieces]
    return max(levels) - min(levels) <= NOISE_SPREAD_DB


def _tonal(samples: np.ndarray, rate: int) -> bool:
    """A line whose power reaches ``TONAL_TO_BAND_DB`` over the noise in its critical band.

    The frames are long enough (about 6 Hz bins at 48 kHz) that the harmonics of a 50 or 60 Hz
    buzz sit bins apart and do not raise the neighbours a line is compared with. A line's power
    is its three bins less the floor they would hold, and the noise it must stand over is the
    floor of the critical band around it (ERB, Glasberg and Moore 1990): a line a few bins
    wide that is only a little over its neighbours is masked and does not make a tone.
    """
    nfft = 1 << round(math.log2(TONAL_FRAME_SEC * rate))
    if samples.size < nfft:
        return False
    window = np.hanning(nfft)
    total = np.zeros(nfft // 2 + 1)
    count = 0
    for start in range(0, samples.size - nfft + 1, nfft // 2):
        frame = samples[start : start + nfft]
        total += np.abs(np.fft.rfft((frame - frame.mean()) * window)) ** 2
        count += 1
    psd = total / count
    width = rate / nfft
    ratio = 10 ** (TONAL_TO_BAND_DB / 10)
    for index in range(int(np.ceil(TONAL_MIN_HZ / width)), psd.size - 1):
        erb = ERB_BASE_HZ * (ERB_SLOPE * index * width / 1000 + 1)
        reach = max(TONAL_NEIGHBOURS, round(erb / 2 / width))
        around = np.concatenate(
            (psd[max(0, index - reach) : max(0, index - 1)], psd[index + 2 : index + reach + 1])
        )
        if around.size == 0:
            continue
        floor = float(np.median(around))
        line = float(psd[index - 1 : index + 2].sum()) - 3 * floor
        if line > ratio * floor * erb / width:
            return True
    return False


def _write_file(dest: Path, analysis: _Analysis, seed_key: str) -> None:
    """Write the synthesised file once."""
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    noise = synthesise_noise(
        analysis.psd,
        analysis.nfft,
        SYNTH_RATE,
        source_rate=analysis.rate,
        seed_key=seed_key,
        length_sec=SYNTH_FILE_SEC,
    )

    # synthesise_noise rounds up to a power of two; the file is exactly SYNTH_FILE_SEC.
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
