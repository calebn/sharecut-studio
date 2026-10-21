"""Transcript refine gate - hard agent gate after precorrect."""

from __future__ import annotations

import json
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.review_gate import ReviewGate, ReviewRequiredError
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.hashing import short_digest

# Open words below this confidence count toward the refine brief's low_confidence_open_words.
REFINE_BRIEF_LOW_CONFIDENCE = 0.5

GATE_HINT = (
    "Transcript refine is required before focus/tighten/NL edits. "
    "Run podcast-transcript-refine (whole-episode pass), then "
    "`podcast transcript refine-done` / `transcript_refine_done_tool`, "
    "or `podcast transcript refine-waive --reason ...` / `transcript_refine_waive_tool`."
)


class TranscriptRefineRequiredError(ReviewRequiredError):
    """Raised when narrative edits run while refine status is pending/stale."""

    code = "transcript_refine_required"


def reviewed_transcript_fingerprint(project: EpisodeProject) -> str:
    """Digest of the transcript text a refine pass reviews.

    Words a cut archived still count, in their original order, and audibility flags do
    not, so the host's own approved cuts and a render's reconcile never stale a refine
    decision. A change to word text (a correction, a re-transcription) does.
    """
    tracks = []
    for tr in sorted(project.transcripts, key=lambda t: (t.track_id, t.source_id or "")):
        words = [
            *tr.active_words_with_ordinals(),
            *((a.ordinal, a.word) for a in tr.archived_words),
        ]
        words.sort(key=lambda item: item[0])
        tracks.append((tr.track_id, tr.source_id, [w.text for _, w in words]))
    raw = json.dumps(tracks, ensure_ascii=False, separators=(",", ":"))
    return short_digest(raw)


def build_refine_brief(project: EpisodeProject, defaults: EffectiveConfig) -> dict[str, Any]:
    from podcast_mcp.project.transcript_context import load_transcript_context

    report_path = project.artifacts_dir() / "transcript_precorrect_report.json"
    deferred: list[Any] = []
    garble: list[Any] = []
    if report_path.is_file():
        try:
            report = load_json_object(report_path) or {}
            deferred = list(report.get("deferred_queue") or [])
            garble = list(report.get("garble_hits") or [])
        except ValueError:
            pass

    from podcast_mcp.edits.transcript_correct import transcript_word_record

    ctx = load_transcript_context(project.workspace_path())
    low_conf = 0
    suspect_count = 0
    suspect_sample: list[dict[str, Any]] = []
    for tr in project.transcripts:
        for index, w in enumerate(tr.words or []):
            if getattr(w, "suppressed", False):
                continue
            if w.suspect_hallucination:
                suspect_count += 1
                if len(suspect_sample) < 10:
                    suspect_sample.append(transcript_word_record(tr, index))
            conf = getattr(w, "confidence", None)
            if conf is not None and float(conf) < REFINE_BRIEF_LOW_CONFIDENCE:
                low_conf += 1

    combined = project.transcripts_dir() / "combined.json"
    return {
        "status": REFINE_GATE.report(project, defaults),
        "show_title": ctx.show_title,
        "guest_names": list(ctx.guest_names),
        "terms": list(ctx.terms)[:50],
        "deferred_queue_count": len(deferred),
        "deferred_queue_sample": deferred[:10],
        "garble_hits_count": len(garble),
        "garble_hits_sample": garble[:10],
        "low_confidence_open_words": low_conf,
        "suspect_hallucination_open_words": suspect_count,
        "suspect_hallucination_sample": suspect_sample,
        "combined_transcript_path": str(combined) if combined.is_file() else None,
        "precorrect_report_path": str(report_path) if report_path.is_file() else None,
        "track_ids": [t.track_id for t in project.transcripts],
        "word_counts": {t.track_id: len(t.words or []) for t in project.transcripts},
    }


REFINE_GATE = ReviewGate(
    name="refine",
    filename="transcript_refine_status.json",
    mode_key="analysis.transcript_refine",
    fingerprint_key="transcript_fingerprint",
    fingerprint=reviewed_transcript_fingerprint,
    hint=GATE_HINT,
    error=TranscriptRefineRequiredError,
    pending_source="precorrect",
    pending_notes="reset after precorrect apply",
    brief=build_refine_brief,
)
