"""A session's rooms and sounds, read once and asked for in session time (#1055).

A session ripple removes the same window of session time from every dialogue track, so
whether a window holds air is a question about every track at that time, the trim's own
included. Each track's lane puts its recordings on the session clock wherever ingest,
alignment or an earlier edit left them (``Placement``): holes, joins, offsets, replayed
stretches and clips from extra source recordings. A track is read through its own
placements and no other: a peer's sound is never mapped through the trim track's lane.

What a recording's levels say does not depend on who asks. Its room is read once, from the
frames where nobody in the session is speaking (``edits/room_model.py``); its speech level
from the frames inside its own transcript words; its sounds over the whole recording, in
two bands (the speech band, and a low band for the tonal tails and beats it cannot see).
:meth:`SessionAir.sounds_in` then lays the sounds of every placement under a window on the
session clock.
"""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import NamedTuple

import numpy as np

from podcast_mcp.edits.audio_cache import (
    LEVEL_FRAME_SEC,
    BandLevels,
    TrackAudioCache,
    speech_level_db,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.room_model import (
    BREATH_BELOW_SPEECH_DB,
    Sound,
    find_sounds,
    least_spread,
    merge_sounds,
    read_recording_room,
    smoothed,
)
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.models import Clip, EpisodeProject, Track, Transcript
from podcast_mcp.util.dsp import LOW_BAND, SPEECH_BAND, BandShape
from podcast_mcp.util.tracks import dialogue_track_ids
from podcast_mcp.util.workspace_paths import resolve_under_workspace

log = logging.getLogger(__name__)

# Words are padded by this much when the frames where nobody speaks are picked out: an
# ASR word ends a little before its voice does.
WORD_PAD_SEC = 0.05
# Two clocks that agree to a microsecond are the same instant (clip placements are floats).
_CLOCK_EPS_SEC = 1e-6
_BANDS: tuple[BandShape, ...] = (SPEECH_BAND, LOW_BAND)


class PauseAirSkip(Enum):
    """Why a pause trim has no span to give."""

    NO_AIR = "no_air"
    NO_ROOM = "no_room"


class SessionSound(NamedTuple):
    """A sound on the session clock, guard frames included."""

    lo: float
    hi: float
    removable: bool


@dataclass(frozen=True)
class Placement:
    """One stretch of a recording on the session clock: its audio plays from ``src_start``
    at ``tl_start`` until ``tl_end``. ``media`` is ``None`` when the file the render would
    play cannot be named."""

    track_id: str
    source_id: str | None
    media: Path | None
    tl_start: float
    tl_end: float
    src_start: float

    @property
    def src_end(self) -> float:
        return self.src_start + (self.tl_end - self.tl_start)

    def to_session(self, source_sec: float) -> float:
        return self.tl_start + (source_sec - self.src_start)

    def abuts(self, other: Placement) -> bool:
        """Whether ``other`` plays on from where this ends, in both clocks."""
        return (
            self.track_id == other.track_id
            and self.media == other.media
            and abs(self.tl_end - other.tl_start) < _CLOCK_EPS_SEC
            and abs(self.src_end - other.src_start) < _CLOCK_EPS_SEC
        )


def lane_placements(project: EpisodeProject, track: Track) -> list[Placement]:
    """The recordings a lane plays and where, in timeline order; abutting clips are one.

    A lane with no clips plays its media from the start of the session, as ingest places
    an un-clipped track. The media a clip plays is resolved as the render resolves it.
    """
    clips = sorted(
        (c for c in project.clips if c.track_id == track.id), key=lambda c: c.timeline_start
    )
    if not clips:
        if track.timeline_empty or track.media is None:
            return []
        return [Placement(track.id, None, primary_media(project, track), 0.0, math.inf, 0.0)]
    placements: list[Placement] = []
    for clip in clips:
        placement = _clip_placement(project, track, clip)
        if placements and placements[-1].abuts(placement):
            last = placements[-1]
            placements[-1] = Placement(
                last.track_id,
                last.source_id,
                last.media,
                last.tl_start,
                placement.tl_end,
                last.src_start,
            )
        else:
            placements.append(placement)
    return placements


def primary_media(project: EpisodeProject, track: Track) -> Path | None:
    """The track's own media file, resolved as the render resolves it; ``None`` when it
    has none or it lies outside the workspace."""
    if track.media is None:
        return None
    try:
        return resolve_under_workspace(project, track.media.path)
    except (OSError, ValueError):
        return None


def _clip_placement(project: EpisodeProject, track: Track, clip: Clip) -> Placement:
    # Imported here: the render module imports ``edits``, which imports this one.
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    try:
        media: Path | None = resolve_clip_audio_path(project, track, clip)
    except (OSError, ValueError):
        media = None
    return Placement(
        track.id, clip.source_id, media, clip.timeline_start, clip.timeline_end, clip.source_start
    )


def _frames_in(spans: list[tuple[float, float]], frames: int) -> np.ndarray:
    """The frames of a ``frames``-long grid whose centre lies inside any of ``spans``."""
    inside = np.zeros(frames + 1, dtype=np.int32)
    for lo, hi in spans:
        first = max(0, math.ceil(lo / LEVEL_FRAME_SEC - 0.5))
        last = min(frames, math.ceil(hi / LEVEL_FRAME_SEC - 0.5))
        if last > first:
            inside[first] += 1
            inside[last] -= 1
    return np.cumsum(inside[:frames]) > 0


class _Speaking:
    """The stretches of session time in which anyone is speaking: every dialogue recording's
    live words on the session clock, padded."""

    def __init__(self, spans: list[tuple[float, float]]) -> None:
        merged: list[list[float]] = []
        for lo, hi in sorted(spans):
            if merged and lo <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])
        self._starts = np.array([m[0] for m in merged])
        self._ends = np.array([m[1] for m in merged])

    def covers(self, times: np.ndarray) -> np.ndarray:
        if self._starts.size == 0:
            return np.zeros(times.shape, dtype=bool)
        at = np.searchsorted(self._starts, times, side="right") - 1
        return (at >= 0) & (times < self._ends[np.maximum(at, 0)])


