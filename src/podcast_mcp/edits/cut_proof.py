from __future__ import annotations

import math

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.engines.audio_audit import (
    TrackRmsCacheSet,
    build_track_rms_caches,
    has_active_chain,
)
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.engines.windowed_rms import TimelineWindow
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import frozen
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids


def shared_timeline_rms_caches(
    project: EpisodeProject, *, defaults: EffectiveConfig
) -> TrackRmsCacheSet:
    """Timeline stems for every dialogue track, once per read-only proof block.

    This builds on the caller's thread. A tighten pool worker that built a track here would
    wait on the project lock that the thread in ``mutate`` holds (#1471). The batch shares a
    chained track's evidence by content (``track_evidence``), so the next block finds it
    already built.
    """
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return frozen(
        ("cut_proof_timeline_rms", id(project), tracks),
        lambda: build_track_rms_caches(
            project, track_ids=tracks, unprocessed=True, defaults=defaults
        ),
        keep=project,
    )


def shared_source_audio_caches(project: EpisodeProject) -> dict[str, TrackAudioCache]:
    """Each dialogue track's raw source audio, once per read-only proof block."""
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return frozen(
        ("cut_proof_source_audio", id(project), tracks),
        lambda: build_track_audio_caches(project, tracks),
        keep=project,
    )


class BatchBase:
    """The level profile of each dialogue track before a batch's cuts (#2357), read by every check.

    ``start`` is the project the batch starts from. The profiles are measured on the timeline
    caches of ``start`` the first time a check needs any: from the caches that check builds
    when it is made on ``start`` itself, else from a build of ``start``. A set built after the
    batch applied a cut reports the base profile of each track, in place of one measured from
    its own, shorter samples, so a verdict does not depend on which other cuts of the batch
    were applied before it, and a check on carried caches reads the same profile as one on
    rebuilt caches. The verdict key carries a digest of the profiles (``stamp``), so the first
    key of a batch builds the start's caches, also when every check then reuses a stored
    verdict; the first check made on ``start`` reuses that build.
    """

    def __init__(self, start: EpisodeProject) -> None:
        self._start = start
        self._profiles: dict[str, LevelProfile] | None = None
        self._start_set: TrackRmsCacheSet | None = None

    def profiles(
        self,
        project: EpisodeProject,
        built: TrackRmsCacheSet | None,
        *,
        defaults: EffectiveConfig,
    ) -> dict[str, LevelProfile]:
        """The base profiles; ``built``, a set made from ``project``, is the source if the start."""
        if self._profiles is None:
            if built is not None and project is self._start:
                self._start_set = built
            source = self.built_for(self._start, defaults=defaults)
            self._profiles = {tid: cache.profile for tid, cache in source.caches.items()}
        return self._profiles

    def built_for(self, project: EpisodeProject, *, defaults: EffectiveConfig) -> TrackRmsCacheSet:
        """The timeline caches of ``project``; for the start, the one the stamp or a check built."""
        if project is not self._start:
            return shared_timeline_rms_caches(project, defaults=defaults)
        if self._start_set is None:
            self._start_set = shared_timeline_rms_caches(project, defaults=defaults)
        return self._start_set

    def stamp(self, *, defaults: EffectiveConfig) -> str:
        """A digest of the base profiles, for the verdict key (``verdict_cache``).

        Every value a check reads of a profile is derived from its room, speech and loud
        levels, so those are hashed at full precision (``repr``): two bases that differ in any
        bit differ in the stamp, and two that are equal give the same one. Asking for it builds
        the start's timeline caches if no check has yet, once per batch.
        """
        profiles = self.profiles(self._start, None, defaults=defaults)
        return short_digest(
            repr(
                [
                    (tid, repr(p.room_db), repr(p.speech_db), repr(p.loud_db))
                    for tid, p in sorted(profiles.items())
                ]
            )
        )

    def adopt(
        self, project: EpisodeProject, built: TrackRmsCacheSet, *, defaults: EffectiveConfig
    ) -> TrackRmsCacheSet:
        """``built`` (made from ``project``) as is for the start, else on the base profiles."""
        profiles = self.profiles(project, built, defaults=defaults)
        if project is self._start:
            return built
        return TrackRmsCacheSet(
            caches={
                tid: cache.with_profile(profiles[tid]) if tid in profiles else cache
                for tid, cache in built.caches.items()
            }
        )


class RebuiltTimelineRms:
    """A batch whose every check builds the caches from the project as it stands, on the base.

    The auto-apply of tighten removes checks each cut on the project as the earlier cuts left
    it; this gives it the same profile definition as ``CarriedTimelineRms`` (#2357).
    """

    def __init__(self, start: EpisodeProject) -> None:
        self.base = BatchBase(start)

    def caches_for(
        self,
        project: EpisodeProject,
        span: tuple[TimelineSec, TimelineSec],
        *,
        reach: float,
        defaults: EffectiveConfig,
    ) -> TrackRmsCacheSet:
        return self.whole(project, defaults=defaults)

    def whole(self, project: EpisodeProject, *, defaults: EffectiveConfig) -> TrackRmsCacheSet:
        return self.base.adopt(
            project, self.base.built_for(project, defaults=defaults), defaults=defaults
        )


