from __future__ import annotations

from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_quality import _filter_rows_by_time
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    compute_word_audibility_map,
    list_flagged_words,
)
from podcast_mcp.engines.overlap_report import overlap_duplicate_report as overlap_duplicate_report
from podcast_mcp.engines.reconciliation_state import (
    reconciliation_is_stale,
    reconciliation_status,
)
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.progress import ProgressReporter


def audibility_map(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    return compute_word_audibility_map(
        project, track_id=track_id, policy=policy, progress=progress, defaults=defaults
    )


def flagged_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    return list_flagged_words(
        project, track_id=track_id, policy=policy, progress=progress, defaults=defaults
    )


def run_reconciliation(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    dry_run: bool | None = None,
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    progress: ProgressReporter | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    if dry_run is None:
        apply_suppression = pol.transcript_mode == "reconcile"
        update_status = pol.transcript_mode in ("flag", "suggest", "reconcile")
    else:
        apply_suppression = not dry_run
        update_status = not dry_run
    result = reconcile_transcript(
        project,
        policy=pol,
        dry_run=not apply_suppression,
        track_id=track_id,
        update_status=update_status,
        start_sec=start_sec,
        end_sec=end_sec,
        progress=progress,
        defaults=defaults,
    )
    out = result.to_dict()
    if start_sec is not None or end_sec is not None:
        out["suppress"] = _filter_rows_by_time(
            out.get("suppress", []), start_sec=start_sec, end_sec=end_sec
        )
        out["unsuppress"] = _filter_rows_by_time(
            out.get("unsuppress", []), start_sec=start_sec, end_sec=end_sec
        )
        out["reattribute"] = _filter_rows_by_time(
            out.get("reattribute", []), start_sec=start_sec, end_sec=end_sec
        )
        out["suppress_count"] = len(out["suppress"])
        out["unsuppress_count"] = len(out["unsuppress"])
        out["reattribute_count"] = len(out["reattribute"])
    out["reconciliation"] = reconciliation_status(project, defaults=defaults)
    return out


def reconciliation_status_report(
    project: EpisodeProject, *, defaults: EffectiveConfig
) -> dict[str, Any]:
    return reconciliation_status(project, defaults=defaults)


def maybe_auto_reconcile(
    project: EpisodeProject,
    *,
    track_ids: list[str] | None = None,
    force: bool = False,
    policy: AnalysisPolicy | None = None,
    defaults: EffectiveConfig,
    progress: ProgressReporter | None = None,
) -> dict[str, Any] | None:
    """Refresh transcript audibility metadata when audio state may have changed."""
    pol = policy or AnalysisPolicy.from_defaults(defaults)
    if pol.transcript_mode == "off":
        return None
    if not force and not reconciliation_is_stale(project, defaults=defaults):
        return None

    if track_ids:
        result: dict[str, Any] | None = None
        for tid in track_ids:
            result = run_reconciliation(
                project,
                policy=pol,
                dry_run=None,
                track_id=tid,
                progress=progress,
                defaults=defaults,
            )
        return result

    return run_reconciliation(
        project, policy=pol, dry_run=None, progress=progress, defaults=defaults
    )
