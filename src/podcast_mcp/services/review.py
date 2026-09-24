"""ReviewService - freeze review mix versions via ProjectWorkspace.mutate."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_versions import (
    get_version,
    list_versions,
    publish_version,
    set_active_version,
    version_audio_path,
)
from podcast_mcp.models import load_project
from podcast_mcp.services.workspace import ProjectWorkspace

log = logging.getLogger(__name__)


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
        created_dir: Path | None = None
        created_identity: tuple[int, int] | None = None
        version_id: str | None = None

        def remember_media(path: Path) -> None:
            nonlocal created_dir, created_identity
            metadata = path.stat(follow_symlinks=False)
            created_dir = path
            created_identity = (metadata.st_dev, metadata.st_ino)

        def mutate(p) -> dict[str, Any]:
            nonlocal version_id
            ver = publish_version(
                p,
                label=label,
                prefer=prefer,
                set_active=set_active,
                on_media_created=remember_media,
            )
            version_id = ver.id
            return ver.model_dump()

        try:
            return self.ws.mutate(
                "before publish review version",
                "after publish review version",
                mutate,
            )
        except BaseException:
            if version_id is not None and created_dir is not None:
                self._clean_uncommitted_media(version_id, created_dir, created_identity)
            raise

    def _clean_uncommitted_media(
        self, version_id: str, created_dir: Path, identity: tuple[int, int] | None
    ) -> None:
        """Keep media if the canonical project commit succeeded before a later error."""
        try:
            persisted = load_project(self.ws.path)
            if any(version.id == version_id for version in persisted.review.versions):
                self.ws.project = persisted
                return
            self.ws.project = persisted
            metadata = created_dir.stat(follow_symlinks=False)
            if identity != (metadata.st_dev, metadata.st_ino):
                log.warning("Review version directory changed; keeping %s", created_dir)
                return
            shutil.rmtree(created_dir)
        except BaseException:
            log.warning("Could not clean uncommitted review version %s", created_dir, exc_info=True)

    def set_active(self, version_id: str | None) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            active = set_active_version(p, version_id)
            return {"active_version_id": active}

        return self.ws.mutate(
            "before set active review version",
            "after set active review version",
            mutate,
        )