class CarriedTimelineRms:
    """The dialogue tracks' timeline audio, built once for a batch applied from the end backward.

    A cut moves only what plays after it, so a stem built before a later cut was applied is
    still what plays before that cut. A check that reads within ``reach`` of its cut uses the
    carried stems while every applied cut lies beyond that reach. A check that does not reads
    the stretch around its cut from the project as the earlier cuts left it: a chained track
    is evaluated over that stretch only (``WindowedTrackRmsCache``, bit-identical to the whole
    track there) and the other tracks are built whole. A read the stretch
    does not hold raises ``WindowMiss``, and ``whole`` builds every track. A rebuilt set is
    built from the current project but reports each track's profile from the first build (the
    batch base, ``BatchBase``), so carried and rebuilt checks judge loudness by the same
    profile. ``applied`` is told where each kept cut began.
    """

    def __init__(self, start: EpisodeProject) -> None:
        self._caches: TrackRmsCacheSet | None = None
        self._intact_before = math.inf
        self._stems_fresh: tuple[bool, ...] = ()
        self.base = BatchBase(start)

    def caches_for(
        self,
        project: EpisodeProject,
        span: tuple[TimelineSec, TimelineSec],
        *,
        reach: float,
        defaults: EffectiveConfig,
    ) -> TrackRmsCacheSet:
        fresh = self._fresh(project, defaults)
        if self._caches is None:
            return self._rebuilt(project, fresh, defaults)
        if fresh != self._stems_fresh:
            # A stem went stale: its track's loudness now comes from its clips. A chained
            # track never reads its stem, so its carried evidence stands before the first cut.
            if math.isinf(self._intact_before):
                return self._rebuilt(project, fresh, defaults)
            self._caches = self._carried_with_current_stems(project, defaults)
            self._stems_fresh = fresh
        if float(span[1]) + reach < self._intact_before:
            return self._caches
        lo, hi = float(span[0]) - reach, float(span[1]) + reach
        built = build_track_rms_caches(
            project,
            track_ids=tuple(sorted(dialogue_track_ids(project))),
            unprocessed=True,
            window=TimelineWindow(max(0.0, lo), hi, self._profiles(project, defaults)),
            defaults=defaults,
        )
        return self.base.adopt(project, built, defaults=defaults)

    def whole(self, project: EpisodeProject, *, defaults: EffectiveConfig) -> TrackRmsCacheSet:
        """Every track built whole from the current project, for a check no window served."""
        return self._rebuilt(project, self._fresh(project, defaults), defaults)

    def applied(self, timeline_start: float) -> None:
        self._intact_before = min(self._intact_before, timeline_start)

    def _profiles(
        self, project: EpisodeProject, defaults: EffectiveConfig
    ) -> dict[str, LevelProfile]:
        assert self._caches is not None
        return self.base.profiles(project, self._caches, defaults=defaults)

    @staticmethod
    def _fresh(project: EpisodeProject, defaults: EffectiveConfig) -> tuple[bool, ...]:
        return tuple(
            stem_is_fresh(project, tid, defaults=defaults)
            for tid in sorted(dialogue_track_ids(project))
        )

    def _rebuilt(
        self, project: EpisodeProject, fresh: tuple[bool, ...], defaults: EffectiveConfig
    ) -> TrackRmsCacheSet:
        self._caches = self.base.adopt(
            project, self.base.built_for(project, defaults=defaults), defaults=defaults
        )
        self._intact_before = math.inf
        self._stems_fresh = fresh
        return self._caches

    def _carried_with_current_stems(
        self, project: EpisodeProject, defaults: EffectiveConfig
    ) -> TrackRmsCacheSet:
        """The carried caches, each track with no active chain built again from ``project``."""
        assert self._caches is not None
        plain = tuple(
            tid for tid in sorted(dialogue_track_ids(project)) if not has_active_chain(project, tid)
        )
        current = self.base.adopt(
            project,
            build_track_rms_caches(project, track_ids=plain, unprocessed=True, defaults=defaults),
            defaults=defaults,
        ).caches
        # A plain track missing from ``current`` (it has no samples now, or its raw read failed)
        # is absent, as a full rebuild leaves it; its carried stem is not what plays now.
        caches = {
            tid: current[tid] if tid in plain else cache
            for tid, cache in self._caches.caches.items()
            if tid in current or tid not in plain
        }
        return TrackRmsCacheSet(caches=caches)


TimelineRms = CarriedTimelineRms | RebuiltTimelineRms
