from __future__ import annotations

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_track_rms_caches
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import frozen
from podcast_mcp.util.tracks import dialogue_track_ids


def shared_timeline_rms_caches(
    project: EpisodeProject, *, defaults: EffectiveConfig
) -> TrackRmsCacheSet:
    """Timeline stems for every dialogue track, once per read-only proof block.

    Built on the caller's thread: a tighten pool worker that built a track here would wait
    on the project lock the thread in ``mutate`` holds (#1471). A chained track's evidence
    is the batch's, by content (``track_evidence``), so the next block finds it built.
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
