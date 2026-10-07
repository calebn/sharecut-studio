"""Agent/CLI façade over RecordSessionService."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.landing import RecordLandingService, RecordTakeOpenError
from podcast_mcp.services.record.live_comments import LIVE_COMMENT_ID_PREFIX
from podcast_mcp.services.record.service import RecordSessionService, next_record_client_seq
from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID


class RecordControlService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace
        session_id = RecordSessionService.active_session_id(workspace.project)
        if not session_id:
            raise FileNotFoundError("no active record room")
        self._svc = RecordSessionService(workspace.project, session_id=session_id)

    def snapshot(self) -> dict[str, Any]:
        return self._svc.snapshot()

    def roster(self) -> list[dict[str, Any]]:
        return list(self.snapshot().get("participants") or [])

    def start(self) -> dict[str, Any]:
        return self._host("Start")

    def pause(self) -> dict[str, Any]:
        return self._host("Pause")

    def resume(self) -> dict[str, Any]:
        return self._host("Resume")

    def stop(self) -> dict[str, Any]:
        return self._host("Stop")

    def marker(self, body: str = "Marker") -> dict[str, Any]:
        """Drop a live comment at this moment of the open take; it lands as a comment."""
        marker_id = f"{LIVE_COMMENT_ID_PREFIX}{uuid4().hex}"
        snapshot = self._host("Comment", {"id": marker_id, "body": body})
        return {"marker_id": marker_id, **snapshot}

    def land(self) -> dict[str, Any]:
        """Host land (HTTP, MCP, CLI); refuses an open take.

        Landing on upload completion calls ``RecordLandingService.land`` directly, so a
        keeper that arrives during a later take still lands.
        """
        if self.snapshot().get("state") in ("recording", "paused"):
            raise RecordTakeOpenError
        return RecordLandingService(self.workspace).land()

    def discard_take(self, take_index: int) -> dict[str, Any]:
        return RecordLandingService(self.workspace).delete_take(take_index)

    def submit_host(
        self, command_type: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        cmd = RecordCommand.parse(
            command_type=command_type,
            payload=payload or {},
            client_id="cli",
            role="host",
            participant_id=HOST_PARTICIPANT_ID,
            client_seq=next_record_client_seq(),
        )
        return self._svc.submit(cmd)

    def _host(self, command_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.submit_host(command_type, payload)
