"""Give a track a bed cut from its own audio on a project in hand (#1216)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.record_placement import place_extracted_room_tone
from podcast_mcp.engines.room_tone_extract import EXTRACTOR_REV, ExtractedBed, source_matches
from podcast_mcp.models import EpisodeProject, Track, TrackRole
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.workspace_paths import resolve_under_workspace


def _blocked(track: Track | None) -> str | None:
    if track is None:
        return "missing_track"
    if track.role != TrackRole.DIALOGUE:
        return "not_dialogue_track"
    if track.media is None:
        return "missing_media"
    if track.room_tone is not None and track.room_tone_origin is None:
        return "has_bed"
    return None


def _current(project: EpisodeProject, track: Track) -> str | None:
    origin = track.room_tone_origin
    if origin is None or track.room_tone is None:
        return None
    try:
        bed = resolve_under_workspace(project, track.room_tone.path)
        if not bed.exists():
            return None
        if sha256_file(bed) != origin.file_sha256:
            return "bed_changed"
    except (OSError, ValueError):
        return "unreadable_file"
    if origin.extractor_rev == EXTRACTOR_REV and source_matches(project, track.id, origin):
        return "already_extracted"
    return None


def bedless_reason(project: EpisodeProject, tid: str) -> str | None:
    """Why ``tid`` takes no new extracted bed (not a dialogue track, has one, no media, unchanged audio), else None."""
    track = project.track_by_id(tid)
    reason = _blocked(track)
    if reason is not None or track is None:
        return reason
    return _current(project, track)


def clear_extracted_bed(project: EpisodeProject, tid: str) -> dict[str, Any]:
    """Take the extracted bed off ``tid``; a recorded or assigned bed, or none, is left alone."""
    track = project.track_by_id(tid)
    if track is None:
        return {"track_id": tid, "cleared": False, "reason": "missing_track"}
    if track.room_tone is None or track.room_tone_origin is None:
        reason = "recorded_bed" if track.room_tone is not None else "no_bed"
        return {"track_id": tid, "cleared": False, "reason": reason}
    track.room_tone = None
    track.room_tone_origin = None
    return {"track_id": tid, "cleared": True}


def register_extracted_bed(project: EpisodeProject, tid: str, plan: ExtractedBed) -> dict[str, Any]:
    """Give ``tid`` the planned bed on ``project`` itself, or say why the plan no longer fits."""
    track = project.track_by_id(tid)
    reason = _blocked(track)
    if reason is not None:
        return {"track_id": tid, "extracted": False, "reason": reason}
    assert track is not None
    if not source_matches(project, tid, plan.origin):
        return {"track_id": tid, "extracted": False, "reason": "source_changed"}
    try:
        bed = resolve_under_workspace(project, plan.rel)
        if sha256_file(bed) != plan.origin.file_sha256:
            return {"track_id": tid, "extracted": False, "reason": "bed_changed"}
    except (OSError, ValueError):
        return {"track_id": tid, "extracted": False, "reason": "bed_changed"}
    place_extracted_room_tone(
        project,
        track_id=tid,
        rel=plan.rel,
        duration_s=plan.duration_sec,
        sample_rate=plan.sample_rate,
        channels=plan.channels,
        origin=plan.origin,
    )
    return {
        "track_id": tid,
        "extracted": True,
        "path": plan.rel,
        "source_start": plan.origin.source_start,
        "source_end": plan.origin.source_end,
    }
