from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.edits.transcript_cuts import (
    append_remove_decision,
    coalesce_edits,
    ensure_combined_transcript,
)
from podcast_mcp.models import CombinedUtterance, EditDecision, EpisodeProject
from podcast_mcp.util.text import normalize_text

_HOOK_PATTERNS = [
    re.compile(r"\?", re.I),
    re.compile(r"\b(here's|here is|the thing is|secret|mistake|never)\b", re.I),
    re.compile(r"\b(why|how|what if)\b", re.I),
]


@dataclass(frozen=True)
class FocusSegment:
    track_id: str
    speaker: str
    start: float
    end: float
    text: str

    @property
    def duration_sec(self) -> float:
        return self.end - self.start


def macro_focus_segments(
    utterances: list[CombinedUtterance],
    *,
    merge_gap_sec: float = 2.5,
) -> list[FocusSegment]:
    """Merge word-level combined utterances into same-speaker thought blocks."""
    if not utterances:
        return []
    ordered = sorted(utterances, key=lambda u: u.start)
    blocks: list[FocusSegment] = []
    track_id = ordered[0].track_id
    speaker = ordered[0].speaker
    start = ordered[0].start
    end = ordered[0].end
    parts = [ordered[0].text.strip()]

    def flush() -> None:
        text = " ".join(p for p in parts if p).strip()
        if text:
            blocks.append(
                FocusSegment(
                    track_id=track_id,
                    speaker=speaker,
                    start=start,
                    end=end,
                    text=text,
                )
            )

    for utt in ordered[1:]:
        gap = utt.start - end
        if utt.track_id == track_id and gap <= merge_gap_sec:
            end = utt.end
            parts.append(utt.text.strip())
            continue
        flush()
        track_id = utt.track_id
        speaker = utt.speaker
        start = utt.start
        end = utt.end
        parts = [utt.text.strip()]
    flush()
    return blocks


def build_focus_outline(
    project: EpisodeProject,
    defaults: dict[str, Any],
) -> dict[str, Any]:
    """Whole-episode segment map for narrative editing (agent or pipeline)."""
    cfg = defaults.get("focus", {})
    combined = ensure_combined_transcript(project)
    segments = macro_focus_segments(
        combined.utterances,
        merge_gap_sec=float(cfg.get("segment_merge_gap_sec", 2.5)),
    )
    duration_sec = _episode_duration(project, segments)
    return {
        "episode": project.name,
        "duration_sec": duration_sec,
        "segment_count": len(segments),
        "segments": [
            {
                "index": i,
                "track_id": s.track_id,
                "speaker": s.speaker,
                "start": round(s.start, 2),
                "end": round(s.end, 2),
                "duration_sec": round(s.duration_sec, 2),
                "text": s.text,
            }
            for i, s in enumerate(segments)
        ],
    }


def format_focus_outline_markdown(outline: dict[str, Any]) -> str:
    lines = [
        "# Focus outline",
        f"- Duration: **{outline.get('duration_sec', 0) / 60:.1f} min**",
        f"- Segments: {outline.get('segment_count', 0)} (same-speaker thought blocks)",
        "",
        "Read the **full** outline before proposing cuts. Chunk only for context limits.",
        "",
    ]
    for seg in outline.get("segments", []):
        lines.append(
            f"## [{seg['index']}] {seg['start']:.0f}-{seg['end']:.0f}s "
            f"{seg['speaker']} ({seg['track_id']}) - {seg['duration_sec']:.0f}s"
        )
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def write_focus_outline(project: EpisodeProject, defaults: dict[str, Any]) -> Path:
    outline = build_focus_outline(project, defaults)
    out_dir = project.artifacts_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "focus_outline.json"
    md_path = out_dir / "focus_outline.md"
    json_path.write_text(json.dumps(outline, indent=2), encoding="utf-8")
    md_path.write_text(format_focus_outline_markdown(outline), encoding="utf-8")
    return md_path


