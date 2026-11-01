"""Revising the latest Apply suggested actions batch."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.models import CutIntent
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError


def revise_suggested_actions(
    ws: ProjectWorkspace,
    apply: Callable[..., dict[str, Any]],
    overrides: dict[str, str],
    application_intent: CutIntent,
    skip_unsure: bool = False,
) -> dict[str, Any]:
    """Re-apply the latest Apply suggested actions batch with ``overrides`` on top."""
    from podcast_mcp.services.document.history import HistoryService

    mgr = ws.history()
    history = HistoryService(ws)
    with ws.transaction() as project:
        index = mgr.tip_entry_index(project, "apply_suggested_actions")
        params = mgr.entry(project, index).params if index is not None else None
        requested = (params or {}).get("requested")
        if index is None or not isinstance(requested, dict):
            raise CodedValueError(
                "Nothing to revise: the latest edit is not an Apply suggested actions "
                "batch. Undo the later changes first.",
                code="no_suggested_batch_to_revise",
            )
        strangers = sorted(set(overrides) - set(requested))
        if strangers:
            raise CodedValueError(
                f"{strangers[0]!r} was not part of the latest batch",
                code="sound_not_in_batch",
            )
        if index < 1:
            raise CodedValueError(
                "Nothing to revise: the batch's starting state is no longer in history.",
                code="no_suggested_batch_to_revise",
            )
        tip = mgr.status(project).cursor
        history.goto(index - 1)
        try:
            result = apply(
                sorted(requested),
                overrides={**requested, **overrides},
                application_intent=application_intent,
                skip_unsure=skip_unsure,
            )
        except BaseException:
            history.goto(tip)
            raise
        if mgr.status(project).cursor == index - 1:
            # Nothing was recorded (every sound was held), so the batch would stay undone.
            history.goto(tip)
            raise CodedValueError(
                "Nothing changed: none of the sounds could be applied with those actions "
                f"({', '.join(result['held'])} stayed pending).",
                code="revise_held",
            )
        return result
