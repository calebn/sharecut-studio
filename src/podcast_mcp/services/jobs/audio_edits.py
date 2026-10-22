from __future__ import annotations

from typing import Any, Literal

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.util.progress import ProgressReporter

AudioEditOp = Literal["apply_bleed_mute", "align_retained_bleed", "mute_off_speaker"]
AUDIO_EDIT_OPS: frozenset[str] = frozenset(
    {"apply_bleed_mute", "align_retained_bleed", "mute_off_speaker"}
)


def run_audio_edit(
    ws: ProjectWorkspace,
    op: AudioEditOp,
    params: dict[str, Any],
    *,
    lock_timeout: float,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    if op not in AUDIO_EDIT_OPS:
        raise ValueError(
            f"unsupported audio edit op {op!r}; expected one of {sorted(AUDIO_EDIT_OPS)}"
        )
    # Imported here because document_sync's marker handlers import the jobs package.
    from podcast_mcp.services.document_sync import after_agent_mutation

    kwargs = {**params, "apply": True, "lock_timeout": lock_timeout}
    if progress is not None:
        kwargs["progress"] = progress
    service = AnalysisService(ws)
    result: dict[str, Any]
    if op == "apply_bleed_mute":
        result = service.apply_bleed_mute(**kwargs)
    elif op == "align_retained_bleed":
        result = service.align_retained_bleed(**kwargs)
    else:
        result = service.mute_off_speaker(**kwargs)
    after_agent_mutation(ws)
    return result