def _word_jaccard(a: str, b: str) -> float:
    wa = {normalize_text(w) for w in a.split() if normalize_text(w)}
    wb = {normalize_text(w) for w in b.split() if normalize_text(w)}
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _has_hook(text: str) -> bool:
    return any(pat.search(text) for pat in _HOOK_PATTERNS)


def _episode_duration(
    project: EpisodeProject,
    segments: list[FocusSegment] | None = None,
) -> float:
    best = 0.0
    for track in project.tracks:
        if track.media and track.media.duration_sec:
            best = max(best, track.media.duration_sec)
    if best > 0:
        return best
    if segments:
        return segments[-1].end
    combined = project.combined_transcript
    if combined and combined.utterances:
        return combined.utterances[-1].end
    return 0.0


def propose_focus_cuts(
    project: EpisodeProject,
    defaults: dict[str, Any],
    *,
    replace_existing: bool = True,
) -> list[EditDecision]:
    """Heuristic hints only - narrative focus still requires whole-transcript review."""
    cfg = defaults.get("focus", {})
    if not cfg.get("enabled", False):
        return []

    if replace_existing:
        project.edit_decisions = [
            e for e in project.edit_decisions if not (e.reason or "").startswith("focus:")
        ]

    combined = ensure_combined_transcript(project)
    segments = macro_focus_segments(
        combined.utterances,
        merge_gap_sec=float(cfg.get("segment_merge_gap_sec", 2.5)),
    )
    if not segments:
        return []

    review_required = bool(cfg.get("review_required", True))
    crossfade = int(cfg.get("crossfade_ms", 200))
    max_candidates = int(cfg.get("max_candidates", 20))
    min_segment_sec = float(cfg.get("min_segment_sec", 15))
    repeat_window_sec = float(cfg.get("repeat_window_sec", 300))
    repeat_overlap = float(cfg.get("repeat_word_overlap", 0.5))
    long_segment_sec = float(cfg.get("long_segment_sec", 90))
    max_remove_pct = float(cfg.get("max_remove_pct", 0.15))

    duration_sec = _episode_duration(project, segments)
    max_remove_sec = duration_sec * max_remove_pct if duration_sec > 0 else 0.0
    proposed_sec = 0.0
    decisions: list[EditDecision] = []

    def maybe_add(
        track_id: str,
        start: float,
        end: float,
        reason: str,
    ) -> None:
        nonlocal proposed_sec
        if len(decisions) >= max_candidates:
            return
        dur = end - start
        if dur < min_segment_sec:
            return
        if max_remove_sec > 0 and proposed_sec + dur > max_remove_sec + 1e-9:
            return
        decisions.append(
            append_remove_decision(
                project,
                track_id,
                start,
                end,
                reason=reason,
                review_required=review_required,
                crossfade_ms=crossfade,
            )
        )
        proposed_sec += dur

    for i, later in enumerate(segments):
        for earlier in segments[:i]:
            if later.start - earlier.end > repeat_window_sec:
                continue
            if earlier.track_id != later.track_id:
                continue
            overlap = _word_jaccard(earlier.text, later.text)
            if overlap < repeat_overlap:
                continue
            cut = earlier if len(earlier.text) <= len(later.text) else later
            keep = later if cut is earlier else earlier
            if cut is keep:
                continue
            maybe_add(
                cut.track_id,
                cut.start,
                cut.end,
                f"focus:repeat overlap={overlap:.2f}",
            )
            break

    edge_pad = 60.0
    for seg in segments:
        if seg.duration_sec < long_segment_sec:
            continue
        if seg.start < edge_pad or (duration_sec > 0 and seg.end > duration_sec - edge_pad):
            continue
        if _has_hook(seg.text):
            continue
        maybe_add(
            seg.track_id,
            seg.start,
            seg.end,
            f"focus:long_drift {seg.duration_sec:.0f}s",
        )

    for track_id in {s.track_id for s in segments}:
        coalesce_edits(project, track_id=track_id)

    return decisions


def apply_focus_decisions(project: EpisodeProject) -> int:
    from podcast_mcp.edits.decisions import apply_prefix_edits

    return apply_prefix_edits(project, "focus:", config_key="focus")
