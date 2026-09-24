"""ReviewService - freeze review mix versions via ProjectWorkspace.mutate."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_versions import (
    DirectoryIdentity,
    clean_created_version,
    get_version,
    list_versions,
    publish_version,
    set_active_version,
    version_audio_path,
)
from podcast_mcp.models import load_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic

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
        history_index_path = self.ws.project.workspace_path() / "history" / "index.json"
        history_before = load_json_object(history_index_path)
        created: tuple[Path, DirectoryIdentity] | None = None
        version_id: str | None = None

        def remember_media(path: Path, identity: DirectoryIdentity) -> None:
            nonlocal created
            created = (path, identity)

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
            recorded = created
            if version_id is not None and recorded is not None:
                self._clean_uncommitted_media(
                    version_id, recorded[0], recorded[1], history_index_path, history_before
                )
            raise

    def _clean_uncommitted_media(
        self,
        version_id: str,
        created_dir: Path,
        identity: DirectoryIdentity,
        history_index_path: Path,
        history_before: dict[str, Any] | None,
    ) -> None:
        """Undo only this publication's sidecars if canonical commit did not land."""
        try:
            persisted = load_project(self.ws.path)
            if any(version.id == version_id for version in persisted.review.versions):
                self.ws.project = persisted
                return
            expected_index = self.ws.project.history.model_dump(mode="json")
            self.ws.project = persisted
            current_index = load_json_object(history_index_path)
            if current_index not in (history_before, expected_index):
                log.warning(
                    "Review history changed during failed publication; keeping %s", created_dir
                )
                return
            if current_index != history_before:
                if history_before is None:
                    history_index_path.unlink()
                else:
                    write_json_atomic(history_index_path, history_before)
                old_ids = (
                    {entry.id for entry in ProjectHistory.model_validate(history_before).entries}
                    if history_before is not None
                    else set()
                )
                for entry in ProjectHistory.model_validate(current_index).entries:
                    if entry.id not in old_ids:
                        snapshot = history_index_path.parent / "snapshots" / f"{entry.id}.json"
                        snapshot.unlink(missing_ok=True)
            clean_created_version(created_dir, identity)
            self.ws.project = persisted
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
