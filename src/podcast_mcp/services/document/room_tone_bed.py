"""Cut and register a room-tone bed for a track that has none (#1216)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.extracted_bed import bedless_reason, register_extracted_bed
from podcast_mcp.engines.room_tone import SampleAbsent
from podcast_mcp.engines.room_tone_extract import plan_extracted_bed
from podcast_mcp.services.document.service_base import WorkspaceService


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
        return self.ws.mutate(
            "before extracting room tone",
            "after extracting room tone",
            lambda p: register_extracted_bed(p, tid, plan),
            operation="extract_room_tone_bed",
            params={"track_id": tid},
        )
