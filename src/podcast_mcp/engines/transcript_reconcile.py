from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.edits.bleed_text_match import suppress_overlap_text_matches
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.audio_audit import AnalysisPolicy, compute_word_audibility_map
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_fresh
from podcast_mcp.models import EpisodeProject
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
        audibility_map = compute_word_audibility_map(
            project, track_id=track_id, policy=pol, progress=None
        )
        result = ReconciliationResult()
        apply_suppression = not dry_run

        by_key = {(row["track_id"], row["word_index"]): row for row in audibility_map}

        for tr in project.transcripts:
            if track_id and tr.track_id != track_id:
                continue
            for i, w in enumerate(tr.words):
                row = by_key.get((tr.track_id, i))
                if not row:
                    continue

                status = row["audibility_status"]
                dominant = row.get("dominant_track")
                in_window = _in_time_window(w.start, start_sec=start_sec, end_sec=end_sec)

                if in_window and (w.audibility_status != status or w.dominant_track != dominant):
                    result.status_updates += 1

                if update_status and in_window:
                    tr.words[i] = w.model_copy(
                        update={
                            "audibility_status": status,
                            "dominant_track": dominant,
                        }
                    )
                    w = tr.words[i]

                if _should_suppress(status) and not w.suppressed and in_window:
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

                elif not _should_suppress(status) and w.suppressed and in_window:
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

        if pol.bleed_text_match_enabled and apply_suppression:
            task.set_phase("text_match", "Matching bleed text…")
            text_suppressions = suppress_overlap_text_matches(
                project,
                policy=pol,
                apply=True,
                track_id=track_id,
                start_sec=start_sec,
                end_sec=end_sec,
                progress=None,
            )
            for entry in text_suppressions:
                result.suppress.append(entry)
                result.reattribute.append(
                    {
                        **entry,
                        "attributed_to_track": entry.get("dominant_track"),
                    }
                )

        if update_status or apply_suppression:
            rebuild_combined(project)
            mark_reconciliation_fresh(project)
            result.applied = True

        task.message(f"{result.status_updates} status updates")
    return result
