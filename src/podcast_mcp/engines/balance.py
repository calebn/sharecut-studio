from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from podcast_mcp.models.episode import EpisodeProject, Track
from podcast_mcp.util.project_state import file_revision

BALANCE_SEMANTICS_REVISION = 1


def kept_speech_intervals(
    project: EpisodeProject, track_id: str
) -> list[tuple[float, float]] | None:
    from podcast_mcp.edits.clips_ops import clips_for_track
    from podcast_mcp.engines.transcript_gated_play import source_word_intervals
    from podcast_mcp.util.intervals import intersect_intervals

    speech = source_word_intervals(project, track_id, 0.0, math.inf)
    kept = [
        (clip.source_start, clip.source_end)
        for clip in clips_for_track(project, track_id)
        if not clip.source_id and clip.source_end > clip.source_start
    ]
    if not speech or not kept:
        return speech
    return intersect_intervals(speech, kept) or None


def balance_basis_digest(project: EpisodeProject, track_id: str) -> str | None:
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    path = Path(track.media.path)
    if not path.is_absolute():
        path = project.workspace_path() / path
    try:
        revision = file_revision(path)
    except OSError:
        return None
    chain = next((item for item in project.processing_chains if item.track_id == track_id), None)
    payload = {
        "revision": BALANCE_SEMANTICS_REVISION,
        "track_id": track_id,
        "media_revision": revision,
        "effects": [effect.model_dump(mode="json") for effect in chain.effects] if chain else [],
        "kept_speech": kept_speech_intervals(project, track_id),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def balance_status(project: EpisodeProject, track: Track) -> dict[str, bool | float | None]:
    basis = track.balance_basis
    return {
        "stale": None if basis is None else balance_basis_digest(project, track.id) != basis.digest,
        "speech_gated": None if basis is None else basis.speech_gated,
        "measured_lufs": None if basis is None else basis.measured_lufs,
    }
