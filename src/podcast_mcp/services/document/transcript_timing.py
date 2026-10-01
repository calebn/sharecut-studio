from __future__ import annotations

import math

from podcast_mcp.edits.transcript_timing import WordTimingMedia, WordTimingTarget
from podcast_mcp.engines.waveform_media import MediaEntry, pyramid_target
from podcast_mcp.engines.waveform_pyramid import read_meta
from podcast_mcp.models import EpisodeProject, MediaAsset, SourceRecording
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.tracks import recording_audio_path


def word_timing_media(project: EpisodeProject, target: WordTimingTarget) -> WordTimingMedia:
    path = recording_audio_path(project, target.track_id, target.source_id)
    if not path.is_file():
        raise FileNotFoundError("The source recording is unavailable.")
    revision = file_revision(path)
    asset: MediaAsset | SourceRecording | None
    if target.source_id is None:
        track = project.track_by_id(target.track_id)
        asset = track.media if track else None
    else:
        asset = project.source_by_id(target.source_id)
    duration = asset.duration_sec if asset else None
    sample_rate = asset.sample_rate if asset else None
    ref = (
        f"source:{target.source_id}" if target.source_id is not None else f"track:{target.track_id}"
    )
    relative = str(path.relative_to(project.workspace_path().resolve()))
    pyramid = pyramid_target(project.artifacts_dir(), ref, MediaEntry("raw", path, relative))
    if pyramid.out.is_file():
        try:
            meta = read_meta(pyramid.out)
            duration, sample_rate = meta.total_frames / meta.sample_rate, meta.sample_rate
        except (OSError, ValueError):
            pass
    if duration is not None and (not math.isfinite(duration) or duration <= 0):
        duration = None
    if sample_rate is not None and sample_rate <= 0:
        sample_rate = None
    return WordTimingMedia(
        ref,
        duration,
        sample_rate,
        pyramid.key,
        (
            relative,
            *revision,
            asset.duration_sec if asset else None,
            asset.sample_rate if asset else None,
        ),
    )
