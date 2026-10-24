from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_track_rms_caches
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import frozen
from podcast_mcp.util.tracks import dialogue_track_ids


@dataclass(eq=False)
class TimelineCarry:
    """The timeline stems of one project object, kept across the read-only proofs of its cuts.

    A held cut leaves ``project`` as it was (the cut wrote a private copy), so the next
    cut's proof reads the same stems. The entry is for one project object and one
    ``defaults`` object, compared by identity; any other pair rebuilds and replaces it.
    Callers drop the carry at an apply (the applied copy is a new object, so it would miss
    anyway) and take it only while nothing writes ``project`` or its recordings.
    """

    project: EpisodeProject | None = None
    defaults: EffectiveConfig | None = None
    caches: TrackRmsCacheSet | None = None


def shared_timeline_rms_caches(
    project: EpisodeProject, *, defaults: EffectiveConfig, carry: TimelineCarry | None = None
) -> TrackRmsCacheSet:
    """Timeline stems for every dialogue track, once per read-only proof block.

    This builds on the caller's thread. A tighten pool worker that built a track here would
    wait on the project lock that the thread in ``mutate`` holds (#1471). The batch shares a
    chained track's evidence by content (``track_evidence``), so the next block finds it
    already built.
    """
    if (
        carry is not None
        and carry.caches is not None
        and carry.project is project
        and carry.defaults is defaults
    ):
        return carry.caches
    tracks = tuple(sorted(dialogue_track_ids(project)))
    caches = frozen(
        ("cut_proof_timeline_rms", id(project), tracks),
        lambda: build_track_rms_caches(
            project, track_ids=tracks, unprocessed=True, defaults=defaults
        ),
        keep=project,
    )
    if carry is not None:
        carry.project, carry.defaults, carry.caches = project, defaults, caches
    return caches


def shared_source_audio_caches(project: EpisodeProject) -> dict[str, TrackAudioCache]:
    """Each dialogue track's raw source audio, once per read-only proof block."""
    tracks = tuple(sorted(dialogue_track_ids(project)))
    return frozen(
        ("cut_proof_source_audio", id(project), tracks),
        lambda: build_track_audio_caches(project, tracks),
        keep=project,
    )
