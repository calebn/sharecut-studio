from __future__ import annotations

import json

from podcast_mcp.edits.transcript_reconcile import maybe_auto_reconcile
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.play_audit import premix_path
from podcast_mcp.engines.reconciliation_state import (
    audio_state_fingerprint,
    mark_reconciliation_fresh,
    mark_reconciliation_stale,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.pipeline import PipelineRunner
from podcast_mcp.util.progress import NullProgress, ProgressReporter, resolve_progress_task
from podcast_mcp.util.project_state import with_render_lock


@with_render_lock
def rerender_preview(
    project: EpisodeProject,
    *,
    reconcile: bool | None = None,
    progress: ProgressReporter | None = None,
) -> dict[str, str | float | int | dict | None]:
    runner = PipelineRunner()
    policy = AnalysisPolicy.from_defaults()
    should_reconcile = reconcile
    if should_reconcile is None:
        should_reconcile = policy.reconcile_on_render and policy.transcript_mode != "off"
    reconcile_before_gate = should_reconcile and any(
        track.transcript_gate for track in project.tracks
    )
    reconciliation_result: dict | None = None
    reconciled_fingerprint: str | None = None
    with resolve_progress_task(
        "render",
        "Rendering preview",
        total=3,
        prefer_parent=True,
        progress=progress,
    ) as task:
        if reconcile_before_gate:
            reconciliation_result = maybe_auto_reconcile(
                project, force=True, policy=policy, progress=None
            )
            if not project.reconciliation_stale:
                reconciled_fingerprint = project.last_reconciliation_hash
        runner.run(project, only_step="assemble_timeline", progress=NullProgress())
        task.advance(1, message="Assembled timeline", total=3)
        runner.run(project, only_step="mix_with_music", progress=NullProgress())
        task.advance(1, message="Mixed music", total=3)
        premix = premix_path(project)
        edit_count = sum(1 for e in project.edit_decisions if e.applied)
        if should_reconcile:
            if not reconcile_before_gate:
                reconciliation_result = maybe_auto_reconcile(
                    project,
                    force=True,
                    policy=policy,
                    progress=None,
                )
            elif reconciled_fingerprint == audio_state_fingerprint(project):
                mark_reconciliation_fresh(project)
            if reconciliation_result is not None:
                reconciliation_result["stale"] = project.reconciliation_stale
            task.advance(1, message="Reconciled transcript", total=3)
        else:
            mark_reconciliation_stale(project)
            task.advance(1, message="Skipped reconciliation", total=3)
        if not premix.is_file():
            out: dict[str, str | float | int | dict | None] = {
                "path": None,
                "ok": False,
                "edit_count": edit_count,
            }
            if reconciliation_result is not None:
                out["reconciliation"] = reconciliation_result
            return out
        out = {
            "path": str(premix),
            "ok": True,
            "edit_count": edit_count,
        }
        if reconciliation_result is not None:
            out["reconciliation"] = reconciliation_result
        return out


def render_preview_result(project: EpisodeProject, rerender: bool = True) -> str:
    if rerender:
        info = rerender_preview(project)
    else:
        premix = premix_path(project)
        info = {
            "path": str(premix) if premix.is_file() else None,
            "ok": premix.is_file(),
            "edit_count": sum(1 for e in project.edit_decisions if e.applied),
        }
    return json.dumps(info, indent=2)
