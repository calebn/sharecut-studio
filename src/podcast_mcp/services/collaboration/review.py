"""ReviewService - freeze review mix versions via ProjectWorkspace.mutate."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_versions import (
    DirectoryIdentity,
    MediaIdentity,
    attach_version,
    clean_created_version,
    discard_created_version,
    get_version,
    list_versions,
    promote_staged_version,
    set_active_version,
    stage_version,
    sweep_stale_quarantines,
    version_audio_path,
)
from podcast_mcp.history.rollback import RollbackOutcome
from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
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
        created: tuple[Path, DirectoryIdentity] | None = None
        media_identity: MediaIdentity | None = None
        public: Path | None = None
        failure_outcome_received = False

        def remember_media(path: Path, identity: DirectoryIdentity) -> None:
            nonlocal created
            created = (path, identity)

        def remember_ready(identity: MediaIdentity) -> None:
            nonlocal media_identity
            media_identity = identity

        sweep_stale_quarantines(project)
        with project_state_lock(project):
            # Media creation (copy + MP3) stays outside the cross-process file lock, but
            # inside the in-process state lock: other threads on this workspace (mutations,
            # render snapshots, GUI requests) wait for the encode, which keeps stage +
            # attach atomic within this process.
            ver = stage_version(
                project,
                label=label,
                prefer=prefer,
                on_media_created=remember_media,
                on_media_ready=remember_ready,
            )
            recorded = created

            def handle_failure(outcome: RollbackOutcome) -> None:
                nonlocal failure_outcome_received
                failure_outcome_received = True
                if (
                    outcome is RollbackOutcome.RESTORED
                    and recorded is not None
                    and public is not None
                ):
                    self._clean_uncommitted_media(ver.id, public, recorded[1])
                elif outcome in {RollbackOutcome.UNKNOWN, RollbackOutcome.KEPT}:
                    log.warning(
                        "Keeping review version media after failed publication (%s): %s",
                        outcome,
                        public,
                    )

            try:
                with project_commit_lock(project):
                    assert recorded is not None
                    assert media_identity is not None
                    try:
                        public = promote_staged_version(
                            recorded[0], recorded[1], ver.id, expected_media=media_identity
                        )
                    except BaseException:
                        discard_created_version(recorded[0], recorded[1])
                        discard_created_version(recorded[0].with_name(ver.id), recorded[1])
                        raise

                    # attach_version only touches project.review, so the audio fingerprint
                    # is unchanged and run_mutation never auto-reconciles here; the commit
                    # lock hold stays short.
                    def mutate(p) -> dict[str, Any]:
                        attach_version(p, ver, set_active=set_active)
                        return ver.model_dump()

                    return self.ws.mutate(
                        "before publish review version",
                        "after publish review version",
                        mutate,
                        on_failure=handle_failure,
                    )
            except BaseException:
                if not failure_outcome_received and recorded is not None:
                    if public is None:
                        discard_created_version(recorded[0], recorded[1])
                    else:
                        log.warning(
                            "Keeping review version media without rollback outcome: %s", public
                        )
                raise

    def _clean_uncommitted_media(
        self,
        version_id: str,
        created_dir: Path,
        identity: DirectoryIdentity,
    ) -> None:
        try:
            persisted = load_project(self.ws.path)
            self.ws.project = persisted
            if any(version.id == version_id for version in persisted.review.versions):
                return
            clean_created_version(created_dir, identity)
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
