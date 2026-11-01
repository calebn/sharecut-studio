"""Cut and register a room-tone bed for a track that has none (#1216)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.record_placement import place_extracted_room_tone
from podcast_mcp.engines.room_tone import SampleAbsent
from podcast_mcp.engines.room_tone_extract import (
    EXTRACTOR_REV,
    ExtractedBed,
    plan_extracted_bed,
)
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.project_state import file_stamp
from podcast_mcp.util.tracks import track_audio_path


def _blocked(track: Track | None) -> str | None:
    """Why ``track`` may not take an extracted bed, or None when it may."""
    if track is None:
        return "missing_track"
    if track.media is None:
        return "missing_media"
    if track.room_tone is not None and track.room_tone_origin is None:
        # A recorded or assigned bed is never replaced by the pipeline.
        return "has_bed"
    return None


def _current(project: EpisodeProject, track: Track) -> bool:
    """True when ``track``'s extracted bed was cut from its audio as it is now."""
    origin = track.room_tone_origin
    if origin is None or origin.extractor_rev != EXTRACTOR_REV:
        return False
    try:
        stamp = file_stamp(track_audio_path(project, track.id))
    except OSError:
        return False
    return (stamp.size, stamp.mtime_ns) == (origin.media_size, origin.media_mtime_ns)


class RoomToneBedService(WorkspaceService):
    def extract_room_tone_bed(
        self, *, track_id: str | None = None, speaker: str | None = None
    ) -> dict[str, Any]:
        """Give ``track_id`` a bed cut from its own audio when it has none.

        Only a track with no bed, or one the pipeline cut earlier from audio that has since
        changed, takes a new bed; a recorded or assigned bed is left alone. A rerun on the same
        audio changes nothing. With no clean stretch the track stays without a bed and the
        reply says why.
        """
        tid = self._resolve(track_id, speaker)
        project = self.ws.project
        track = project.track_by_id(tid)
        reason = _blocked(track)
        if reason is not None:
            return {"track_id": tid, "extracted": False, "reason": reason}
        assert track is not None
        if _current(project, track):
            return {"track_id": tid, "extracted": False, "reason": "already_extracted"}
        plan = plan_extracted_bed(project, tid)
        if isinstance(plan, SampleAbsent):
            return {
                "track_id": tid,
                "extracted": False,
                "reason": plan.cause,
                "rejected_checks": list(plan.rejected_checks),
            }
        return self.ws.mutate(
            "before extracting room tone",
            "after extracting room tone",
            lambda p: self._register(p, tid, plan),
            operation="extract_room_tone_bed",
            params={"track_id": tid},
        )

    @staticmethod
    def _register(project: EpisodeProject, tid: str, plan: ExtractedBed) -> dict[str, Any]:
        track = project.track_by_id(tid)
        reason = _blocked(track)
        if reason is not None:
            return {"track_id": tid, "extracted": False, "reason": reason}
        assert track is not None
        try:
            stamp = file_stamp(track_audio_path(project, tid))
        except OSError:
            return {"track_id": tid, "extracted": False, "reason": "unreadable_file"}
        if (stamp.size, stamp.mtime_ns) != (plan.origin.media_size, plan.origin.media_mtime_ns):
            return {"track_id": tid, "extracted": False, "reason": "source_changed"}
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
