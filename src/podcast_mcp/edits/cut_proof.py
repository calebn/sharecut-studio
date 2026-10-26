from __future__ import annotations

import math

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_track_rms_caches
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import frozen
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


class CarriedTimelineRms:
    """The dialogue tracks' timeline loudness, built once for a batch applied from the end backward.

    A cut moves only what plays after it, so a stem built before a later cut was applied is
    still what plays before that cut. A check that reads within ``reach`` of its cut uses the
    carried stems while every applied cut lies beyond that reach, and builds them again from
    the current project when one does not, or when a track's rendered stem has gone stale
    since (the loudness then comes from its clips, not the stem). ``applied`` is told where
    each kept cut began.
    """

    def __init__(self) -> None:
        self._caches: TrackRmsCacheSet | None = None
        self._intact_before = math.inf
        self._stems_fresh: tuple[bool, ...] = ()

    def caches_for(
        self,
        project: EpisodeProject,
        span: tuple[TimelineSec, TimelineSec],
        *,
        reach: float,
        defaults: EffectiveConfig,
    ) -> TrackRmsCacheSet:
        fresh = tuple(
            stem_is_fresh(project, tid, defaults=defaults)
            for tid in sorted(dialogue_track_ids(project))
        )
        if (
            self._caches is None
            or fresh != self._stems_fresh
            or float(span[1]) + reach >= self._intact_before
        ):
            self._caches = shared_timeline_rms_caches(project, defaults=defaults)
            self._intact_before = math.inf
            self._stems_fresh = fresh
        return self._caches

    def applied(self, timeline_start: float) -> None:
        self._intact_before = min(self._intact_before, timeline_start)
