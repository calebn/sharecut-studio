from __future__ import annotations

import logging
import math
import subprocess
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cached_property
from typing import NamedTuple

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import (
    LOW_BAND,
    SPEECH_BAND,
    BandShape,
    db_to_amplitude,
    frame_band_filtered_db,
    frame_rms_db_stream,
)
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
_LOUD_PERCENTILE = 99.0
# A whole track is framed a minute at a time, never as one hour-long float64 copy.
_PROFILE_CHUNK_SEC = 60.0

# The voice floor, relative to the track's own room (p10) and speech (p90) levels,
# so a voice ends at the same sound at any recording level. Why 27 dB: docs/filler-cut-quality.md
# § Policy, Voice floor.
VOICE_FLOOR_UNDER_SPEECH_DB = 27.0
# Never closer than this to the room: on a noisy track the speech term alone sits in
# the room tone and finds no quiet at all. 6 dB clears the frame-to-frame flicker of
# steady room tone and stays under the 9.5 dB over the room where a breath begins
# (``breath_detect._BREATH_ABOVE_FLOOR_DB``), so a kept word's own breath never
# reads as quiet.
VOICE_FLOOR_OVER_ROOM_DB = 6.0


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


def frame_levels_db(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """The 10 ms frame levels (dBFS) of ``samples``, digital silence held at ``DIGITAL_SILENCE_DB``.

    The levels every :func:`level_profile` is read from, so a caller asking where a frame
    sits against a track's floor measures it as the floor was measured.
    """
    frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    chunk = frame * round(_PROFILE_CHUNK_SEC / LEVEL_FRAME_SEC)
    return frame_rms_db_stream(
        (samples[i : i + chunk] for i in range(0, samples.size, chunk)),
        frame,
        frame,
        floor_db=DIGITAL_SILENCE_DB,
    )


class LevelProfile(NamedTuple):
    """A track's linear RMS levels: its room, its speech, and its loudest frames.

    ``loud_rms`` (the 99th percentile of the live frames) is where a speaker who talks
    under a tenth of the time still shows their voice, when ``speech_rms`` (the 90th)
    is room tone.
    """

    noise_floor_rms: float
    speech_rms: float
    loud_rms: float


def level_profile(
    samples: np.ndarray, sample_rate: int, *, whole_track: bool = False
) -> LevelProfile | None:
    """The :class:`LevelProfile` of the live 10 ms frames, or ``None`` when too few.

    A ``whole_track`` profile reads the room over every frame, digital silence
    included: on a track a noise gate holds at digital zero between words (Zoom), the
    quietest live frames are the words' own soft edges, not a room. Any live audio is
    enough for it: its percentiles cover the whole recording, not a few seconds.
    """
    levels = frame_levels_db(samples, sample_rate)
    speech_db = speech_level_db(levels, min_live_sec=0.0 if whole_track else _MIN_LIVE_SEC)
    if speech_db is None:
        return None
    floor_db = room_floor_db(levels, among=None if whole_track else levels > DIGITAL_SILENCE_DB)
    loud_db = float(np.percentile(levels[levels > DIGITAL_SILENCE_DB], _LOUD_PERCENTILE))
    return LevelProfile(
        db_to_amplitude(floor_db), db_to_amplitude(speech_db), db_to_amplitude(loud_db)
    )


def speech_db_from_profile(profile: LevelProfile | None) -> float:
    """The speech level (dBFS) of a :func:`level_profile`; ``-inf`` without one."""
    return -math.inf if profile is None else 20.0 * math.log10(profile[1])


def voice_floor_from_profile(profile: LevelProfile | None) -> float:
    """The voice floor (dBFS) of a :func:`level_profile`: ``max(S - 27 dB, R + 6 dB)``.

    ``inf`` without a profile (no live audio): every frame is quiet.
    """
    if profile is None:
        return math.inf
    room_db, speech_db, _ = (20.0 * math.log10(rms) for rms in profile)
    return max(speech_db - VOICE_FLOOR_UNDER_SPEECH_DB, room_db + VOICE_FLOOR_OVER_ROOM_DB)


def audibility_floor_from_profile(profile: LevelProfile | None) -> float:
    """The level (dBFS) a word's own recording must reach to count as audible.

    The :func:`voice_floor_from_profile`, except where it cannot tell voice from room: a
    track whose loudest frames sit within 6 dB of its room has no quiet to find, and its
    floor would sit over its own speech and call every word of it inaudible. Such a
    track judges nothing inaudible (``-inf``). Contrast is read from the loudest frames,
    not the speech level, so a speaker who talks under a tenth of the time keeps a floor.
    A track with no live audio at all holds no word (``inf``).
    """
    if profile is None:
        return math.inf
    room_db = 20.0 * math.log10(profile.noise_floor_rms)
    loud_db = 20.0 * math.log10(profile.loud_rms)
    if loud_db <= room_db + VOICE_FLOOR_OVER_ROOM_DB:
        return -math.inf
    return voice_floor_from_profile(profile)


def voice_reach_from_profile(profile: LevelProfile | None) -> float:
    """The level (dBFS) the mean of a stretch of this track must reach to hold its voice.

    The :func:`audibility_floor_from_profile`, raised to no lower than 27 dB under the
    track's loudest frames: a speaker who talks under a tenth of the time has room tone
    for a speech level, and a floor under that would call the room a voice. ``-inf`` for a
    track with no contrast between its loudest frames and its room, ``inf`` for one with
    no live audio.
    """
    floor = audibility_floor_from_profile(profile)
    if profile is None or not math.isfinite(floor):
        return floor
    loud_db = 20.0 * math.log10(profile.loud_rms)
    return max(floor, loud_db - VOICE_FLOOR_UNDER_SPEECH_DB)


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

    @cached_property
    def track_profile(self) -> LevelProfile | None:
        """The whole track's :func:`level_profile`, measured once."""
        return self.waveform.track_profile

    @cached_property
    def speech_db(self) -> float:
        """The track's own speech level (dBFS): the 90th percentile of its live 10 ms frames.

        ``-inf`` on a track with no live audio.
        """
        return speech_db_from_profile(self.track_profile)

    @cached_property
    def voice_floor_db(self) -> float:
        """The level under which a frame of this track holds no voice (dBFS).

        ``max(S - 27 dB, R + 6 dB)`` for the track's speech level S and room R. Every
        tighten rule that asks whether a frame is quiet or audible reads this one
        floor, never a fixed dBFS level: tighten reads raw, unnormalized tracks, and
        a fixed floor moves its answers with the recording level. ``inf`` on a track
        with no live audio at all: every frame is digital silence, so every frame is
        quiet.
        """
        return self.waveform.voice_floor_db


_PROFILE_MEMO: dict[tuple[str, int, int], LevelProfile | None] = {}
_PROFILE_MEMO_LOCK = threading.Lock()


def track_level_profile(
    project: EpisodeProject, track_id: str, audio_cache: TrackAudioCache | None = None
) -> LevelProfile | None:
    """The track's whole-track :func:`level_profile`: ``audio_cache``'s, else measured once per file.

    Callers with no decode of the track (a cut re-optimized at approval, a natural-language
    edit) read the same levels the proposals did.
    """
    if audio_cache is not None:
        return audio_cache.track_profile
    path = track_audio_path(project, track_id)
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    with _PROFILE_MEMO_LOCK:
        if key in _PROFILE_MEMO:
            return _PROFILE_MEMO[key]
    waveform = TrackRmsCache.from_timeline_stem(path, sample_rate=WAVEFORM_SAMPLE_RATE)
    profile = level_profile(waveform.samples, int(waveform.sample_rate), whole_track=True)
    with _PROFILE_MEMO_LOCK:
        _PROFILE_MEMO[key] = profile
    return profile


def track_voice_floor_db(
    project: EpisodeProject, track_id: str, audio_cache: TrackAudioCache | None = None
) -> float:
    return voice_floor_from_profile(track_level_profile(project, track_id, audio_cache))


def track_audibility_floor_db(
    project: EpisodeProject, track_id: str, audio_cache: TrackAudioCache | None = None
) -> float:
    return audibility_floor_from_profile(track_level_profile(project, track_id, audio_cache))


def track_voice_reach_db(
    project: EpisodeProject, track_id: str, audio_cache: TrackAudioCache | None = None
) -> float:
    return voice_reach_from_profile(track_level_profile(project, track_id, audio_cache))


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
