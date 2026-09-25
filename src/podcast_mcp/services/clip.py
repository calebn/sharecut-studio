from __future__ import annotations

import builtins
from collections.abc import Sequence

from podcast_mcp.clips import (
    add_manual_social_clip,
    approve_social_clips,
    export_social_clips,
    format_social_clip_report,
    list_social_clips,
    propose_social_clips,
    reject_social_clips,
    update_social_clip_times,
)
from podcast_mcp.config import load_defaults
from podcast_mcp.engines.waveform_media import ensure_project_waveforms
from podcast_mcp.models import SocialClipCandidate
from podcast_mcp.services.workspace import ProjectWorkspace


class ClipService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self._defaults = load_defaults()

    def propose(
        self,
        *,
        platform: str | None = None,
        max_clips: int | None = None,
    ) -> list[SocialClipCandidate]:
        # Energy scoring reads only each track's own ``track:<id>`` pyramid. Build
        # missing ones inline (a no-op when ready) so the ranking never depends on
        # whether a background build has finished. Built outside the mutation lock.
        ensure_project_waveforms(self.ws.project, sources=False)

        def mutate(p) -> list[SocialClipCandidate]:
            return propose_social_clips(p, self._defaults, platform=platform, max_clips=max_clips)

        return self.ws.mutate(
            "before propose social clips",
            "after propose social clips",
            mutate,
        )

    def list(
        self,
        *,
        approved: bool | None = None,
        review_required: bool | None = None,
    ) -> list[SocialClipCandidate]:
        return list_social_clips(
            self.ws.project,
            approved=approved,
            review_required=review_required,
        )

    def approve(self, ids: Sequence[str]) -> int:
        def mutate(p) -> int:
            return approve_social_clips(p, list(ids))

        return self.ws.mutate(
            "before approve social clips",
            "after approve social clips",
            mutate,
        )

    def reject(self, ids: Sequence[str]) -> int:
        def mutate(p) -> int:
            return reject_social_clips(p, list(ids))

        return self.ws.mutate(
            "before reject social clips",
            "after reject social clips",
            mutate,
        )

    def add_manual(
        self,
        *,
        track_id: str,
        start: float,
        end: float,
        title: str | None = None,
    ) -> SocialClipCandidate:
        def mutate(p) -> SocialClipCandidate:
            return add_manual_social_clip(p, track_id=track_id, start=start, end=end, title=title)

        return self.ws.mutate(
            "before add social clip",
            "after add social clip",
            mutate,
        )

    def update_times(self, clip_id: str, *, start: float, end: float) -> SocialClipCandidate:
        def mutate(p) -> SocialClipCandidate:
            return update_social_clip_times(p, clip_id, start=start, end=end)

        return self.ws.mutate(
            "before update social clip",
            "after update social clip",
            mutate,
        )

    def report(self) -> str:
        return format_social_clip_report(self.ws.project)

    # builtins.list because the `list` method above shadows the builtin in
    # this class's annotation scope.
    def export(self, ids: Sequence[str] | None = None) -> builtins.list[dict[str, str]]:
        exported = export_social_clips(
            self.ws.project, self._defaults, ids=list(ids) if ids is not None else None
        )
        self.ws.save()
        return exported