class _Reading:
    """One recording's speech level, room and sounds, over the whole recording."""

    def __init__(self, speech_db: float | None, sounds: list[Sound]) -> None:
        self.speech_db = speech_db
        self._lo = np.array([s.lo for s in sounds], dtype=np.float64) * LEVEL_FRAME_SEC
        self._hi = np.array([s.hi for s in sounds], dtype=np.float64) * LEVEL_FRAME_SEC
        self._removable = [s.removable for s in sounds]

    def between(self, lo_sec: float, hi_sec: float) -> list[tuple[float, float, bool]]:
        """The sounds touching ``[lo_sec, hi_sec)`` of the recording's own seconds, as seconds."""
        first = int(np.searchsorted(self._hi, lo_sec, side="right"))
        last = int(np.searchsorted(self._lo, hi_sec, side="left"))
        return [
            (float(self._lo[i]), float(self._hi[i]), self._removable[i]) for i in range(first, last)
        ]


class _Recording:
    """One media file played by one track's lane."""

    def __init__(
        self,
        air: SessionAir,
        track_id: str,
        source_id: str | None,
        media: Path | None,
        placements: list[Placement],
    ) -> None:
        self._air = air
        self.track_id = track_id
        self.source_id = source_id
        self.media = media
        self.placements = placements
        self._lock = threading.Lock()
        self._done = False
        self._reading: _Reading | PauseAirSkip | None = None

    def words(self) -> CutWordIndex:
        return self._air.word_index(self.track_id, self.source_id, self.media)

    def live_word_spans(self) -> list[tuple[float, float]]:
        return list(self.words().live_spans)

    def reading(self) -> _Reading | PauseAirSkip:
        with self._lock:
            if not self._done:
                self._reading = self._read()
                self._done = True
        assert self._reading is not None
        return self._reading

    def _band_levels(self, band: BandShape) -> BandLevels | None:
        return self._air.band_levels(self.track_id, self.media, band)

    def _read(self) -> _Reading | PauseAirSkip:
        spans = self.live_word_spans()
        sounds: list[Sound] = []
        speech_db: float | None = None
        for band in _BANDS:
            bands = self._band_levels(band)
            levels = None if bands is None else bands.all_levels()
            if levels is None:
                return PauseAirSkip.NO_ROOM
            in_words = _frames_in(spans, levels.size)
            padded = _frames_in(
                [(a - WORD_PAD_SEC, b + WORD_PAD_SEC) for a, b in spans], levels.size
            )
            level_speech = speech_level_db(levels[in_words])
            smooth = smoothed(levels)
            ceiling = math.inf if level_speech is None else level_speech - BREATH_BELOW_SPEECH_DB[1]
            least = least_spread(self._air.sample_rate, band)
            silent = self._air.session_silent_frames(self, levels.size)
            read = read_recording_room(smooth, silent, ~padded, least, ceiling)
            if read is None:
                return PauseAirSkip.NO_ROOM
            room, _basis = read
            sounds += find_sounds(
                levels,
                room,
                level_speech,
                least,
                breath_below_speech_db=BREATH_BELOW_SPEECH_DB,
                gate_on_speech=band is SPEECH_BAND,
            )
            if band is SPEECH_BAND:
                speech_db = level_speech
        return _Reading(speech_db, merge_sounds(sounds))


