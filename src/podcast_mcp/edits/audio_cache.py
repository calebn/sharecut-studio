from __future__ import annotations

import logging
import math
import subprocess
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cached_property

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import db_to_amplitude, frame_rms_db_stream, frame_speech_band_db
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

# Matches measure_window_rms_db's default (engines/audio_audit.py) -- used for
# RMS-based join-jump measurement (edits/cut_quality.py).
JUMP_SAMPLE_RATE = 8000
# Matches the existing boundary-snap/breath-detection resolution (edits/inaudible_cuts.py,
# edits/breath_detect.py) -- kept distinct from JUMP_SAMPLE_RATE so results are
# numerically identical to today's per-window ffmpeg reads, not just "close enough".
WAVEFORM_SAMPLE_RATE = 16000

# A level profile: 10 ms frames, the 10th percentile of the live (not digitally
# silent) frames as the room floor and the 90th as the speech level. Breath
# detection reads it from 5 s of kept audio either side of a cut (#814); the voice
# walks in edits/word_onset.py read it over the whole track (#1064).
LEVEL_FRAME_SEC = 0.01
DIGITAL_SILENCE_DB = -200.0
_MIN_LIVE_SEC = 0.5
_ROOM_PERCENTILE = 10.0
_SPEECH_PERCENTILE = 90.0
# A whole track is framed a minute at a time, never as one hour-long float64 copy.
_PROFILE_CHUNK_SEC = 60.0


def room_floor_db(
    levels: np.ndarray, *, among: np.ndarray | None = None, percentile: float = _ROOM_PERCENTILE
) -> float:
    """A low percentile of ``levels`` (the 10th by default) over the frames ``among`` selects.

    Every frame by default. Digital silence counts as a level, so a track a noise gate
    holds at zero between its words has digital silence for a room, and an ungated
    track has its room tone. ``among`` lets a caller read the room where the track is
    not sounding (between its own words) instead of over everything it did.
    """
    return float(np.percentile(levels if among is None else levels[among], percentile))


def speech_level_db(levels: np.ndarray, *, min_live_sec: float = _MIN_LIVE_SEC) -> float | None:
    """The speech level of ``levels``: the 90th percentile of the live frames.

    ``None`` when fewer than ``min_live_sec`` of them are live (any live frame counts for
    zero). Digital silence is the gate's, not the voice's, so it is left out.
    """
    live = levels[levels > DIGITAL_SILENCE_DB]
    if live.size == 0 or live.size < min_live_sec / LEVEL_FRAME_SEC:
        return None
    return float(np.percentile(live, _SPEECH_PERCENTILE))


def level_profile(
    samples: np.ndarray, sample_rate: int, *, whole_track: bool = False
) -> tuple[float, float] | None:
    """``(noise_floor_rms, speech_rms)`` of the live 10 ms frames, or ``None`` when too few.

    A ``whole_track`` profile reads the room over every frame, digital silence
    included: on a track a noise gate holds at digital zero between words (Zoom), the
    quietest live frames are the words' own soft edges, not a room. Any live audio is
    enough for it: its percentiles cover the whole recording, not a few seconds.
    """
    frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    chunk = frame * round(_PROFILE_CHUNK_SEC / LEVEL_FRAME_SEC)
    levels = frame_rms_db_stream(
        (samples[i : i + chunk] for i in range(0, samples.size, chunk)),
        frame,
        frame,
        floor_db=DIGITAL_SILENCE_DB,
    )
    speech_db = speech_level_db(levels, min_live_sec=0.0 if whole_track else _MIN_LIVE_SEC)
    if speech_db is None:
        return None
    floor_db = room_floor_db(levels, among=None if whole_track else levels > DIGITAL_SILENCE_DB)
    return db_to_amplitude(floor_db), db_to_amplitude(speech_db)


