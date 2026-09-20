from __future__ import annotations

from typing import Any

from podcast_mcp.engines.asr_timing import word_duration_is_anomalous
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.progress import ProgressReporter


def _audibility_score(status: str | None) -> int:
    if status == "audible":
        return 3
    if status == "deferred":
        return 2
    if status == "bleed":
        return 1
    if status == "inaudible":
        return 0
    return 1


def _pair_has_anomalous_duration(
    project: EpisodeProject,
    pair: dict[str, Any],
    policy: AnalysisPolicy,
) -> bool:
    for tid_key, idx_key in (("track_a", "word_index_a"), ("track_b", "word_index_b")):
        tr = project.transcript_for_track(pair[tid_key])
        idx = pair[idx_key]
        if not tr or idx >= len(tr.words):
            continue
        w = tr.words[idx]
        if word_duration_is_anomalous(w.end - w.start, policy.max_word_audibility_sec):
            return True
    return False


def _word_confidence(project: EpisodeProject, track_id: str, word_index: int) -> float:
    tr = project.transcript_for_track(track_id)
    if not tr or word_index >= len(tr.words):
        return 1.0
    w = tr.words[word_index]
    return w.confidence if w.confidence is not None else 1.0


def _pick_text_match_winner(
    pair: dict[str, Any],
    *,
    margin: float = 0.15,
) -> str:
    score_a = _audibility_score(pair.get("status_a"))
    score_b = _audibility_score(pair.get("status_b"))
    conf_a = pair.get("confidence_a", 1.0)
    conf_b = pair.get("confidence_b", 1.0)
    total_a = score_a + conf_a
    total_b = score_b + conf_b
    if abs(total_a - total_b) >= margin:
        return pair["track_a"] if total_a > total_b else pair["track_b"]

    rms_a = pair.get("rms_a_db")
    rms_b = pair.get("rms_b_db")
    if rms_a is not None and rms_b is not None and abs(rms_a - rms_b) >= 0.5:
        return pair["track_a"] if rms_a > rms_b else pair["track_b"]

    if conf_a != conf_b:
        return pair["track_a"] if conf_a > conf_b else pair["track_b"]

    return pair["track_a"]


def suppress_overlap_text_matches(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy,
    apply: bool,
    track_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    """Suppress loser words when identical text overlaps across tracks."""
    if not policy.bleed_text_match_enabled:
        return []

    from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report

    report = overlap_duplicate_report(
        project,
        start_sec=start_sec,
        end_sec=end_sec,
        policy=policy,
        progress=progress,
    )
    min_overlap = policy.bleed_text_match_min_overlap_sec
    min_dom = policy.bleed_text_match_min_dominance_db
    suppressed: list[dict[str, Any]] = []

    for pair in report.get("pairs", []):
        if not pair.get("text_match"):
            continue
        if float(pair.get("overlap_sec", 0)) < min_overlap:
            continue
        if _pair_has_anomalous_duration(project, pair, policy):
            continue

        rms_a = pair.get("rms_a_db")
        rms_b = pair.get("rms_b_db")
        if (
            min_dom is not None
            and rms_a is not None
            and rms_b is not None
            and abs(rms_a - rms_b) < min_dom
        ):
            continue

        enriched = {
            **pair,
            "confidence_a": _word_confidence(project, pair["track_a"], pair["word_index_a"]),
            "confidence_b": _word_confidence(project, pair["track_b"], pair["word_index_b"]),
        }
        winner = _pick_text_match_winner(enriched)
        if winner == pair["track_a"]:
            loser_track, loser_idx = pair["track_b"], pair["word_index_b"]
            dominant = pair["track_a"]
        else:
            loser_track, loser_idx = pair["track_a"], pair["word_index_a"]
            dominant = pair["track_b"]

        if track_id and loser_track != track_id:
            continue

        tr = project.transcript_for_track(loser_track)
        if not tr or loser_idx >= len(tr.words):
            continue
        w = tr.words[loser_idx]
        if w.suppressed:
            continue
        if start_sec is not None and w.start < start_sec:
            continue
        if end_sec is not None and w.start >= end_sec:
            continue

        entry = {
            "track_id": loser_track,
            "word_index": loser_idx,
            "text": w.text,
            "start": w.start,
            "end": w.end,
            "audibility_status": "bleed",
            "dominant_track": dominant,
            "reason": "text_match_overlap",
        }
        suppressed.append(entry)
        if apply:
            tr.words[loser_idx] = w.model_copy(
                update={
                    "suppressed": True,
                    "audibility_status": "bleed",
                    "dominant_track": dominant,
                }
            )

    return suppressed
