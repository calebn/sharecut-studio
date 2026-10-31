"""Shared base classes for the document edit services."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from podcast_mcp.edits.cut_speech import (
    UnconfirmedCutSpeech,
)
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.engines import room_tone
from podcast_mcp.models import CutIntent, EditMode, EpisodeProject
from podcast_mcp.project.history.rollback import RollbackOutcome
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.tracks import resolve_track

log = logging.getLogger(__name__)


class WorkspaceService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _resolve(self, track_id: str | None, speaker: str | None) -> str:
        return resolve_track(self.ws.project, track_id=track_id, speaker=speaker)


class CutMutatingService(WorkspaceService):
    @contextmanager
    def _record_pools_after_success(self) -> Iterator[None]:
        """After a body that applied without raising, queue the project's missing room-tone pools.

        For a process that never loaded the project through the host (a CLI command, an MCP
        call): the next batch reads the pool, this one picked without it. A body that raises
        queues nothing.
        """
        yield
        try:
            room_tone.schedule_room_tone_pools(self.ws.project)
        except Exception:
            log.debug("room tone pools not scheduled", exc_info=True)

    def _apply_cut(
        self,
        label: str,
        removal: RippleRemoval,
        *,
        operation: str,
        application_intent: CutIntent = CutIntent.PROGRAMMATIC,
        params: dict[str, Any] | None = None,
        ripple: bool = True,
        clip_ids: tuple[str, ...] = (),
    ) -> dict:
        from podcast_mcp.edits.cut_application import TimelineCut, apply_timeline_cut

        def mutate(project: EpisodeProject) -> dict:
            report = apply_timeline_cut(
                project,
                TimelineCut(removal, EditMode.RIPPLE if ripple else EditMode.GAP, clip_ids),
                application_intent=application_intent,
                params=params or {},
                defaults=self.ws.effective_config(),
            )
            report["operation"] = operation
            return report

        return self._mutate_timeline_cut(label, operation, mutate, params or {})

    def _mutate_timeline_cut(
        self,
        label: str,
        operation: str,
        mutate: Callable[[EpisodeProject], dict],
        params: dict[str, Any],
    ) -> dict:
        return mutate_unless_cut_speech_held(self.ws, label, operation, mutate, params)


def mutate_unless_cut_speech_held(
    ws: ProjectWorkspace,
    label: str,
    operation: str,
    mutate: Callable[[EpisodeProject], dict],
    params: dict[str, Any],
) -> dict:
    """Run ``mutate`` as one history step; a held cut returns its confirmation and changes nothing."""
    restored = False

    def on_failure(outcome: RollbackOutcome) -> None:
        nonlocal restored
        restored = outcome is RollbackOutcome.RESTORED

    try:
        return ws.mutate(
            f"before {label}",
            f"after {label}",
            mutate,
            operation=operation,
            params=params or {},
            on_failure=on_failure,
        )
    except UnconfirmedCutSpeech as asked:
        if restored:
            return asked.confirmation.result(operation)
        raise
