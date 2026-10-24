from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from podcast_mcp.project.merge import project_merge_data
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.service import after_agent_mutation

T = TypeVar("T")


def apply_external_document_edit(ws: ProjectWorkspace, apply: Callable[[], T]) -> T:
    """Notify after a changed, committed service call outside typed submission.

    The operation owns saving and history. Do not pass previews, document submits,
    or audio jobs that already notify.
    Publication remains best effort after project ownership ends.
    """
    with ws.transaction():
        before = project_merge_data(ws.project)
        result = apply()
        changed = before != project_merge_data(ws.project)
    if changed:
        after_agent_mutation(ws)
    return result
