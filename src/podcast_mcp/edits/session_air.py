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
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import NamedTuple

import numpy as np

from podcast_mcp.edits.audio_cache import (
    DIGITAL_SILENCE_DB,
    LEVEL_FRAME_SEC,
    BandLevels,
    TrackAudioCache,
    speech_level_db,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    sample_mute_envelopes,
)
from podcast_mcp.edits.room_model import (
    BREATH_BELOW_SPEECH_DB,
    SMOOTH_SEC,
    Sound,
    find_sounds,
    least_spread,
    merge_sounds,
    read_recording_room,
    read_unwatched_room,
    smoothed,
    sound_reach,
)
from podcast_mcp.edits.word_onset import voice_end, voice_onset
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.models import Clip, EpisodeProject, Track
from podcast_mcp.util.dsp import LOW_BAND, SPEECH_BAND, BandShape, frame_band_filtered_db
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.media_identity import same_recording
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
class PauseActivity:
    """One actual recording's content at its current lane placement."""

    track_id: str
    source_id: str | None
    media: Path | None
    lo: float
    hi: float


@dataclass(frozen=True)
class GeometricPause:
    """Geometric pause policy with independent kept-voice protection, without room proof."""

    activity: tuple[PauseActivity, ...]


@dataclass(frozen=True)
class MeasuredPause:
    """Placed content observed from kept voices and the same recording's two-band room."""

    activity: tuple[PauseActivity, ...]


@dataclass(frozen=True)
class _BandObservation:
    levels: np.ndarray
    reach: np.ndarray


@dataclass(frozen=True)
class _VoiceAnchors:
    onset: float | None
    release: float | None


