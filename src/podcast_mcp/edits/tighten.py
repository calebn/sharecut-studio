from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.fillers import (
    _analyze_candidate,
    _apply_analyzed_cut,
    _collect_candidates,
    normalize_edit_mode,
)
from podcast_mcp.models import EditDecision, EpisodeProject
from podcast_mcp.util.parallel import run_parallel


def format_tighten_propose_summary(
    decisions: list[EditDecision],
    skip_counts: dict[str, int] | None = None,
) -> str:
    """Human summary for pipeline/CLI/MCP propose output (includes discourse skips)."""
    fillers = sum(1 for d in decisions if (d.reason or "").startswith("filler:"))
    pauses = sum(1 for d in decisions if (d.reason or "").startswith("pause:"))
    skips = skip_counts or {}
    discourse = sum(n for key, n in skips.items() if key.startswith("discourse:"))
    extra = f", {discourse} discourse kept" if discourse else ""
    return f"{len(decisions)} proposed ({fillers} filler, {pauses} pause{extra})"


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
) -> TightenProposal:
    cfg = dict(defaults)
    tighten = dict(cfg.get("tighten") or {})
    if edit_mode is not None:
        tighten["edit_mode"] = normalize_edit_mode(edit_mode)
    cfg["tighten"] = tighten
    if replace_existing:
        project.edit_decisions = [
            e
            for e in project.edit_decisions
            if e.applied
            or (e.review_required and not (e.reason or "").startswith("filler:acoustic"))
            or not (e.reason or "").startswith(("filler:", "pause:"))
        ]
    from podcast_mcp.edits.transcript_cuts import coalesce_edits

    # Gather candidates across ALL transcripts up front (order preserved: transcript
    # by transcript, word by word -- same order analyze_fillers_and_pauses would
    # visit them in) so the analysis pool below is shared across tracks instead of
    # parallelizing one track at a time.
    # skip_counts is filled only on this thread during collection; do not share it
    # across run_parallel workers.
    skip_counts: dict[str, int] = {}
    audio_caches = build_track_audio_caches(project, {t.track_id for t in project.transcripts})
    candidates = [
        candidate
        for transcript in project.transcripts
        for candidate in _collect_candidates(
            transcript,
            cfg,
            project=project,
            skip_counts=skip_counts,
            audio_cache=audio_caches.get(transcript.track_id),
        )
    ]

    # Decode each track's raw audio once up front (see edits/audio_cache.py) instead
    # of spawning an ffmpeg subprocess per tiny window read inside every candidate's
    # analysis -- this is the dominant cost at scale, well beyond what thread-pool
    # parallelism alone can buy back. Read-only; safe to share across the pool below.
    max_workers = cfg.get("performance", {}).get("max_workers")
    results = run_parallel(
        candidates,
        lambda c: _analyze_candidate(project, c, cfg, audio_cache=audio_caches.get(c.track_id)),
        max_workers=max_workers,
    )

    # Apply serially, in the same order the candidates were gathered, so decision
    # ordering/coalescing behavior is identical to the fully-serial path.
    proposed: list[EditDecision] = [
        _apply_analyzed_cut(project, result) for result in results if result is not None
    ]
    proposed_ids = {decision.id for decision in proposed}
    for track_id in {t.track_id for t in project.transcripts}:
        coalesce_edits(project, track_id=track_id)
    this_run = [e for e in project.edit_decisions if e.id in proposed_ids]
    return TightenProposal(decisions=this_run, skip_counts=dict(skip_counts))


def apply_tighten_decisions(project: EpisodeProject) -> int:
    from podcast_mcp.edits.decisions import apply_auto_edits

    return apply_auto_edits(project)
