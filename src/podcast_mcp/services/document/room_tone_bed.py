"""Cut and register a room-tone bed for a track that has none (#1216)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypedDict, cast

from podcast_mcp.edits.extracted_bed import (
    bedless_reason,
    clear_extracted_bed,
    register_extracted_bed,
)
from podcast_mcp.engines.room_tone import SampleAbsent
from podcast_mcp.engines.room_tone_extract import plan_extracted_bed
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document.service_base import WorkspaceService


class RoomToneBedReply(TypedDict, total=False):
    track_id: str
    extracted: bool
    cleared: bool
    reason: str
    rejected_checks: list[str]
    path: str
    source_start: float
    source_end: float


class RoomToneBedService(WorkspaceService):
    def _commit(
        self,
        verb: str,
        operation: str,
        tid: str,
        edit: Callable[[EpisodeProject], dict[str, Any]],
    ) -> RoomToneBedReply:
        return cast(
            RoomToneBedReply,
            self.ws.mutate(
                f"before {verb}",
                f"after {verb}",
                edit,
                operation=operation,
                params={"track_id": tid},
            ),
        )

    def extract_room_tone_bed(
        self, *, track_id: str | None = None, speaker: str | None = None
    ) -> RoomToneBedReply:
        """Give ``track_id`` a bed cut from its own audio when it has none.

        Only a track with no bed, or one the pipeline cut earlier from audio that has since
        changed, takes a new bed; a recorded or assigned bed is left alone. A rerun on the same
        audio changes nothing. With no clean stretch the track stays without a bed and the
        reply says why.
        """
        tid = self._resolve(track_id, speaker)
        project = self.ws.project
        reason = bedless_reason(project, tid)
        if reason is not None:
            return {"track_id": tid, "extracted": False, "reason": reason}
        plan = plan_extracted_bed(project, tid)
        if isinstance(plan, SampleAbsent):
            return {
                "track_id": tid,
                "extracted": False,
                "reason": plan.cause,
                "rejected_checks": list(plan.rejected_checks),
            }
        return self._commit(
            "extracting room tone",
            "extract_room_tone_bed",
            tid,
            lambda p: register_extracted_bed(p, tid, plan),
        )

    def clear_extracted_room_tone_bed(
        self, *, track_id: str | None = None, speaker: str | None = None
    ) -> RoomToneBedReply:
        """Take the bed the pipeline cut off ``track_id``, in one undo step.

        A recorded or assigned bed is never removed, and a track with no bed is left as it is;
        the reply says why. Fills baked into mutes keep their own copy of the bed; fills
        under timing holes follow the track's bed, so they fall back once it is gone. History
        undo brings the bed back. The clear lasts only until the next pipeline run with
        ``room_tone.extract_bed`` on, which cuts a bed for a bedless track again.
        """
        tid = self._resolve(track_id, speaker)
        track = self.ws.project.track_by_id(tid)
        if track is None or track.room_tone is None or track.room_tone_origin is None:
            return cast(RoomToneBedReply, clear_extracted_bed(self.ws.project, tid))
        return self._commit(
            "clearing extracted room tone",
            "clear_extracted_room_tone_bed",
            tid,
            lambda p: clear_extracted_bed(p, tid),
        )
