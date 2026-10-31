from __future__ import annotations

import logging
import subprocess
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cached_property, partial
from pathlib import Path

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.engines.level_profile import (
    LEVEL_FRAME_SEC,
    PROFILE_SAMPLE_RATE,
    LevelProfile,
    file_level_profile,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import scoped_by_file
from podcast_mcp.util.dsp import (
    DIGITAL_SILENCE_DB,
    LOW_BAND,
    SPEECH_BAND,
    BandShape,
    frame_band_filtered_db,
)
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

log = logging.getLogger(__name__)

# Matches measure_window_rms_db's default (engines/audio_audit.py) -- used for
# RMS-based join-jump measurement (edits/cut_quality.py).
JUMP_SAMPLE_RATE = 8000
# Matches the existing boundary-snap/breath-detection resolution (edits/inaudible_cuts.py,
# edits/breath_detect.py) -- kept distinct from JUMP_SAMPLE_RATE so results are
# numerically identical to today's per-window ffmpeg reads, not just "close enough".
WAVEFORM_SAMPLE_RATE = PROFILE_SAMPLE_RATE


class BandLevels:
    """A recording's 10 ms levels through one :class:`~podcast_mcp.util.dsp.BandShape`, filtered once.

    Pause trims read the levels of every dialogue recording, and the filter is an FFT over
    the audio, so reading each window afresh costs more than the decision it feeds. The
    levels are made a block of ``_BLOCK_SEC`` at a time, from audio read with
    ``_MARGIN_SEC`` either side so the filter's ringing at a block's edge is trimmed away,
    and kept. ``read(start, duration)`` returns the recording's mono samples at
    ``sample_rate``. Blocks are made under a lock, so concurrent candidates share them.
    """

    _BLOCK_SEC = 30.0
    _MARGIN_SEC = 1.0

    def __init__(
        self,
        read: Callable[[float, float], np.ndarray],
        sample_rate: int,
        band: BandShape = SPEECH_BAND,
    ) -> None:
        self._read = read
        self._rate = sample_rate
        self.band = band
        self._frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
        self._block = round(self._BLOCK_SEC / LEVEL_FRAME_SEC)
        self._margin = round(self._MARGIN_SEC / LEVEL_FRAME_SEC)
        self._blocks: dict[int, np.ndarray | None] = {}
        self._lock = threading.Lock()

    def _make(self, index: int) -> np.ndarray | None:
        first = index * self._block
        lead = min(first, self._margin)
        start = (first - lead) * LEVEL_FRAME_SEC
        duration = (self._block + lead + self._margin) * LEVEL_FRAME_SEC
        try:
            samples = self._read(start, duration)
        except (OSError, ValueError, subprocess.CalledProcessError):
            return None
        if not np.all(np.isfinite(samples)):
            return None
        if not samples.size:
            return np.empty(0, dtype=np.float32)
        levels = frame_band_filtered_db(
            samples, self._rate, self._frame, self.band, floor_db=DIGITAL_SILENCE_DB
        )
        return levels[lead : lead + self._block].astype(np.float32)

    def _get(self, index: int) -> np.ndarray | None:
        if index not in self._blocks:
            with self._lock:
                if index not in self._blocks:
                    self._blocks[index] = self._make(index)
        return self._blocks[index]

    def all_levels(self) -> np.ndarray | None:
        """The levels of every frame of the recording, to where its audio ends.

        The length comes from the audio itself, never from a duration the media record
        may lack or get wrong. ``None`` when a block cannot be read or the recording is
        empty.
        """
        parts: list[np.ndarray] = []
        index = 0
        while True:
            block = self._get(index)
            if block is None:
                return None
            parts.append(block)
            if block.size < self._block:
                break
            index += 1
        levels = np.concatenate(parts).astype(np.float64)
        return levels if levels.size else None


@dataclass(frozen=True)
class TrackAudioCache:
    """One dialogue track's raw source audio, decoded once at each resolution
    tighten/cut-quality analysis actually needs, instead of spawning a fresh
    ffmpeg subprocess (~70ms) per tiny window read. See docs/pipeline.md#performance.

    Two separate decodes (not one shared rate) so behavior stays numerically
    identical to the uncached path: jump/RMS measurement and waveform-boundary
    scoring historically ran at different sample rates.
    """

    jump: TrackRmsCache  # JUMP_SAMPLE_RATE -- feeds measure_join_jump_db
    waveform: TrackRmsCache  # WAVEFORM_SAMPLE_RATE -- feeds boundary snap + breath detection

    def window(self, t_start: float, t_end: float) -> np.ndarray:
        """Raw samples at WAVEFORM_SAMPLE_RATE for [t_start, t_end)."""
        return self.waveform.window(t_start, t_end)

    def _band_levels(self, band: BandShape) -> BandLevels:
        return BandLevels(
            lambda start, duration: self.window(start, start + duration),
            int(self.waveform.sample_rate),
            band,
        )

    @cached_property
    def band_levels(self) -> BandLevels:
        """The track's speech-band levels, filtered once and shared by every candidate."""
        return self._band_levels(SPEECH_BAND)

    @cached_property
    def low_band_levels(self) -> BandLevels:
        """The track's low-band levels (80 to 160 Hz), filtered once and shared likewise."""
        return self._band_levels(LOW_BAND)

    @property
    def profile(self) -> LevelProfile:
        """The track's :class:`~podcast_mcp.engines.level_profile.LevelProfile`."""
        return self.waveform.profile


def track_level_profile(
    project: EpisodeProject,
    track_id: str,
    audio_cache: TrackAudioCache | None = None,
    *,
    sample_rate: int = WAVEFORM_SAMPLE_RATE,
    record: bool = False,
) -> LevelProfile:
    """The track's profile: ``audio_cache``'s, else its recording's, measured once per file.

    ``sample_rate`` is the rate of the levels it is compared with (a floor is read at the
    rate of the frames it is compared with): ``JUMP_SAMPLE_RATE`` for window RMS reads.
    Callers with no decode of the track (a cut re-optimized at approval, a natural-language
    edit) read the same levels the proposals did. ``record=True`` also records the measurement
    under the project's ``artifacts`` for a later process; planning paths never write (the
    pipeline does, via :func:`record_track_level_profiles`).
    """
    if audio_cache is not None:
        return audio_cache.jump.profile if sample_rate == JUMP_SAMPLE_RATE else audio_cache.profile
    return file_level_profile(
        track_audio_path(project, track_id),
        sample_rate=sample_rate,
        record_dir=project.artifacts_dir() / "level_profiles",
        write_record=record,
    )


def record_track_level_profiles(project: EpisodeProject) -> None:
    """Record every dialogue track's profile at the rates the edit paths read, for a later process.

    A profile measured earlier in this process is recorded without a decode; one not yet
    measured is decoded here.
    """
    for track_id in dialogue_track_ids(project):
        if (track := project.track_by_id(track_id)) is None or track.media is None:
            continue
        for rate in (WAVEFORM_SAMPLE_RATE, JUMP_SAMPLE_RATE):
            try:
                track_level_profile(project, track_id, sample_rate=rate, record=True)
            except Exception:
                log.debug("level profile not recorded for %s", track_id, exc_info=True)


def decode_track(path: Path) -> TrackAudioCache:
    """Both rates of a raw recording, each decoded once per process while the file is unchanged."""
    jump, waveform = run_parallel(
        [JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE],
        lambda rate: TrackRmsCache.from_recording(path, sample_rate=rate),
    )
    return TrackAudioCache(jump=jump, waveform=waveform)


def source_audio_cache(
    project: EpisodeProject, track_id: str, source_id: str | None
) -> TrackAudioCache:
    from podcast_mcp.util.tracks import recording_audio_path

    return recording_audio_cache(recording_audio_path(project, track_id, source_id))


def recording_audio_cache(path: Path) -> TrackAudioCache:
    return scoped_by_file("track_audio_cache", path, None, partial(decode_track, path))


def build_track_audio_caches(
    project: EpisodeProject, track_ids: Iterable[str]
) -> dict[str, TrackAudioCache]:
    """Decode each track's raw source audio once, for reuse across many
    per-candidate window reads. Build this once up front (e.g. before a
    parallel gather phase) and share it read-only across candidates/threads --
    numpy arrays are safe for concurrent reads with no locking needed.

    Tracks whose media can't be resolved OR whose audio fails to decode (missing
    file, unreadable format, ffmpeg not on PATH, etc.) are silently skipped --
    callers that look up a missing track_id in the returned dict get None and
    fall back to the uncached (subprocess-per-call) path, exactly as if no cache
    were built. This mirrors the existing fault-tolerance of the per-window
    functions (measure_join_jump_db, _snap_boundary_to_waveform) it replaces,
    so a fixture/test with a nonexistent media path degrades gracefully instead
    of raising during cache construction.
    """
    caches: dict[str, TrackAudioCache] = {}
    for tid in track_ids:
        if tid in caches:
            continue
        try:
            path = track_audio_path(project, tid)
            cache = scoped_by_file("track_audio_cache", path, None, partial(decode_track, path))
        except Exception as exc:
            log.debug("audio cache skipped for track %s: %s", tid, exc)
            continue
        caches[tid] = cache
    return caches
