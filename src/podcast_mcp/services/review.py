"""ReviewService - freeze review mix versions via ProjectWorkspace.mutate."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.review_versions import (
    get_version,
    list_versions,
    publish_version,
    set_active_version,
    version_audio_path,
)
from podcast_mcp.services.workspace import ProjectWorkspace


class ReviewService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def list_versions(self) -> list[dict[str, Any]]:
        active = self.ws.project.review.active_version_id
        return [
            {**v.model_dump(), "active": v.id == active} for v in list_versions(self.ws.project)
        ]

    def get_version(self, version_id: str) -> dict[str, Any]:
        v = get_version(self.ws.project, version_id)
        return {
            **v.model_dump(),
            "active": v.id == self.ws.project.review.active_version_id,
            "audio_path": str(version_audio_path(self.ws.project, version_id)),
        }

    def publish(
        self,
        *,
        label: str,
        prefer: str = "premix",
        set_active: bool = True,
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            ver = publish_version(p, label=label, prefer=prefer, set_active=set_active)
            return ver.model_dump()

        return self.ws.mutate(
            "before publish review version",
            "after publish review version",
            mutate,
        )

    def set_active(self, version_id: str | None) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            active = set_active_version(p, version_id)
            return {"active_version_id": active}

        return self.ws.mutate(
            "before set active review version",
            "after set active review version",
            mutate,
        )
