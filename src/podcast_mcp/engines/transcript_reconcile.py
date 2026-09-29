from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.edits.bleed_text_match import overlap_text_match_losers
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCacheSet,
    build_track_rms_caches,
    compute_word_audibility_map,
)
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.progress import (
    ProgressReporter,
    resolve_progress_task,
)


@dataclass
class ReconciliationResult:
    suppress: list[dict[str, Any]] = field(default_factory=list)
    unsuppress: list[dict[str, Any]] = field(default_factory=list)
    reattribute: list[dict[str, Any]] = field(default_factory=list)
    status_updates: int = 0
    applied: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "suppress": self.suppress,
            "unsuppress": self.unsuppress,
            "reattribute": self.reattribute,
            "status_updates": self.status_updates,
            "applied": self.applied,
            "suppress_count": len(self.suppress),
            "unsuppress_count": len(self.unsuppress),
            "reattribute_count": len(self.reattribute),
        }


def _should_suppress(status: str) -> bool:
    return status in ("inaudible", "bleed")


def _in_time_window(
    start: float,
    *,
    start_sec: float | None,
    end_sec: float | None,
) -> bool:
    if start_sec is not None and start < start_sec:
        return False
    return not (end_sec is not None and start >= end_sec)


def _reconciles_word(w: TranscriptWord, *, start_sec: float | None, end_sec: float | None) -> bool:
    """Whether a pass may write this word: inside the window, and never over an ``ignored``
    word or a decision a person or agent locked (#768)."""
    if w.ignored or w.audibility_locked:
        return False
    return _in_time_window(w.start, start_sec=start_sec, end_sec=end_sec)


def _reconcile_word(
    tr: Transcript,
    i: int,
    row: dict[str, Any],
    result: ReconciliationResult,
    *,
    update_status: bool,
    apply_suppression: bool,
    start_sec: float | None,
    end_sec: float | None,
) -> None:
    w = tr.words[i]
    if not _reconciles_word(w, start_sec=start_sec, end_sec=end_sec):
        return
    status = row["audibility_status"]
    dominant = row.get("dominant_track")

    if w.audibility_status != status or w.dominant_track != dominant:
        result.status_updates += 1

    if update_status or apply_suppression:
        tr.words[i] = w.model_copy(
            update={
                "audibility_status": status,
                "dominant_track": dominant,
            }
        )
        w = tr.words[i]

    if _should_suppress(status) and not w.suppressed:
        entry = {
            "track_id": tr.track_id,
            "word_index": i,
            "text": w.text,
            "start": w.start,
            "end": w.end,
            "audibility_status": status,
            "dominant_track": dominant,
            "reason": row.get("reason"),
        }
        result.suppress.append(entry)
        if status == "bleed" and dominant:
            result.reattribute.append(
                {
                    **entry,
                    "attributed_to_track": dominant,
                }
            )
        if apply_suppression:
            tr.words[i] = tr.words[i].model_copy(update={"suppressed": True})

    elif not _should_suppress(status) and w.suppressed:
        result.unsuppress.append(
            {
                "track_id": tr.track_id,
                "word_index": i,
                "text": w.text,
                "start": w.start,
                "end": w.end,
                "audibility_status": status,
            }
        )
        if apply_suppression:
            tr.words[i] = tr.words[i].model_copy(update={"suppressed": False})


WordKey = tuple[str, int]


