from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.util.progress import ProgressReporter

AudioEditOp = Literal["apply_bleed_mute", "align_retained_bleed", "mute_off_speaker"]


def run_audio_edit(
    ws: ProjectWorkspace,
    op: AudioEditOp,
    params: dict[str, Any],
    *,
    lock_timeout: float,
    cancel_check: Callable[[], bool] | None = None,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    # Imported here because document_sync's marker handlers import the jobs package.
    from podcast_mcp.services.document_sync import after_agent_mutation

    kwargs = {**params, "apply": True, "lock_timeout": lock_timeout, "cancel_check": cancel_check}
    if progress is not None:
        kwargs["progress"] = progress
    result: dict[str, Any] = getattr(AnalysisService(ws), op)(**kwargs)
    after_agent_mutation(ws)
    return result
