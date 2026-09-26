from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.fillers import (
    _add_acoustic_candidates,
    _analyze_candidate,
    _apply_analyzed_cut,
    _collect_candidates,
    _CutCandidate,
    _resolve_analyzed_cuts,
    normalize_edit_mode,
)
from podcast_mcp.edits.tighten_intensity import apply_tighten_intensity
from podcast_mcp.edits.tighten_reasons import (
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
    is_acoustic_filler_reason,
    is_review_only_reason,
)
from podcast_mcp.models import EditDecision, EpisodeProject, Transcript
from podcast_mcp.util.parallel import run_parallel


def format_tighten_propose_summary(
    decisions: list[EditDecision],
    skip_counts: dict[str, int] | None = None,
) -> str:
    """Human summary for pipeline/CLI/MCP propose output (includes discourse skips)."""
    acoustic = sum(1 for d in decisions if is_acoustic_filler_reason(d.reason))
    fillers = sum(1 for d in decisions if (d.reason or "").startswith("filler:")) - acoustic
    pauses = sum(1 for d in decisions if (d.reason or "").startswith("pause:"))
    repetitions = sum(
        1
        for d in decisions
        if (d.reason or "").startswith((REPETITION_REASON_PREFIX, RESTART_REASON_PREFIX))
    )
    skips = skip_counts or {}
    discourse = sum(n for key, n in skips.items() if key.startswith("discourse:"))
    acoustic_skipped = sum(n for key, n in skips.items() if key.startswith("acoustic:"))
    extra = f", {discourse} discourse kept" if discourse else ""
    repeat_text = f", {repetitions} repetition/restart" if repetitions else ""
    acoustic_text = f", {acoustic} acoustic (review)" if acoustic else ""
    acoustic_skip_text = f", {acoustic_skipped} acoustic skipped" if acoustic_skipped else ""
    return (
        f"{len(decisions)} proposed ({fillers} filler, {pauses} pause"
        f"{repeat_text}{acoustic_text}{extra}{acoustic_skip_text})"
    )


def _keep_on_reproposal(decision: EditDecision) -> bool:
    """Whether ``replace_existing`` re-proposal keeps an existing decision.

    Generated review-only proposals (acoustic, repetition, restart) are kept only
    once a human applied them; pending ones are regenerated.  Other generated
    ``filler:`` / ``pause:`` decisions are regenerated unless flagged for review
    (applied or not, exactly as before acoustic candidates existed).  Everything
    else (manual / NL / focus edits) is kept.
    """
    reason = decision.reason or ""
    if is_review_only_reason(reason):
        return decision.applied
    return decision.review_required or not reason.startswith(("filler:", "pause:"))


@dataclass(frozen=True)
class TightenProposal:
    """Pending filler/pause decisions plus counted discourse skips."""

    decisions: list[EditDecision]
    skip_counts: dict[str, int]

    def summary(self) -> str:
        return format_tighten_propose_summary(self.decisions, self.skip_counts)


def propose_tighten_edits(
    project: EpisodeProject,
    defaults: dict[str, Any],
    *,
    replace_existing: bool = True,
    edit_mode: str | None = None,
    intensity: str | None = None,
) -> TightenProposal:
    """Propose tighten decisions (never applies).

    ``intensity`` (light/medium/aggressive) overrides ``tighten.intensity``; see
    :mod:`podcast_mcp.edits.tighten_intensity`.
    """
    cfg = dict(defaults)
    tighten = apply_tighten_intensity(dict(cfg.get("tighten") or {}), intensity)
    if edit_mode is not None:
        tighten["edit_mode"] = normalize_edit_mode(edit_mode)
    cfg["tighten"] = tighten
    # Decide what re-proposal keeps now, but only mutate the project after the
    # DSP gather/analysis below succeeds (the pipeline step path has no
    # ProjectWorkspace.mutate rollback).
    retained = (
        [e for e in project.edit_decisions if _keep_on_reproposal(e)] if replace_existing else None
    )
    from podcast_mcp.edits.transcript_cuts import coalesce_edits

    # Decode each track's raw audio once up front (see edits/audio_cache.py) instead
    # of spawning an ffmpeg subprocess per tiny window read inside every candidate's
    # analysis -- this is the dominant cost at scale, well beyond what thread-pool
    # parallelism alone can buy back. Read-only; safe to share across the pools below.
    audio_caches = build_track_audio_caches(project, {t.track_id for t in project.transcripts})
    max_workers = cfg.get("performance", {}).get("max_workers")

    def _gather(transcript: Transcript) -> tuple[list[_CutCandidate], dict[str, int]]:
        # Per-track skip counts: each worker fills its own dict, merged below.
        counts: dict[str, int] = {}
        found = _add_acoustic_candidates(
            _collect_candidates(transcript, cfg, project=project, skip_counts=counts),
            transcript,
            cfg,
            project=project,
            audio_cache=audio_caches.get(transcript.track_id),
            skip_counts=counts,
        )
        return found, counts

    # Gather candidates per transcript in parallel (the acoustic gap scan is
    # per-gap DSP), keeping transcript order -- the same order
    # analyze_fillers_and_pauses visits them in -- so the analysis pool below is
    # shared across tracks instead of parallelizing one track at a time.
    skip_counts: dict[str, int] = {}
    candidates: list[_CutCandidate] = []
    for found, counts in run_parallel(list(project.transcripts), _gather, max_workers=max_workers):
        candidates.extend(found)
        for key, n in counts.items():
            skip_counts[key] = skip_counts.get(key, 0) + n

    results = run_parallel(
        candidates,
        lambda c: _analyze_candidate(project, c, cfg, audio_cache=audio_caches.get(c.track_id)),
        max_workers=max_workers,
    )
    resolved = _resolve_analyzed_cuts(
        candidates,
        results,
        existing=retained if retained is not None else list(project.edit_decisions),
        skip_counts=skip_counts,
    )

    if retained is not None:
        project.edit_decisions = retained
    # Apply serially, in the same order the candidates were gathered, so decision
    # ordering/coalescing behavior is identical to the fully-serial path.
    proposed: list[EditDecision] = [_apply_analyzed_cut(project, result) for result in resolved]
    proposed_ids = {decision.id for decision in proposed}
    for track_id in {t.track_id for t in project.transcripts}:
        coalesce_edits(project, track_id=track_id)
    this_run = [e for e in project.edit_decisions if e.id in proposed_ids]
    return TightenProposal(decisions=this_run, skip_counts=dict(skip_counts))


def apply_tighten_decisions(project: EpisodeProject) -> int:
    from podcast_mcp.edits.decisions import apply_auto_edits

    return apply_auto_edits(project)
