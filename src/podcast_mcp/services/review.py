"""ReviewService - freeze review mix versions via ProjectWorkspace.mutate."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_versions import (
    DirectoryIdentity,
    attach_version,
    clean_created_version,
    discard_created_version,
    get_version,
    list_versions,
    set_active_version,
    stage_version,
    version_audio_path,
)
from podcast_mcp.models import load_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import restore_history_index
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.project_state import project_commit_lock, project_state_lock

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
        project = self.ws.project
        history_index_path = project.workspace_path() / "history" / "index.json"
        created: tuple[Path, DirectoryIdentity] | None = None

        def remember_media(path: Path, identity: DirectoryIdentity) -> None:
            nonlocal created
            created = (path, identity)

        with project_state_lock(project):
            # Media creation (copy + MP3) stays outside the cross-process file lock, but
            # inside the in-process state lock: other threads on this workspace (mutations,
            # render snapshots, GUI requests) wait for the encode, which keeps stage +
            # attach atomic within this process.
            ver = stage_version(
                project, label=label, prefer=prefer, on_media_created=remember_media
            )
            recorded = created
            mutation_started = False
            try:
                with project_commit_lock(project):
                    history_before = load_json_object(history_index_path)

                    # attach_version only touches project.review, so the audio fingerprint
                    # is unchanged and run_mutation never auto-reconciles here; the commit
                    # lock hold stays short.
                    def mutate(p) -> dict[str, Any]:
                        attach_version(p, ver, set_active=set_active)
                        return ver.model_dump()

                    mutation_started = True
                    try:
                        return self.ws.mutate(
                            "before publish review version",
                            "after publish review version",
                            mutate,
                        )
                    except BaseException:
                        if recorded is not None:
                            self._clean_uncommitted_media(
                                ver.id, recorded[0], recorded[1], history_index_path, history_before
                            )
                        raise
            except BaseException:
                # Lock timeout, lock-file I/O, or an unreadable history index: nothing
                # references the staged version yet, so remove its media here.
                if not mutation_started and recorded is not None:
                    discard_created_version(recorded[0], recorded[1])
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
                restore_history_index(history_index_path, history_before)
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
