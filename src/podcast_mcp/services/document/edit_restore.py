from __future__ import annotations

from typing import Any, TypedDict

from podcast_mcp.edits.edit_log import (
    RestoreResult,
    apply_restores,
    list_applied_edits,
    plan_restores,
    planned_summary,
    restore_state,
)
from podcast_mcp.services.app import ProjectWorkspace


class AppliedEditsWithRestore(TypedDict):
    count: int
    records: list[dict[str, Any]]


def revert_applied(ws: ProjectWorkspace, ids: list[str], dry_run: bool = False) -> RestoreResult:
    """Restore applied edits as one History step; conflicts come back as data."""
    with ws.transaction() as project:
        plans, conflicts = plan_restores(project, ids, defaults=ws.effective_config())
        if conflicts:
            return RestoreResult(status="conflict", conflicts=conflicts)
        if dry_run:
            return RestoreResult(status="planned", summary=planned_summary(plans))
        summary = ws.mutate(
            "before revert applied edits",
            "after revert applied edits",
            lambda p: apply_restores(p, plans, defaults=ws.effective_config()),
            operation="revert_applied_edit",
            params={"ids": ids},
        )
        return RestoreResult(status="restored", summary=summary)


def applied_edits_with_restore(
    ws: ProjectWorkspace,
    *,
    track_id: str | None,
    timeline_start: float | None,
    timeline_end: float | None,
) -> AppliedEditsWithRestore:
    records = list_applied_edits(
        ws.project,
        track_id=track_id,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
    )
    return {
        "count": len(records),
        "records": [
            {**r.model_dump(), "restore": restore_state(ws.project, r).model_dump()}
            for r in records
        ],
    }