class BandLevels:
    """A track's 10 ms speech-band levels (:func:`frame_speech_band_db`), filtered once.

    Pause trims read the levels around each pause on every dialogue track, and the filter
    is an FFT over the window, so reading each window afresh costs more than the decision
    it feeds. The levels are made a block of ``_BLOCK_SEC`` at a time, from audio read with
    ``_MARGIN_SEC`` either side so the filter's ringing at a block's edge is trimmed away,
    and kept. ``read(start, duration)`` returns the track's mono samples at
    ``sample_rate``, and ``duration_sec`` is how long the track is (what :meth:`speech_db` reads
    to). Blocks are made under a lock, so concurrent candidates share them.
    """

    _BLOCK_SEC = 30.0
    _MARGIN_SEC = 1.0

    def __init__(
        self,
        read: Callable[[float, float], np.ndarray],
        sample_rate: int,
        duration_sec: float = 0.0,
    ) -> None:
        self._read = read
        self._duration_sec = duration_sec
        self._rate = sample_rate
        self._frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
        self._block = round(self._BLOCK_SEC / LEVEL_FRAME_SEC)
        self._margin = round(self._MARGIN_SEC / LEVEL_FRAME_SEC)
        self._blocks: dict[int, np.ndarray | None] = {}
        self._lock = threading.Lock()
        self._speech: float | None = None
        self._speech_read = False

    def _make(self, index: int) -> np.ndarray | None:
        first = index * self._block
        lead = min(first, self._margin)
        start = (first - lead) * LEVEL_FRAME_SEC
        duration = (self._block + lead + self._margin) * LEVEL_FRAME_SEC
        try:
            samples = self._read(start, duration)
        except (OSError, ValueError, subprocess.CalledProcessError):
            return None
        if not samples.size or not np.all(np.isfinite(samples)):
            return None
        levels = frame_speech_band_db(samples, self._rate, self._frame, floor_db=DIGITAL_SILENCE_DB)
        return levels[lead : lead + self._block].astype(np.float32)

    def _get(self, index: int) -> np.ndarray | None:
        if index not in self._blocks:
            with self._lock:
                if index not in self._blocks:
                    self._blocks[index] = self._make(index)
        return self._blocks[index]

    def speech_db(self) -> float | None:
        """The track's speech level: :func:`speech_level_db` over every frame of the track.

        One number per track, read once, so every pause trim classifies the same sound the
        same way whichever pause it asks about (a window's own frames would give a long
        pause and a short one two ceilings). ``None`` when the track has under half a
        second of live frames or cannot be read.
        """
        with self._lock:
            if not self._speech_read:
                self._speech_read = True
                self._speech = self._read_speech_db()
        return self._speech

    def _read_speech_db(self) -> float | None:
        # The lock is held, so the blocks are made here rather than through ``_get``.
        parts: list[np.ndarray] = []
        blocks = math.ceil(self._duration_sec / LEVEL_FRAME_SEC / self._block - 1e-9)
        for index in range(blocks):
            if index not in self._blocks:
                self._blocks[index] = self._make(index)
            block = self._blocks[index]
            if block is None:
                break
            parts.append(block)
            if block.size < self._block:
                break
        if not parts:
            return None
        return speech_level_db(np.concatenate(parts).astype(np.float64))

    def levels(self, start: float, end: float) -> np.ndarray | None:
        """The levels of frames ``[start, end)`` (the grid from ``floor(start / 10 ms)``).

        Shorter than asked where the audio ends, ``None`` when it cannot be read.
        """
        first = max(0, math.floor(start / LEVEL_FRAME_SEC + 1e-9))
        last = max(first, math.ceil(end / LEVEL_FRAME_SEC - 1e-9))
        parts: list[np.ndarray] = []
        for index in range(first // self._block, (last - 1) // self._block + 1):
            block = self._get(index)
            if block is None:
                return None
            parts.append(block[max(first - index * self._block, 0) : last - index * self._block])
            if block.size < self._block:
                break
        return np.concatenate(parts).astype(np.float64) if parts else np.empty(0)


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

    @cached_property
    def band_levels(self) -> BandLevels:
        """The track's speech-band levels, filtered once and shared by every candidate."""
        return BandLevels(
            lambda start, duration: self.window(start, start + duration),
            int(self.waveform.sample_rate),
            self.waveform.samples.size / self.waveform.sample_rate,
        )

    @cached_property
    def track_profile(self) -> tuple[float, float] | None:
        """The whole track's :func:`level_profile`, measured once."""
        return level_profile(
            self.waveform.samples, int(self.waveform.sample_rate), whole_track=True
        )


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
            cache = TrackAudioCache(
                jump=TrackRmsCache.from_timeline_stem(path, sample_rate=JUMP_SAMPLE_RATE),
                waveform=TrackRmsCache.from_timeline_stem(path, sample_rate=WAVEFORM_SAMPLE_RATE),
            )
        except Exception as exc:
            log.debug("audio cache skipped for track %s: %s", tid, exc)
            continue
        caches[tid] = cache
    return caches
