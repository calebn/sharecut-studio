from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from podcast_mcp.edits.transcript_correct import apply_transcript_corrections
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.transcribe import collect_anomalous_asr_duration_flags
from podcast_mcp.models import EpisodeProject, TranscriptWord
from podcast_mcp.transcript_context import (
    CrossTrackConfig,
    ReplacementRule,
    TranscriptContext,
    load_transcript_context,
)
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task


@dataclass
class PrecorrectResult:
    applied: bool = False
    glossary_applied: int = 0
    cross_track_applied: int = 0
    speaker_ran: bool = False
    speaker_skipped_reason: str | None = None
    report_path: str | None = None
    report: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "applied": self.applied,
            "glossary_applied": self.glossary_applied,
            "cross_track_applied": self.cross_track_applied,
            "speaker_ran": self.speaker_ran,
            "speaker_skipped_reason": self.speaker_skipped_reason,
            "report_path": self.report_path,
            "report": self.report,
        }


def _normalize_token(text: str) -> str:
    return re.sub(r"[^\w']+", "", text.lower())


def _in_skip_span(start: float, ctx: TranscriptContext) -> bool:
    return any(span.start_sec <= start < span.end_sec for span in ctx.skip_spans)


def _is_filler(text: str, ctx: TranscriptContext) -> bool:
    tok = _normalize_token(text)
    return tok in ctx.filler_tokens


