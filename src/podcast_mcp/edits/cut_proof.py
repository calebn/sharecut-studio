from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

import numpy as np

from podcast_mcp.config import EffectiveConfig
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.engines.audio_audit import (
    TimelineReads,
    TrackRmsCacheSet,
    build_track_rms_caches,
)
from podcast_mcp.engines.level_profile import (
    LEVEL_FRAME_SEC,
    PROFILE_TOLERANCE_DB,
    GuessedFrames,
    frame_levels_db,
    live_room_db,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import frozen
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB
from podcast_mcp.util.tracks import dialogue_track_ids

T = TypeVar("T")

# A cut changes the timeline from its start, less the fades it writes to the left of it.
_FADE_MARGIN_SEC = 1.0


def _frame(sec: float) -> int:
    return max(0, round(sec / LEVEL_FRAME_SEC))


def _build_timeline_rms_caches(
    project: EpisodeProject, defaults: EffectiveConfig
) -> TrackRmsCacheSet:
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return build_track_rms_caches(project, track_ids=tracks, unprocessed=True, defaults=defaults)


def shared_timeline_rms_caches(
    project: EpisodeProject, *, defaults: EffectiveConfig
) -> TrackRmsCacheSet:
    """Timeline stems for every dialogue track, once per read-only proof block."""
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return frozen(
        ("cut_proof_timeline_rms", id(project), tracks),
        lambda: _build_timeline_rms_caches(project, defaults),
        keep=project,
    )


@dataclass(frozen=True)
class CutEffect:
    """What an applied source cut did to the timeline, as the batch evidence reads it.

    ``tracks`` are the tracks whose timeline it changed: every rippled track, or the one
    track a punch left a ``hole`` in. ``fade_sec`` is the fade written at the join and
    ``pad_sec`` the pad opened at ``start_sec`` (digital silence when ``pad_silent``, else
    room tone).
    """

    start_sec: float
    end_sec: float
    tracks: tuple[str, ...]
    hole: bool = False
    fade_sec: float = 0.0
    pad_sec: float = 0.0
    pad_silent: bool = False


class _WindowCaches(TrackRmsCacheSet):
    """Timeline caches a batch reads windows and level profiles from, and nothing else.

    The bleed path (``echo_pairs``, ``copy_path``, ``copy_match``, the lag steps) is measured
    on the whole timeline through ``path_samples`` and is not carried across a cut, so
    reading it here is an error rather than a stale answer.
    """

    def path_samples(self, track_id: str) -> np.ndarray:
        raise RuntimeError("a batch's timeline caches carry window reads and level profiles only")


class BatchTimelineEvidence:
    """Timeline level caches that one approval measures once and every cut of it reads.

    Each cut is proved against the timeline the earlier cuts of its batch left, and
    measuring that timeline renders every dialogue track again. A cut changes the timeline
    only from where it starts, and the batch applies its cuts from the end backwards, so the
    caches built before the batch still hold the audio the next cut reads. The audio
    a cut reads is kept exact this way: ``applied`` marks the second from which a cut
    changed the timeline, and a read that reaches past it would see the old timeline there,
    so that cut is read again from caches built for the current timeline, which then serve
    the cuts after it.

    A track's level profile (room, speech and loud level) is a percentile over the whole
    timeline, so every cut moves it. Each cut is applied to the track's cached samples (the
    audio it removes is cut out, a pad is opened) and the caches read the profile of the cut
    timeline. A fresh render of that timeline differs only in the frames at the edges of the
    cuts and in the pads. When those frames could move the profile by more than
    ``PROFILE_TOLERANCE_DB``, the timeline is measured again before the next cut.

    The evidence answers only for the project a cut produced: a cut that was not kept (the
    caller went back to the project it observed) is dropped, and any other project is
    measured from scratch.
    """

    def __init__(self, defaults: EffectiveConfig) -> None:
        self._defaults = defaults
        self._caches: TrackRmsCacheSet | None = None
        self._guesses: dict[str, GuessedFrames] = {}
        self._levels: dict[str, np.ndarray] = {}
        self._reads = TimelineReads()
        self._unchanged_before = math.inf
        self._observed: EpisodeProject | None = None
        self._pending: tuple[EpisodeProject, CutEffect | None] | None = None
        self._stale = False

    def observe(self, project: EpisodeProject, read: Callable[[TrackRmsCacheSet], T]) -> T:
        """``read(caches)``, with caches that match ``project`` everywhere ``read`` looks."""
        self._settle(project)
        if self._caches is None or self._stale:
            self._rebuild(project)
        assert self._caches is not None
        self._reads.reset()
        result = read(self._caches)
        if self._reads.end_sec > self._unchanged_before:
            self._rebuild(project)
            assert self._caches is not None
            result = read(self._caches)
        self._observed = project
        return result

    def applied(self, after: EpisodeProject, effect: CutEffect | None) -> None:
        """``after`` is the timeline an applied cut made of the project last observed.

        ``effect`` is ``None`` for a cut the evidence cannot follow: the timeline is then
        measured again.
        """
        self._pending = (after, effect)

    def _settle(self, project: EpisodeProject) -> None:
        pending, self._pending = self._pending, None
        if pending is not None and project is pending[0]:
            self._follow(pending[1])
        elif project is not self._observed and self._observed is not None:
            self._stale = True

    def _follow(self, effect: CutEffect | None) -> None:
        if effect is None or self._caches is None:
            self._stale = True
            return
        self._unchanged_before = min(
            self._unchanged_before, effect.start_sec - effect.fade_sec - _FADE_MARGIN_SEC
        )
        fade_frames = math.ceil(effect.fade_sec / LEVEL_FRAME_SEC)
        for track_id in effect.tracks:
            cache = self._caches.get(track_id)
            if cache is None:
                continue
            guesses = self._guesses.setdefault(track_id, GuessedFrames())
            first, last = _frame(effect.start_sec), _frame(effect.end_sec)
            if effect.hole:
                cache.silence(effect.start_sec, effect.end_sec)
                levels = frame_levels_db(cache.samples, cache.sample_rate)
                guesses.join(levels, first, fade_frames)
                guesses.join(levels, last, fade_frames)
            else:
                cache.remove(effect.start_sec, effect.end_sec)
                guesses.removed(first, last)
                levels = frame_levels_db(cache.samples, cache.sample_rate)
                guesses.join(levels, first, fade_frames)
            if effect.pad_sec > 0:
                count = round(effect.pad_sec / LEVEL_FRAME_SEC)
                room = DIGITAL_SILENCE_DB if effect.pad_silent else live_room_db(levels)
                cache.insert_tone(effect.start_sec, effect.pad_sec, room)
                guesses.inserted(first, count)
                levels = frame_levels_db(cache.samples, cache.sample_rate)
                guesses.pad(levels, first, count, silent=effect.pad_silent)
            self._levels[track_id] = levels
        self._stale = self._stale or any(
            self._guesses[tid].spread_db(levels) > PROFILE_TOLERANCE_DB
            for tid, levels in self._levels.items()
            if tid in self._guesses
        )

    def _rebuild(self, project: EpisodeProject) -> None:
        # The set being replaced holds a copy of every track; free it before the new build.
        self._caches, self._guesses, self._levels = None, {}, {}
        built = _build_timeline_rms_caches(project, self._defaults)
        caches = _WindowCaches(caches=built.caches)
        for cache in caches.caches.values():
            cache.reads = self._reads
        self._caches = caches
        self._unchanged_before = math.inf
        self._stale = False


def shared_source_audio_caches(project: EpisodeProject) -> dict[str, TrackAudioCache]:
    """Each dialogue track's raw source audio, once per read-only proof block."""
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return frozen(
        ("cut_proof_source_audio", id(project), tracks),
        lambda: build_track_audio_caches(project, tracks),
        keep=project,
    )
