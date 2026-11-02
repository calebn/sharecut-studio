"""Cut and register a room-tone bed for a track that has none (#1216)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.record_placement import place_extracted_room_tone
from podcast_mcp.engines.room_tone import SampleAbsent
from podcast_mcp.engines.room_tone_extract import (
    EXTRACTOR_REV,
    ExtractedBed,
    plan_extracted_bed,
    source_matches,
)
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.workspace_paths import resolve_under_workspace


def _blocked(track: Track | None) -> str | None:
    if track is None:
        return "missing_track"
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
        current = _current(project, track)
        if current is not None:
            return {"track_id": tid, "extracted": False, "reason": current}
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