def _text_similarity(
    a: str,
    b: str,
    *,
    min_substring_len_ratio: float = 0.6,
) -> float:
    na, nb = _normalize_token(a), _normalize_token(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if shorter in longer and len(shorter) / len(longer) >= min_substring_len_ratio:
        return max(0.55, ratio)
    return ratio


def _duration_mismatch(
    pair: dict[str, Any],
    cfg: CrossTrackConfig,
) -> bool:
    """True when ASR stretch makes a cross-track rewrite unsafe."""
    dur_a = max(0.0, float(pair.get("end_a", 0)) - float(pair.get("start_a", 0)))
    dur_b = max(0.0, float(pair.get("end_b", 0)) - float(pair.get("start_b", 0)))
    if dur_a <= 0 or dur_b <= 0:
        return True
    overlap = float(pair.get("overlap_sec", 0))
    both_well_covered = (
        overlap / dur_a >= cfg.min_overlap_of_both_frac
        and overlap / dur_b >= cfg.min_overlap_of_both_frac
    )
    return not both_well_covered and (
        max(dur_a, dur_b) / min(dur_a, dur_b) > cfg.max_duration_ratio
        or max(dur_a, dur_b) > cfg.max_word_duration_sec
    )


def _word_confidence(w: TranscriptWord) -> float:
    return w.confidence if w.confidence is not None else 1.0


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


def _find_glossary_phrase_matches(
    words: list[TranscriptWord],
    rule: ReplacementRule,
    preserve: set[str],
) -> list[tuple[int, int, str]]:
    """Return (start_idx, end_idx, replacement_text) for phrase rules."""
    match_tokens = rule.match.split()
    if not match_tokens:
        return []
    n = len(match_tokens)
    hits: list[tuple[int, int, str]] = []
    word_texts = [w.text for w in words]
    for i in range(len(words) - n + 1):
        span = words[i : i + n]
        if any(w.suppressed for w in span):
            continue
        span_tokens = word_texts[i : i + n]
        if any(_normalize_token(t) in preserve for t in span_tokens):
            continue
        joined = " ".join(span_tokens)
        if rule.match_type == "phrase":
            if joined.lower() != rule.match.lower():
                continue
        else:
            if _normalize_token(joined) != _normalize_token(rule.match):
                continue
        hits.append((i, i + n - 1, rule.replace))
    return hits


def _find_glossary_word_matches(
    words: list[TranscriptWord],
    rule: ReplacementRule,
    preserve: set[str],
) -> list[tuple[int, int, str]]:
    if rule.match_type != "word":
        return []
    hits: list[tuple[int, int, str]] = []
    target = _normalize_token(rule.match)
    for i, w in enumerate(words):
        if w.suppressed:
            continue
        if _normalize_token(w.text) in preserve:
            continue
        if _normalize_token(w.text) == target:
            hits.append((i, i, rule.replace))
    return hits


def run_glossary_pass(
    project: EpisodeProject,
    ctx: TranscriptContext,
    *,
    dry_run: bool = True,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    preserve = set(ctx.preserve_tokens)
    applied: list[dict[str, Any]] = []
    total_words = sum(len(tr.words) for tr in project.transcripts)

    with resolve_progress_task(
        "precorrect-glossary",
        "Glossary pass",
        total=max(total_words, 1),
        prefer_parent=False,
        progress=progress,
    ) as task:
        scanned = 0
        for tr in project.transcripts:
            phrases: list[dict[str, Any]] = []
            word_fixes: list[dict[str, Any]] = []
            for rule in ctx.replacements:
                if rule.match_type == "word":
                    finder = _find_glossary_word_matches
                else:
                    finder = _find_glossary_phrase_matches
                for start, end, repl in finder(tr.words, rule, preserve):
                    if _in_skip_span(tr.words[start].start, ctx):
                        continue
                    if rule.match_type == "word":
                        word_fixes.append(
                            {
                                "word_index": start,
                                "text": repl,
                                "match": rule.match,
                            }
                        )
                    else:
                        phrases.append(
                            {
                                "start_word_index": start,
                                "end_word_index": end,
                                "text": repl,
                                "match": rule.match,
                            }
                        )

            if not dry_run and (phrases or word_fixes):
                apply_transcript_corrections(
                    project,
                    tr.track_id,
                    words=word_fixes,
                    phrases=phrases,
                )
                for item in word_fixes:
                    applied.append(
                        {
                            "track_id": tr.track_id,
                            "kind": "word",
                            **item,
                        }
                    )
                for item in phrases:
                    applied.append(
                        {
                            "track_id": tr.track_id,
                            "kind": "phrase",
                            **item,
                        }
                    )
            else:
                for item in word_fixes:
                    applied.append({"track_id": tr.track_id, "kind": "word", **item})
                for item in phrases:
                    applied.append({"track_id": tr.track_id, "kind": "phrase", **item})

            scanned += len(tr.words)
            if scanned % 50 == 0 or scanned == total_words:
                task.advance_to(scanned, total=total_words)

    return {"count": len(applied), "fixes": applied}


def _pick_winner(
    pair: dict[str, Any],
    margin: float,
) -> str | None:
    score_a = _audibility_score(pair.get("status_a"))
    score_b = _audibility_score(pair.get("status_b"))
    conf_a = pair.get("confidence_a", 1.0)
    conf_b = pair.get("confidence_b", 1.0)
    total_a = score_a + conf_a
    total_b = score_b + conf_b
    if abs(total_a - total_b) < margin:
        return None
    return pair["track_a"] if total_a > total_b else pair["track_b"]


def run_cross_track_sync(
    project: EpisodeProject,
    ctx: TranscriptContext,
    *,
    dry_run: bool = True,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    pol = policy or AnalysisPolicy.from_defaults()
    report = overlap_duplicate_report(project, policy=pol, progress=progress)
    pairs = report.get("pairs", [])
    cfg = ctx.cross_track

    candidates = [
        p
        for p in pairs
        if not p.get("text_match") and float(p.get("overlap_sec", 0)) >= cfg.min_overlap_sec
    ]

    applied: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []

    with resolve_progress_task(
        "precorrect-cross-track",
        "Cross-track sync",
        total=max(len(candidates), 1),
        prefer_parent=False,
        progress=progress,
    ) as task:
        for idx, pair in enumerate(candidates):
            tr_a = project.transcript_for_track(pair["track_a"])
            tr_b = project.transcript_for_track(pair["track_b"])
            if tr_a and pair["word_index_a"] < len(tr_a.words):
                wa = tr_a.words[pair["word_index_a"]]
                pair["confidence_a"] = _word_confidence(wa)
                pair.setdefault("end_a", wa.end)
                pair.setdefault("start_a", wa.start)
            if tr_b and pair["word_index_b"] < len(tr_b.words):
                wb = tr_b.words[pair["word_index_b"]]
                pair["confidence_b"] = _word_confidence(wb)
                pair.setdefault("end_b", wb.end)
                pair.setdefault("start_b", wb.start)

            sim = _text_similarity(
                pair["text_a"],
                pair["text_b"],
                min_substring_len_ratio=cfg.min_substring_len_ratio,
            )
            if _duration_mismatch(pair, cfg):
                deferred.append({**pair, "reason": "duration_mismatch", "similarity": sim})
                if (idx + 1) % 50 == 0:
                    task.advance_to(idx + 1)
                continue
            if sim < cfg.min_similarity:
                if pair.get("status_a") == "bleed" or pair.get("status_b") == "bleed":
                    deferred.append({**pair, "reason": "low_similarity", "similarity": sim})
                if (idx + 1) % 50 == 0:
                    task.advance_to(idx + 1)
                continue

            winner = _pick_winner(pair, cfg.confidence_margin)
            if winner is None:
                deferred.append({**pair, "reason": "ambiguous_audibility", "similarity": sim})
                if (idx + 1) % 50 == 0:
                    task.advance_to(idx + 1)
                continue

            if winner == pair["track_a"]:
                loser_track, loser_idx = pair["track_b"], pair["word_index_b"]
                source_text = pair["text_a"]
                loser_start = pair["start_b"]
            else:
                loser_track, loser_idx = pair["track_a"], pair["word_index_a"]
                source_text = pair["text_b"]
                loser_start = pair["start_a"]

            tr = project.transcript_for_track(loser_track)
            if not tr or loser_idx >= len(tr.words):
                continue
            loser_word = tr.words[loser_idx]
            if _in_skip_span(loser_start, ctx) or _is_filler(loser_word.text, ctx):
                continue
            if _normalize_token(loser_word.text) == _normalize_token(source_text):
                continue

            fix = {
                "track_id": loser_track,
                "word_index": loser_idx,
                "old_text": loser_word.text,
                "new_text": source_text,
                "winner_track": winner,
                "similarity": round(sim, 3),
            }
            applied.append(fix)
            if not dry_run:
                apply_transcript_corrections(
                    project,
                    loser_track,
                    words=[{"word_index": loser_idx, "text": source_text}],
                )

            if (idx + 1) % 50 == 0:
                task.advance_to(idx + 1)

        if candidates:
            task.advance_to(len(candidates))
        else:
            task.advance(0)

    return {
        "count": len(applied),
        "fixes": applied,
        "deferred_low_similarity": deferred,
    }


def _bleed_stats(project: EpisodeProject) -> tuple[int, float]:
    bleed = 0
    total = 0
    for tr in project.transcripts:
        for w in tr.words:
            if w.suppressed:
                continue
            total += 1
            if w.audibility_status == "bleed":
                bleed += 1
    ratio = bleed / total if total else 0.0
    return bleed, ratio


def _should_run_speaker(
    project: EpisodeProject,
    ctx: TranscriptContext,
    deferred: list[dict[str, Any]],
) -> tuple[bool, str]:
    cfg = ctx.speaker_id
    if cfg.mode == "never":
        return False, "speaker_id.mode is never"
    if cfg.mode == "always":
        return True, ""
    bleed_count, bleed_ratio = _bleed_stats(project)
    if bleed_count >= cfg.bleed_word_threshold:
        return True, ""
    if bleed_ratio >= cfg.bleed_ratio_threshold:
        return True, ""
    low_sim = [d for d in deferred if d.get("reason") == "low_similarity"]
    if low_sim:
        return True, ""
    return False, (f"bleed below thresholds ({bleed_count} words, {bleed_ratio:.3f} ratio)")


def _scan_garble_hits(project: EpisodeProject, patterns: list[str]) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for pattern in patterns:
        if not pattern:
            continue
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error:
            continue
        for tr in project.transcripts:
            for i, w in enumerate(tr.words):
                if w.suppressed:
                    continue
                if rx.search(w.text):
                    hits.append(
                        {
                            "track_id": tr.track_id,
                            "word_index": i,
                            "text": w.text,
                            "start": w.start,
                            "pattern": pattern,
                        }
                    )
    return hits


def run_precorrect_transcript(
    project: EpisodeProject,
    *,
    dry_run: bool = True,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    context: TranscriptContext | None = None,
) -> PrecorrectResult:
    ctx = context or load_transcript_context(project.workspace_path())
    result = PrecorrectResult()

    with resolve_progress_task(
        "precorrect",
        "Precorrecting transcript",
        total=3,
        prefer_parent=True,
        progress=progress,
    ) as task:
        glossary_report = run_glossary_pass(project, ctx, dry_run=dry_run, progress=None)
        task.advance(1, message="Glossary done")

        speaker_report: dict[str, Any] = {"ran": False, "skipped_reason": None}
        run_speaker, skip_reason = _should_run_speaker(project, ctx, [])
        if run_speaker:
            try:
                from podcast_mcp.engines.speaker_id import run_speaker_attribution

                speaker_report = run_speaker_attribution(
                    project,
                    ctx,
                    dry_run=dry_run,
                    policy=policy,
                    progress=None,
                )
                result.speaker_ran = True
            except ImportError:
                skip_reason = "speaker extra not installed"
                task.message(skip_reason)
                speaker_report = {"ran": False, "skipped_reason": skip_reason}
        else:
            task.message(f"Speaker pass skipped: {skip_reason}")
            speaker_report = {"ran": False, "skipped_reason": skip_reason}
        result.speaker_skipped_reason = speaker_report.get("skipped_reason") or skip_reason
        task.advance(1, message="Speaker pass done")

        cross_report = run_cross_track_sync(
            project,
            ctx,
            dry_run=dry_run,
            policy=policy,
            progress=None,
        )
        task.advance(1, message="Cross-track done")

        deferred: list[dict[str, Any]] = []
        for item in cross_report.get("deferred_low_similarity", []):
            deferred.append(
                {
                    "kind": item.get("reason") or "low_similarity",
                    "track_a": item.get("track_a"),
                    "track_b": item.get("track_b"),
                    "text_a": item.get("text_a"),
                    "text_b": item.get("text_b"),
                    "start_a": item.get("start_a"),
                    "similarity": item.get("similarity"),
                }
            )
        pol = policy or AnalysisPolicy.from_defaults()
        for flag in collect_anomalous_asr_duration_flags(
            project,
            max_word_sec=pol.max_word_audibility_sec,
            mutate=not dry_run,
        ):
            deferred.append(
                {
                    "kind": "anomalous_word_duration",
                    "track_id": flag.get("track_id"),
                    "word_index": flag.get("word_index"),
                    "text": flag.get("text"),
                    "start": flag.get("start"),
                    "end": flag.get("end"),
                    "duration_sec": flag.get("duration_sec"),
                }
            )
        garble_hits = _scan_garble_hits(project, ctx.garble_patterns)

        report = {
            "glossary": glossary_report,
            "speaker_attribution": speaker_report,
            "cross_track": cross_report,
            "deferred_queue": deferred,
            "garble_hits": garble_hits,
            "dry_run": dry_run,
        }
        result.report = report
        result.glossary_applied = glossary_report.get("count", 0)
        result.cross_track_applied = cross_report.get("count", 0)
        result.applied = not dry_run and (
            result.glossary_applied > 0
            or result.cross_track_applied > 0
            or speaker_report.get("attributions_changed", 0) > 0
            or speaker_report.get("attributions_would_change", 0) > 0
        )

        out = project.artifacts_dir() / "transcript_precorrect_report.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        result.report_path = str(out)

        if not dry_run:
            from podcast_mcp.edits.transcript_refine_status import mark_refine_pending

            mark_refine_pending(
                project,
                source="precorrect",
                notes="reset after precorrect apply",
            )

        task.message("Report written")

    return result