class SessionAir:
    """The rooms and sounds of every dialogue recording in a project, read once, lazily.

    Built once per proposal run and shared by every candidate (and thread): what a
    recording's levels say is read on first use under a lock and kept. ``audio_caches``
    are the run's decoded tracks, ``word_indexes`` their transcripts' word indexes; a
    recording without either is read from its file.
    """

    def __init__(
        self,
        project: EpisodeProject,
        *,
        audio_caches: Mapping[str, TrackAudioCache] | None = None,
        word_indexes: Mapping[str, CutWordIndex] | None = None,
        sample_rate: int = 16000,
    ) -> None:
        self._project = project
        self._caches = audio_caches or {}
        self._word_indexes = word_indexes or {}
        self.sample_rate = sample_rate
        self._lock = threading.RLock()
        self._levels: dict[tuple[str, Path | None, str], BandLevels | None] = {}
        self._words: dict[tuple[str, str | None, Path | None], CutWordIndex] = {}
        self._speaking: _Speaking | None = None
        self._lanes: dict[str, list[tuple[Placement, _Recording]]] = {}
        recordings: dict[tuple[str, Path | None], _Recording] = {}
        for track in project.tracks:
            if track.id not in dialogue_track_ids(project):
                continue
            by_media: dict[tuple[str, Path | None], list[Placement]] = {}
            for placement in lane_placements(project, track):
                by_media.setdefault((track.id, placement.media), []).append(placement)
            lane: list[tuple[Placement, _Recording]] = []
            for key, placed in by_media.items():
                recording = _Recording(self, key[0], placed[0].source_id, key[1], placed)
                recordings[key] = recording
                lane += [(p, recording) for p in placed]
            self._lanes[track.id] = sorted(lane, key=lambda pair: pair[0].tl_start)
        self._recordings = recordings

    # --- inputs a recording asks of the session ---------------------------------------

    def word_index(self, track_id: str, source_id: str | None, media: Path | None) -> CutWordIndex:
        """The words of the recording ``track_id`` plays from ``media``.

        The track's own transcript covers its primary media; another recording has the
        transcript of that source (:meth:`EpisodeProject.transcript_for_source`), or none.
        """
        key = (track_id, source_id, media)
        with self._lock:
            if key not in self._words:
                self._words[key] = self._build_words(track_id, source_id, media)
            return self._words[key]

    def _build_words(
        self, track_id: str, source_id: str | None, media: Path | None
    ) -> CutWordIndex:
        if media is not None and media == self._primary_media(track_id):
            return self._word_indexes.get(track_id) or CutWordIndex.build(self._project, track_id)
        transcript: Transcript | None = (
            None if source_id is None else self._project.transcript_for_source(track_id, source_id)
        )
        return CutWordIndex.from_transcript(transcript, track_id)

    def _primary_media(self, track_id: str) -> Path | None:
        track = self._project.track_by_id(track_id)
        return None if track is None else primary_media(self._project, track)

    def band_levels(self, track_id: str, media: Path | None, band: BandShape) -> BandLevels | None:
        """The levels of ``media`` through ``band``: the run's decode of the track's own
        media when it has one, else the file read afresh."""
        key = (track_id, media, "low" if band is LOW_BAND else "speech")
        with self._lock:
            if key not in self._levels:
                self._levels[key] = self._make_levels(track_id, media, band)
            return self._levels[key]

    def _make_levels(self, track_id: str, media: Path | None, band: BandShape) -> BandLevels | None:
        cache = self._caches.get(track_id)
        if (
            cache is not None
            and media is not None
            and media == self._primary_media(track_id)
            and int(cache.waveform.sample_rate) == self.sample_rate
        ):
            return cache.low_band_levels if band is LOW_BAND else cache.band_levels
        if media is None:
            return None
        return BandLevels(_file_reader(media, self.sample_rate), self.sample_rate, band)

    def _speaking_union(self) -> _Speaking:
        with self._lock:
            if self._speaking is None:
                self._speaking = self._build_speaking()
            return self._speaking

    def _build_speaking(self) -> _Speaking:
        spans: list[tuple[float, float]] = []
        for recording in self._recordings.values():
            words = np.array(recording.live_word_spans(), dtype=np.float64).reshape(-1, 2)
            for p in recording.placements:
                heard = words[(words[:, 1] > p.src_start) & (words[:, 0] < p.src_end)]
                spans += [
                    (
                        p.to_session(max(a, p.src_start)) - WORD_PAD_SEC,
                        p.to_session(min(b, p.src_end)) + WORD_PAD_SEC,
                    )
                    for a, b in heard
                ]
        return _Speaking(spans)

    def session_silent_frames(self, recording: _Recording, frames: int) -> np.ndarray:
        """Which of the first ``frames`` frames of ``recording`` are played while nobody speaks.

        A frame is on the session clock at every placement of the recording that covers
        it; it is silent only if nobody speaks at any of them. A frame no placement plays
        is not in the session at all.
        """
        speaking = self._speaking_union()
        images = np.zeros(frames, dtype=np.int32)
        quiet = np.zeros(frames, dtype=np.int32)
        for p in recording.placements:
            hi_src = min(p.src_end, frames * LEVEL_FRAME_SEC)
            first = max(0, math.ceil(p.src_start / LEVEL_FRAME_SEC - 0.5))
            last = min(frames, math.ceil(hi_src / LEVEL_FRAME_SEC - 0.5))
            if last <= first:
                continue
            centres = p.tl_start + ((np.arange(first, last) + 0.5) * LEVEL_FRAME_SEC - p.src_start)
            images[first:last] += 1
            quiet[first:last] += ~speaking.covers(centres)
        return (images > 0) & (quiet == images)

    # --- the question ------------------------------------------------------------------

    def _lane(self, track_id: str) -> list[tuple[Placement, _Recording]]:
        return self._lanes.get(track_id, [])

    def sounds_in(
        self, lo: float, hi: float, *, needs_speech: str | None = None
    ) -> list[SessionSound] | PauseAirSkip:
        """Every dialogue track's sounds under the session window ``[lo, hi)``.

        A track is read through its own placements: the stretch of each recording that
        plays under the window, at the seconds that back it. Where a lane plays nothing
        the track has no audio and no sound. A sound a placement's edge cuts reaches one
        frame past the edge, so an edge at the join is inside it, not beside it.
        :attr:`PauseAirSkip.NO_ROOM` when any recording under the window cannot be read or has
        no room to read, or when track ``needs_speech`` plays one with no speech level (a
        track a trim is cut from must have something to protect).
        """
        dt = LEVEL_FRAME_SEC
        out: list[SessionSound] = []
        for tid in self._lanes:
            for placement, recording in self._lane(tid):
                if not _overlaps(placement, lo - dt, hi + dt):
                    continue
                reading = recording.reading()
                if isinstance(reading, PauseAirSkip):
                    return reading
                if tid == needs_speech and reading.speech_db is None:
                    return PauseAirSkip.NO_ROOM
                src_lo = placement.src_start + (
                    max(lo - dt, placement.tl_start) - placement.tl_start
                )
                src_hi = placement.src_start + (min(hi + dt, placement.tl_end) - placement.tl_start)
                for a, b, removable in reading.between(src_lo, src_hi):
                    start, end = placement.to_session(a), placement.to_session(b)
                    if min(end, placement.tl_end) <= max(start, placement.tl_start):
                        continue
                    cut_lo = start < placement.tl_start - _CLOCK_EPS_SEC
                    cut_hi = end > placement.tl_end + _CLOCK_EPS_SEC
                    out.append(
                        SessionSound(
                            placement.tl_start - dt if cut_lo else start,
                            placement.tl_end + dt if cut_hi else end,
                            removable,
                        )
                    )
        return out


def _overlaps(placement: Placement, lo: float, hi: float) -> bool:
    return placement.tl_start < hi and placement.tl_end > lo


def _file_reader(media: Path, sample_rate: int) -> Callable[[float, float], np.ndarray]:
    return lambda start, duration: load_mono_window(
        media, start_sec=start, duration_sec=duration, sample_rate=sample_rate
    )