class _CollarVerdict(Enum):
    QUIET = "quiet"
    ELEVATED = "elevated"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class _OriginalCorridor:
    first_source_frame: int
    smoothed_levels: tuple[np.ndarray, ...]
    original_reach: tuple[np.ndarray, ...]

    def collar(self, lo: float, hi: float) -> _CollarVerdict:
        if not math.isfinite(lo) or not math.isfinite(hi):
            return _CollarVerdict.UNAVAILABLE
        first, last = round(lo / LEVEL_FRAME_SEC), round(hi / LEVEL_FRAME_SEC)
        if (
            abs(first * LEVEL_FRAME_SEC - lo) > _CLOCK_EPS_SEC
            or abs(last * LEVEL_FRAME_SEC - hi) > _CLOCK_EPS_SEC
            or last - first < round(SMOOTH_SEC / LEVEL_FRAME_SEC)
        ):
            return _CollarVerdict.UNAVAILABLE
        first -= self.first_source_frame
        last -= self.first_source_frame
        if first < 0 or last > self.smoothed_levels[0].size:
            return _CollarVerdict.UNAVAILABLE
        quiet = all(
            np.all(levels[first:last] <= reach[first:last])
            for levels, reach in zip(self.smoothed_levels, self.original_reach, strict=True)
        )
        return _CollarVerdict.QUIET if quiet else _CollarVerdict.ELEVATED


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
    excluded_word_spans: tuple[tuple[float, float], ...] = ()

    @property
    def src_end(self) -> float:
        return self.src_start + (self.tl_end - self.tl_start)

    def to_session(self, source_sec: float) -> float:
        return self.tl_start + (source_sec - self.src_start)

    def to_source(self, session_sec: float) -> float:
        return self.src_start + (session_sec - self.tl_start)

    def abuts(self, other: Placement) -> bool:
        """Whether ``other`` plays on from where this ends, in both clocks."""
        return (
            self.track_id == other.track_id
            and self.source_id == other.source_id
            and self.media is not None
            and other.media is not None
            and same_recording(self.media, other.media)
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
    ignored = IgnoredWordRegions(project)
    sample_rates: dict[Path, int | None] = {}
    if not clips:
        if track.timeline_empty or track.media is None:
            return []
        clips = [
            Clip(
                id="implicit",
                track_id=track.id,
                source_start=0.0,
                source_end=math.inf,
                timeline_start=0.0,
            )
        ]
    placements: list[Placement] = []
    for clip in clips:
        placement = _clip_placement(project, track, clip, ignored, sample_rates)
        if placements and placements[-1].abuts(placement):
            last = placements[-1]
            placements[-1] = Placement(
                last.track_id,
                last.source_id,
                last.media,
                last.tl_start,
                placement.tl_end,
                last.src_start,
                tuple(merge_intervals((*last.excluded_word_spans, *placement.excluded_word_spans))),
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


def _clip_placement(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
    ignored: IgnoredWordRegions,
    sample_rates: dict[Path, int | None],
) -> Placement:
    # Imported here: the render module imports ``edits``, which imports this one.
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    try:
        media: Path | None = resolve_clip_audio_path(project, track, clip)
    except (OSError, ValueError):
        media = None
    ignored_regions = ignored.for_clip(clip)
    excluded: list[tuple[float, float]] = []
    envelopes = mute_spans_for_source_window(
        clip, clip.source_start, clip.source_end, ignored_regions
    )
    if envelopes:
        if media is not None and media not in sample_rates:
            info = probe_media(media)
            sample_rates[media] = info.sample_rate if info is not None else None
        rate = sample_rates.get(media) if media is not None else None
        if rate is None:
            excluded = [(clip.source_start, clip.source_end)]
        else:
            samples = sample_mute_envelopes(
                envelopes, clip.source_end - clip.source_start, rate, source_start=clip.source_start
            )
            for index, sample in enumerate(samples):
                first, last = sample.silent_span()
                if index + 1 < len(samples):
                    last = min(last, samples[index + 1].first)
                if last > first:
                    excluded.append((first / rate, last / rate))
    bounded = tuple(
        merge_intervals(
            (max(lo, clip.source_start), min(hi, clip.source_end))
            for lo, hi in excluded
            if hi > clip.source_start and lo < clip.source_end
        )
    )
    return Placement(
        track.id,
        clip.source_id,
        media,
        clip.timeline_start,
        clip.timeline_end,
        clip.source_start,
        bounded,
    )


def lane_window(
    project: EpisodeProject, track: Track, lo: float, hi: float, sample_rate: int
) -> np.ndarray:
    """What ``track``'s lane plays over session ``[lo, hi)``, as mono samples at ``sample_rate``.

    Each placement's recording is read at the seconds that back it and laid where it plays;
    where the lane plays nothing the window is silence. Raises when a recording under the
    window cannot be named or read.
    """
    out = np.zeros(max(0, round((hi - lo) * sample_rate)), dtype=np.float32)
    for placement in lane_placements(project, track):
        start, end = max(lo, placement.tl_start), min(hi, placement.tl_end)
        if end <= start:
            continue
        if placement.media is None:
            raise FileNotFoundError(f"track {track.id!r} plays a recording that cannot be named")
        chunk = load_mono_window(
            placement.media,
            start_sec=placement.src_start + (start - placement.tl_start),
            duration_sec=end - start,
            sample_rate=sample_rate,
        )
        at = round((start - lo) * sample_rate)
        out[at : at + chunk.size] += chunk[: out.size - at]
    return out


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

    def gap_around(self, lo: float, hi: float) -> float | None:
        """The length of the stretch around ``[lo, hi)`` in which nobody speaks, from the end of
        the last span before it to the start of the first after; ``None`` when a span overlaps
        it or none follows."""
        before = int(np.searchsorted(self._ends, lo + _CLOCK_EPS_SEC, side="right"))
        after = int(np.searchsorted(self._starts, hi - _CLOCK_EPS_SEC, side="left"))
        if before != after or after >= self._starts.size:
            return None
        return float(self._starts[after] - (self._ends[before - 1] if before else 0.0))

    def covers(self, times: np.ndarray) -> np.ndarray:
        if self._starts.size == 0:
            return np.zeros(times.shape, dtype=bool)
        at = np.searchsorted(self._starts, times, side="right") - 1
        return (at >= 0) & (times < self._ends[np.maximum(at, 0)])


class _Reading:
    """One recording's speech level, room and sounds, over the whole recording."""

    def __init__(
        self,
        speech_db: float | None,
        sounds: list[Sound],
        bands: tuple[_BandObservation, ...],
    ) -> None:
        self.speech_db = speech_db
        self.bands = bands
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

    def live_word_spans(self, *, audible: bool = False) -> list[tuple[float, float]]:
        if audible:
            transcript = self._air._project.transcript_for_source(self.track_id, self.source_id)
            if transcript is not None:
                return [
                    (float(word.start), float(word.end))
                    for word in transcript.words
                    if not word.suppressed and not word.ignored and word.end > word.start
                ]
        return list(self.words().live_spans)

    def voice_anchors(self, start: float, end: float) -> _VoiceAnchors:
        cache = self._air.recording_cache(self.media)
        if cache is None or cache.waveform.timeline_offset_sec != 0.0:
            return _VoiceAnchors(None, None)
        spans = self.live_word_spans()
        floor = max((b for a, b in spans if b <= start), default=0.0)
        ceiling = min(
            (a for a, b in spans if a >= end),
            default=cache.waveform.samples.size / int(cache.waveform.sample_rate),
        )
        return _VoiceAnchors(voice_onset(cache, start, floor), voice_end(cache, end, ceiling))

    def _original_samples(self, lo: float, hi: float) -> np.ndarray | None:
        cache = self._air.recording_cache(self.media)
        if (
            cache is None
            or cache.waveform.timeline_offset_sec != 0.0
            or not math.isfinite(lo)
            or not math.isfinite(hi)
        ):
            return None
        rate = self._air.sample_rate
        frame = round(rate * LEVEL_FRAME_SEC)
        first, last = round(lo / LEVEL_FRAME_SEC), round(hi / LEVEL_FRAME_SEC)
        if (
            frame < 1
            or abs(frame - rate * LEVEL_FRAME_SEC) > _CLOCK_EPS_SEC
            or abs(first * LEVEL_FRAME_SEC - lo) > _CLOCK_EPS_SEC
            or abs(last * LEVEL_FRAME_SEC - hi) > _CLOCK_EPS_SEC
            or first < 0
            or last <= first
            or last * frame > cache.waveform.samples.size
        ):
            return None
        samples = cache.waveform.samples[first * frame : last * frame]
        if (
            samples.ndim != 1
            or samples.dtype != np.float32
            or samples.size != (last - first) * frame
            or not np.all(np.isfinite(samples))
            or np.any(np.abs(samples) >= 32766 / 32768)
        ):
            return None
        return samples

    def _corridor(
        self, reading: _Reading, release: float | None, onset: float | None
    ) -> _OriginalCorridor | None:
        if release is None or onset is None:
            return None
        samples = self._original_samples(release, onset)
        if samples is None or len(reading.bands) != len(_BANDS):
            return None
        first = round(release / LEVEL_FRAME_SEC)
        last = round(onset / LEVEL_FRAME_SEC)
        if last - first < round(SMOOTH_SEC / LEVEL_FRAME_SEC):
            return None
        smooth_bands: list[np.ndarray] = []
        reaches: list[np.ndarray] = []
        for band, observation in zip(_BANDS, reading.bands, strict=True):
            reach = observation.reach[first:last].copy()
            if reach.size != last - first or not np.all(np.isfinite(reach)):
                return None
            levels = (
                frame_band_filtered_db(
                    samples,
                    self._air.sample_rate,
                    round(self._air.sample_rate * LEVEL_FRAME_SEC),
                    band,
                    floor_db=DIGITAL_SILENCE_DB,
                )
                .astype(np.float32)
                .astype(np.float64)
            )
            smooth = smoothed(levels)
            if smooth.size != reach.size or not np.all(np.isfinite(smooth)):
                return None
            smooth.flags.writeable = False
            reach.flags.writeable = False
            smooth_bands.append(smooth)
            reaches.append(reach)
        return _OriginalCorridor(first, tuple(smooth_bands), tuple(reaches))

    def content_span(
        self, reading: _Reading, lo: float, hi: float, *, placement: Placement
    ) -> tuple[float, float]:
        spans = self.live_word_spans()
        words = [(a, b) for a, b in spans if a < hi and b > lo]
        if not words:
            return lo, hi
        if (
            not self._air._unique_guard(self, placement, lo, hi)
            or self._original_samples(lo, hi) is None
        ):
            return lo, hi
        first_word = min(words, key=lambda word: word[0])
        last_word = max(words, key=lambda word: word[1])
        onset = self.voice_anchors(*first_word).onset
        release = self.voice_anchors(*last_word).release
        start, end = lo, hi
        if onset is not None:
            start = min(lo, onset)
            previous = max(
                (word for word in spans if word[1] <= first_word[0]),
                key=lambda word: word[1],
                default=None,
            )
            previous_release = None if previous is None else self.voice_anchors(*previous).release
            leading = self._corridor(reading, previous_release, onset)
            if (
                lo < onset < hi
                and leading is not None
                and leading.collar(lo, onset) is _CollarVerdict.QUIET
            ):
                start = onset
        if release is not None:
            end = max(hi, release)
            following = min(
                (word for word in spans if word[0] >= last_word[1]),
                key=lambda word: word[0],
                default=None,
            )
            next_onset = None if following is None else self.voice_anchors(*following).onset
            trailing = self._corridor(reading, release, next_onset)
            if (
                lo < release < hi
                and trailing is not None
                and trailing.collar(release, hi) is _CollarVerdict.QUIET
            ):
                end = release
        return start, end

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
        observations: list[_BandObservation] = []
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
            least = least_spread(self._air.sample_rate, band)
            sound_speech: float | None
            if level_speech is not None:
                ceiling = level_speech - BREATH_BELOW_SPEECH_DB[1]
                silent = self._air.session_silent_frames(self, levels.size)
                read = read_recording_room(smooth, silent, ~padded, least, ceiling)
                sound_speech = level_speech
            else:
                # No words to say when this recording speaks: its own speech is in every
                # frame the session calls quiet, so its room is read from its own levels,
                # and its speech level from all of them.
                sound_speech = speech_level_db(levels)
                read = read_unwatched_room(smooth, least, sound_speech)
            if read is None:
                return PauseAirSkip.NO_ROOM
            room, _basis = read
            observations.append(_BandObservation(levels, sound_reach(levels, room, least)))
            sounds += find_sounds(
                levels,
                room,
                sound_speech,
                least,
                breath_below_speech_db=BREATH_BELOW_SPEECH_DB,
                gate_on_speech=band is SPEECH_BAND,
            )
            if band is SPEECH_BAND:
                speech_db = level_speech
        return _Reading(speech_db, merge_sounds(sounds), tuple(observations))


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
        self._speaking: dict[float, _Speaking] = {}
        self._calibration_speaking: _Speaking | None = None
        self._lanes: dict[str, list[tuple[Placement, _Recording]]] = {}
        recordings: dict[tuple[str, int], _Recording] = {}
        for track in project.tracks:
            if track.id not in dialogue_track_ids(project):
                continue
            groups: list[_Recording] = []
            for placement in lane_placements(project, track):
                group = next(
                    (
                        candidate
                        for candidate in groups
                        if candidate.source_id == placement.source_id
                        and candidate.media is not None
                        and placement.media is not None
                        and same_recording(candidate.media, placement.media)
                    ),
                    None,
                )
                if group is None:
                    group = _Recording(self, track.id, placement.source_id, placement.media, [])
                    groups.append(group)
                group.placements.append(placement)
            lane: list[tuple[Placement, _Recording]] = []
            for index, recording in enumerate(groups):
                recordings[(track.id, index)] = recording
                lane += [(p, recording) for p in recording.placements]
            self._lanes[track.id] = sorted(lane, key=lambda pair: pair[0].tl_start)
        self._recordings = recordings

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
        transcript = self._project.transcript_for_source(track_id, source_id)
        if source_id is None:
            if self._project.transcript_for_track(track_id) is transcript:
                cached = self._word_indexes.get(track_id)
                if cached is not None:
                    return cached
            return CutWordIndex.from_transcript(transcript, track_id)
        if transcript is not None:
            return CutWordIndex.from_transcript(transcript, track_id)
        origins = [
            track.id
            for track in self._project.tracks
            if media is not None
            and (primary := primary_media(self._project, track)) is not None
            and same_recording(media, primary)
        ]
        if len(origins) > 1:
            raise ValueError("selected source has ambiguous primary transcript ownership")
        if origins:
            return CutWordIndex.from_transcript(
                self._project.transcript_for_source(origins[0], None), track_id
            )
        return CutWordIndex.from_transcript(None, track_id)

    def _origin_track(self, media: Path | None) -> str | None:
        return next(
            (
                track.id
                for track in self._project.tracks
                if media is not None
                and (primary := primary_media(self._project, track)) is not None
                and same_recording(media, primary)
            ),
            None,
        )

    def recording_cache(self, media: Path | None) -> TrackAudioCache | None:
        """The run's decode of this actual primary recording, including parked placements."""
        origin = self._origin_track(media)
        cache = self._caches.get(origin) if origin is not None else None
        return (
            cache
            if cache is not None and int(cache.waveform.sample_rate) == self.sample_rate
            else None
        )

    def band_levels(self, track_id: str, media: Path | None, band: BandShape) -> BandLevels | None:
        """The levels of ``media`` through ``band``: the run's decode of the track's own
        media when it has one, else the file read afresh."""
        key = (track_id, media, "low" if band is LOW_BAND else "speech")
        with self._lock:
            if key not in self._levels:
                self._levels[key] = self._make_levels(media, band)
            return self._levels[key]

    def _make_levels(self, media: Path | None, band: BandShape) -> BandLevels | None:
        cache = self.recording_cache(media)
        if cache is not None:
            return cache.low_band_levels if band is LOW_BAND else cache.band_levels
        if media is None:
            return None
        return BandLevels(_file_reader(media, self.sample_rate), self.sample_rate, band)

    def _speaking_union(self, pad: float = WORD_PAD_SEC) -> _Speaking:
        with self._lock:
            if pad not in self._speaking:
                self._speaking[pad] = self._build_speaking(pad)
            return self._speaking[pad]

    def placed_word_spans(self) -> Iterator[tuple[float, float, str]]:
        """Audible transcript words on each recording's current playback lane clock."""
        return self._placed_word_spans(audible=True)

    def _placed_word_spans(self, *, audible: bool) -> Iterator[tuple[float, float, str]]:
        for recording in self._recordings.values():
            words = np.array(recording.live_word_spans(audible=audible), dtype=np.float64).reshape(
                -1, 2
            )
            for placement in recording.placements:
                heard = words[
                    (words[:, 1] > placement.src_start) & (words[:, 0] < placement.src_end)
                ]
                for start, end in heard:
                    spans = [(max(start, placement.src_start), min(end, placement.src_end))]
                    if audible:
                        spans = subtract_intervals(spans, placement.excluded_word_spans)
                    for lo, hi in spans:
                        yield placement.to_session(lo), placement.to_session(hi), placement.track_id

    def _build_speaking(self, pad: float) -> _Speaking:
        return _Speaking([(lo - pad, hi + pad) for lo, hi, _track in self.placed_word_spans()])

    def silence_around(self, lo: float, hi: float) -> float | None:
        """How long nobody speaks around session ``[lo, hi)``: from the end of the last live
        word of any dialogue recording before it to the start of the first after it. The
        pause a listener hears a trim in it shorten. ``None`` when a word overlaps it or
        none follows."""
        return self._speaking_union(0.0).gap_around(lo, hi)

    def session_silent_frames(self, recording: _Recording, frames: int) -> np.ndarray:
        """Which of the first ``frames`` frames of ``recording`` are played while nobody speaks.

        A frame is on the session clock at every placement of the recording that covers
        it; it is silent only if nobody speaks at any of them. A frame no placement plays
        is not in the session at all.
        """
        with self._lock:
            if self._calibration_speaking is None:
                self._calibration_speaking = _Speaking(
                    [
                        (lo - WORD_PAD_SEC, hi + WORD_PAD_SEC)
                        for lo, hi, _track in self._placed_word_spans(audible=False)
                    ]
                )
            speaking = self._calibration_speaking
        images = np.zeros(frames, dtype=np.int32)
        quiet = np.zeros(frames, dtype=np.int32)
        placements = (
            p
            for lane in self._lanes.values()
            for p, other in lane
            if recording.media is not None
            and other.media is not None
            and same_recording(recording.media, other.media)
        )
        for p in placements:
            hi_src = min(p.src_end, frames * LEVEL_FRAME_SEC)
            first = max(0, math.ceil(p.src_start / LEVEL_FRAME_SEC - 0.5))
            last = min(frames, math.ceil(hi_src / LEVEL_FRAME_SEC - 0.5))
            if last <= first:
                continue
            centres = p.tl_start + ((np.arange(first, last) + 0.5) * LEVEL_FRAME_SEC - p.src_start)
            images[first:last] += 1
            quiet[first:last] += ~speaking.covers(centres)
        return (images > 0) & (quiet == images)

    def _lane(self, track_id: str) -> list[tuple[Placement, _Recording]]:
        return self._lanes.get(track_id, [])

    def _unique_guard(
        self, recording: _Recording, placement: Placement, lo: float, hi: float
    ) -> bool:
        if (
            recording.media is None
            or lo < placement.src_start - _CLOCK_EPS_SEC
            or hi > placement.src_end + _CLOCK_EPS_SEC
        ):
            return False
        images = [
            placed
            for lane in self._lanes.values()
            for placed, other in lane
            if other.media is not None
            and same_recording(other.media, recording.media)
            and max(lo, placed.src_start) < min(hi, placed.src_end)
        ]
        return len(images) == 1 and images[0] is placement

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
                src_lo = placement.to_source(max(lo - dt, placement.tl_start))
                src_hi = placement.to_source(min(hi + dt, placement.tl_end))
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

    def pause_observation(
        self, lo: float, hi: float, *, acoustic: bool
    ) -> GeometricPause | MeasuredPause | PauseAirSkip:
        """Observe content for pause retention and effects without changing guarded sounds.

        Acoustic collars require the same recording's measured kept voice and absence
        of elevated room activity in both bands. Incomplete or clipped evidence keeps
        the guard. Geometric mode reads no room and protects kept voices independently.
        """
        out: list[PauseActivity] = []
        dt = LEVEL_FRAME_SEC
        for lane in self._lanes.values():
            for placement, recording in lane:
                if not _overlaps(placement, lo - dt, hi + dt):
                    continue
                if not acoustic:
                    for a, b in recording.live_word_spans():
                        if a >= placement.src_end or b <= placement.src_start:
                            continue
                        voice = recording.voice_anchors(a, b)
                        start = placement.src_start if voice.onset is None else voice.onset
                        end = placement.src_end if voice.release is None else voice.release
                        start, end = placement.to_session(start), placement.to_session(end)
                        if start < hi and end > lo:
                            out.append(
                                PauseActivity(
                                    placement.track_id,
                                    placement.source_id,
                                    placement.media,
                                    start,
                                    end,
                                )
                            )
                    continue
                reading = recording.reading()
                if isinstance(reading, PauseAirSkip):
                    return reading
                src_lo = placement.to_source(max(lo - dt, placement.tl_start))
                src_hi = placement.to_source(min(hi + dt, placement.tl_end))
                for a, b, _removable in reading.between(src_lo, src_hi):
                    if min(b, placement.src_end) <= max(a, placement.src_start):
                        continue
                    clipped_lo = a < placement.src_start - _CLOCK_EPS_SEC
                    clipped_hi = b > placement.src_end + _CLOCK_EPS_SEC
                    start, end = (
                        (a, b)
                        if clipped_lo or clipped_hi
                        else recording.content_span(reading, a, b, placement=placement)
                    )
                    out.append(
                        PauseActivity(
                            placement.track_id,
                            placement.source_id,
                            placement.media,
                            placement.tl_start - dt if clipped_lo else placement.to_session(start),
                            placement.tl_end + dt if clipped_hi else placement.to_session(end),
                        )
                    )
        return MeasuredPause(tuple(out)) if acoustic else GeometricPause(tuple(out))


def _overlaps(placement: Placement, lo: float, hi: float) -> bool:
    return placement.tl_start < hi and placement.tl_end > lo


def _file_reader(media: Path, sample_rate: int) -> Callable[[float, float], np.ndarray]:
    return lambda start, duration: load_mono_window(
        media, start_sec=start, duration_sec=duration, sample_rate=sample_rate
    )
