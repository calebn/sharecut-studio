from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.fillers import (
    _add_acoustic_candidates,
    _apply_analyzed_cut,
    _collect_candidates,
    _CutCandidate,
    _peer_speech_indexes,
    _resolve_analyzed_cuts,
    _speaker_cut_context,
    _word_indexes,
    analyze_candidates,
    normalize_edit_mode,
)
from podcast_mcp.edits.mute_regions import muted_source_spans
from podcast_mcp.edits.tighten_intensity import with_tighten_intensity
from podcast_mcp.edits.tighten_reasons import (
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
    is_acoustic_filler_reason,
    is_review_only_reason,
)
from podcast_mcp.models import EditDecision, EpisodeProject, Transcript
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.tracks import dialogue_track_ids


def format_tighten_propose_summary(
    decisions: list[EditDecision],
    skip_counts: dict[str, int] | None = None,
) -> str:
    """Human summary for pipeline/CLI/MCP propose output (includes discourse and backchannel skips)."""
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
    backchannels = sum(n for key, n in skips.items() if key.startswith("backchannel:"))
    acoustic_skipped = sum(n for key, n in skips.items() if key.startswith("acoustic:"))
    extra = f", {discourse} discourse kept" if discourse else ""
    extra += f", {backchannels} backchannel kept" if backchannels else ""
    repeat_text = f", {repetitions} repetition/restart" if repetitions else ""
    acoustic_text = f", {acoustic} acoustic (review)" if acoustic else ""
    acoustic_skip_text = f", {acoustic_skipped} acoustic skipped" if acoustic_skipped else ""
    return (
        f"{len(decisions)} proposed ({fillers} filler, {pauses} pause"
        f"{repeat_text}{acoustic_text}{extra}{acoustic_skip_text})"
    )


def _keep_on_reproposal(decision: EditDecision) -> bool:
    """Whether ``replace_existing`` re-proposal keeps an existing decision.

    Re-proposal replaces every pending decision the generator owns, so Find hits
    on an unchanged project returns the same hits on every run.  A generated
    review flag (``voiced_edge``, ``risky``, ``other_speaking``) is analysis
    output, not ownership; a kept pending copy would absorb its fresh duplicate
    in coalescing and drop out of the proposal.  Applied review-only
    proposals (acoustic, repetition, restart) and applied review-flagged
    ``filler:`` / ``pause:`` cuts are kept; applied ordinary ones regenerate.
    Everything else (manual / NL / focus edits) is kept.
    """
    reason = decision.reason or ""
    if is_review_only_reason(reason):
        return decision.applied
    if reason.startswith(("filler:", "pause:")):
        return decision.applied and decision.review_required
    return True


@dataclass(frozen=True)
class TightenProposal:
    """Pending filler/pause decisions plus counted discourse and backchannel skips."""

    decisions: list[EditDecision]
    skip_counts: dict[str, int]

    def summary(self) -> str:
        return format_tighten_propose_summary(self.decisions, self.skip_counts)

    def to_payload(self) -> dict[str, Any]:
        """JSON-ready payload matching the ``propose_edits`` MCP tool's shape."""
        return {
            "operation": "propose_edits",
            "edits": [e.model_dump() for e in self.decisions],
            "skip_counts": self.skip_counts,
            "summary": self.summary(),
        }


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
    cfg = with_tighten_intensity(defaults, intensity)
    if edit_mode is not None:
        cfg["tighten"]["edit_mode"] = normalize_edit_mode(edit_mode)
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
    # Every dialogue track is decoded, a transcript or not: a session ripple removes the
    # same window from all of them, and a pause trim reads each (``SessionAir``).
    audio_caches = build_track_audio_caches(
        project, {*dialogue_track_ids(project), *(t.track_id for t in project.transcripts)}
    )
    peer_indexes = _peer_speech_indexes(project)
    max_workers = cfg.get("performance", {}).get("max_workers")

    def _gather(transcript: Transcript) -> tuple[list[_CutCandidate], dict[str, int]]:
        # Per-track skip counts: each worker fills its own dict, merged below.
        counts: dict[str, int] = {}
        found = _add_acoustic_candidates(
            _collect_candidates(
                transcript,
                cfg,
                project=project,
                skip_counts=counts,
                peer_indexes=peer_indexes,
            ),
            transcript,
            cfg,
            project=project,
            audio_cache=audio_caches.get(transcript.track_id),
            audio_caches=audio_caches,
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

    speaker_context = _speaker_cut_context(project) if candidates else None
    word_indexes = _word_indexes(project, candidates)
    results = analyze_candidates(
        project,
        candidates,
        cfg,
        audio_caches=audio_caches,
        speaker_context=speaker_context,
        peer_indexes=peer_indexes,
        word_indexes=word_indexes,
        max_workers=max_workers,
    )
    resolved = _resolve_analyzed_cuts(
        candidates,
        results,
        existing=retained if retained is not None else list(project.edit_decisions),
        muted=muted_source_spans(project),
        skip_counts=skip_counts,
        project=project,
    )

    working = project.model_copy(deep=True)
    if retained is not None:
        working.edit_decisions = retained
    # Apply serially, in the same order the candidates were gathered, so decision
    # ordering/coalescing behavior is identical to the fully-serial path.
    proposed: list[EditDecision] = [_apply_analyzed_cut(working, result) for result in resolved]
    proposed_ids = {decision.id for decision in proposed}
    # Transcript order, not a set: coalescing moves each track's decisions to the
    # end, so the proposal's order must not depend on string hashing.
    for track_id in dict.fromkeys(t.track_id for t in project.transcripts):
        coalesce_edits(
            working,
            track_id=track_id,
            defaults=cfg,
            skip_counts=skip_counts,
            merge_ids=proposed_ids,
        )
    project.edit_decisions = working.edit_decisions
    this_run = [e for e in project.edit_decisions if e.id in proposed_ids]
    return TightenProposal(decisions=this_run, skip_counts=dict(skip_counts))


def apply_tighten_decisions(project: EpisodeProject) -> int:
    from podcast_mcp.edits.decisions import apply_auto_edits

    return apply_auto_edits(project)