def word_targets(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy,
    audibility_map: list[dict[str, Any]] | None = None,
    caches: TrackRmsCacheSet | None = None,
) -> dict[WordKey, dict[str, Any]]:
    """One target per word for the whole project.

    The target is the acoustic verdict, overridden by ``bleed`` plus the winner's track
    where the word loses an identical-text overlap. Both verdicts come from the audio
    and the transcript, never from the stored flags, so a repeat run on an unchanged
    project reports zero changes (#782).

    Targets know nothing about a pass's scope. A track- or window-scoped pass writes
    only its scope but judges every text-match pair by the partner's computed target,
    in or out of scope, so it lands where a full pass lands (#805). Pairs are judged
    independently: a loser stays a loser when its winner loses another pair. Words no
    pass writes (``ignored``, ``audibility_locked``, or without a row because they are
    cut out of the timeline) enter the candidates by their stored ``suppressed`` flag.

    Both verdicts need a measured bleed path (``TrackRmsCacheSet.echo_pairs``, found on
    the same decoded stems): the acoustic verdict tags ``bleed`` only along a path, and
    on a path the text-match winner is the source mic by the path's lag, never by
    loudness (#774).

    ``audibility_map`` and ``caches`` are this project's ``compute_word_audibility_map``
    and ``build_track_rms_caches`` when the caller already has them.
    """
    caches = build_track_rms_caches(project) if caches is None else caches
    rows = (
        compute_word_audibility_map(project, policy=policy, progress=None, caches=caches)
        if audibility_map is None
        else audibility_map
    )
    by_key: dict[WordKey, dict[str, Any]] = {
        (row["track_id"], row["word_index"]): row for row in rows
    }
    if not policy.bleed_text_match_enabled:
        return by_key

    words_by_track = {tr.track_id: tr.words for tr in project.transcripts}

    def acoustic_suppressed(tid: str, i: int) -> bool:
        w = words_by_track[tid][i]
        row = by_key.get((tid, i))
        if row is None or w.ignored or w.audibility_locked:
            return w.suppressed
        return _should_suppress(row["audibility_status"])

    for loser in overlap_text_match_losers(
        project,
        policy=policy,
        progress=None,
        audibility=rows,
        is_suppressed=acoustic_suppressed,
        echo_pairs=caches.echo_pairs(),
    ):
        key = (loser["track_id"], loser["word_index"])
        by_key[key] = {
            **by_key.get(key, {}),
            "audibility_status": loser["audibility_status"],
            "dominant_track": loser["dominant_track"],
            "reason": loser["reason"],
        }
    return by_key


def reconcile_transcript(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    dry_run: bool = True,
    track_id: str | None = None,
    update_status: bool = False,
    start_sec: float | None = None,
    end_sec: float | None = None,
    progress: ProgressReporter | None = None,
) -> ReconciliationResult:
    """Converge every word in scope to its ``word_targets`` target and report only what
    changed. ``track_id``, ``start_sec`` and ``end_sec`` bound the write, not the target.

    The target is computed the same way whether or not this call writes it: a
    ``dry_run=True`` preview and a ``flag``/``suggest`` tag-only pass (``update_status``
    without ``apply_suppression``) both fold in the text-match override, so what they
    report is exactly what an apply would do (#791). ``apply_suppression`` also forces
    the status write, so a word is never left suppressed with a stale
    ``audibility_status``/``dominant_track`` behind it.
    """
    pol = policy or AnalysisPolicy.from_defaults()
    if pol.transcript_mode == "off":
        return ReconciliationResult(applied=False)

    with resolve_progress_task(
        "reconcile",
        "Reconciling transcript",
        prefer_parent=False,
        progress=progress,
    ) as task:
        task.set_phase("audibility", "Analyzing word audibility…")
        caches = build_track_rms_caches(project)
        audibility_map = compute_word_audibility_map(
            project, policy=pol, progress=None, caches=caches
        )
        if pol.bleed_text_match_enabled:
            task.set_phase("text_match", "Matching bleed text…")
        targets = word_targets(project, policy=pol, audibility_map=audibility_map, caches=caches)

        result = ReconciliationResult()
        apply_suppression = not dry_run
        for tr in project.transcripts:
            if track_id and tr.track_id != track_id:
                continue
            for i in range(len(tr.words)):
                row = targets.get((tr.track_id, i))
                if not row:
                    continue
                _reconcile_word(
                    tr,
                    i,
                    row,
                    result,
                    update_status=update_status,
                    apply_suppression=apply_suppression,
                    start_sec=start_sec,
                    end_sec=end_sec,
                )

        if update_status or apply_suppression:
            rebuild_combined(project)
            mark_reconciliation_fresh(project)
            result.applied = True

        task.message(f"{result.status_updates} status updates")
    return result
