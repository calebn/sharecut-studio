from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from podcast_mcp.edits.transcript_cuts import ensure_combined_transcript
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject, SocialClipCandidate
from podcast_mcp.util.review import approve_by_id, reject_by_id
from podcast_mcp.util.timebase import SourceSec

_HOOK_PATTERNS = [
    re.compile(r"\?", re.I),
    re.compile(r"\b(here's|here is|the thing is|secret|mistake|never)\b", re.I),
    re.compile(r"\b\d+\b"),
    re.compile(r"\b(why|how|what if)\b", re.I),
]


def _truncate_at_word(text: str, max_len: int) -> str:
    """Truncate without splitting a word; append … when shortened."""
    text = text.strip()
    if max_len <= 0 or len(text) <= max_len:
        return text
    if max_len <= 1:
        return "…"
    cut = text[: max_len - 1]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    cut = cut.rstrip(".,;:!?-")
    return (cut or text[: max_len - 1]).rstrip() + "…"


def _looks_like_complete_thought(text: str) -> bool:
    """Heuristic: sentence-like start + terminal punctuation (or long clause)."""
    t = text.strip()
    if not t:
        return False
    # Mid-utterance ASR chunks often start lowercase / conjunction.
    if t[0].islower():
        return False
    if re.match(r"^(and|but|or|so|because|which|that|like)\b", t, re.I):
        return False
    if re.search(r"[.!?][\"')\]]*$", t):
        return True
    # Allow strong openings without terminal punct if long enough.
    return len(t.split()) >= 12 and t[0].isupper()


def _platform_limits(defaults: dict[str, Any], platform: str | None) -> tuple[float, float]:
    cfg = defaults.get("social_clips", {})
    min_sec = float(cfg.get("min_sec", 15))
    max_sec = float(cfg.get("default_max_sec", 60))
    if platform:
        presets = cfg.get("platforms", {})
        preset = presets.get(platform.lower(), {})
        max_sec = float(preset.get("max_sec", max_sec))
        min_sec = float(preset.get("min_sec", min_sec))
    return min_sec, max_sec


def _utterance_energy(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
) -> float:
    peaks_path = project.artifacts_dir() / "peaks" / f"{track_id}.json"
    if not peaks_path.is_file():
        return 0.5
    try:
        data = json.loads(peaks_path.read_text(encoding="utf-8"))
        peaks_raw = data.get("peaks", [])
        if not isinstance(peaks_raw, list) or not peaks_raw:
            return 0.5
        sample_rate = float(data.get("sample_rate") or 0)
        spp = float(data.get("samples_per_pixel") or 0)
        duration = float(data.get("duration_sec") or 0)
        if duration <= 0 and sample_rate > 0 and spp > 0:
            duration = len(peaks_raw) * spp / sample_rate
        if duration <= 0:
            return 0.5
        n = len(peaks_raw)
        i0 = int((start / duration) * n)
        i1 = max(i0 + 1, int((end / duration) * n))
        window = peaks_raw[i0:i1]
        if not window:
            return 0.5
        peak = float(max(window))
        if peak > 1.0:
            peak = peak / 255.0
        return min(1.0, peak * 4.0)
    except (json.JSONDecodeError, OSError, ValueError):
        return 0.5


def _score_utterance(
    project: EpisodeProject,
    *,
    track_id: str,
    start: float,
    end: float,
    text: str,
    duration_sec: float,
    min_sec: float,
    max_sec: float,
) -> tuple[float, list[str]]:
    reasons: list[str] = []
    dur = end - start
    if dur < min_sec or dur > max_sec:
        return 0.0, ["duration_out_of_range"]
    score = 0.25
    if _looks_like_complete_thought(text):
        score += 0.2
        reasons.append("complete_thought")
    else:
        score -= 0.25
        reasons.append("incomplete_thought")
    word_count = len(text.split())
    if 8 <= word_count <= 80:
        score += 0.15
        reasons.append("good_length")
    for pat in _HOOK_PATTERNS:
        if pat.search(text):
            score += 0.12
            reasons.append("hook_pattern")
            break
    energy = _utterance_energy(project, track_id, start, end)
    score += 0.2 * energy
    if energy > 0.6:
        reasons.append("high_energy")
    if start < 60 or (duration_sec > 0 and end > duration_sec - 60):
        score -= 0.1
        reasons.append("edge_penalty")
    filler_hits = sum(
        1
        for e in project.edit_decisions
        if e.track_id == track_id
        and e.start < end
        and e.end > start
        and (e.reason or "").startswith("filler:")
    )
    if filler_hits > 2:
        score -= 0.2
        reasons.append("filler_dense")
    return min(1.0, max(0.0, score)), reasons


def _episode_duration(project: EpisodeProject) -> float:
    best = 0.0
    for t in project.tracks:
        if t.media and t.media.duration_sec:
            best = max(best, t.media.duration_sec)
    if best > 0:
        return best
    combined = project.combined_transcript
    if combined and combined.utterances:
        return combined.utterances[-1].end
    return 0.0


def propose_social_clips(
    project: EpisodeProject,
    defaults: dict[str, Any],
    *,
    platform: str | None = None,
    max_clips: int | None = None,
    replace_existing: bool = True,
) -> list[SocialClipCandidate]:
    cfg = defaults.get("social_clips", {})
    min_sec, max_sec = _platform_limits(defaults, platform)
    limit = max_clips or int(cfg.get("max_candidates", 12))
    combined = ensure_combined_transcript(project)
    duration_sec = _episode_duration(project)
    st = SessionTimeline(project)

    scored: list[SocialClipCandidate] = []
    for utt in combined.utterances:
        score, reasons = _score_utterance(
            project,
            track_id=utt.track_id,
            start=utt.start,
            end=utt.end,
            text=utt.text,
            duration_sec=duration_sec,
            min_sec=min_sec,
            max_sec=max_sec,
        )
        if score < 0.4:
            continue
        # Candidate times are the deliverable (timeline) clock: export cuts
        # premix/mastered, so map the source-clock utterance through the clips.
        tl_spans = st.map_source_span(utt.track_id, SourceSec(utt.start), SourceSec(utt.end))
        if not tl_spans:
            continue
        tl_start = float(tl_spans[0][0])
        tl_end = float(tl_spans[-1][1])
        title = _truncate_at_word(utt.text, 72)
        scored.append(
            SocialClipCandidate(
                id=f"clip_{uuid.uuid4().hex[:8]}",
                track_id=utt.track_id,
                start=tl_start,
                end=tl_end,
                score=round(score, 3),
                reasons=reasons,
                title_suggestion=title,
                caption_suggestion=_truncate_at_word(utt.text, 280),
                transcript_excerpt=utt.text,
                speaker=utt.speaker,
                review_required=True,
                approved=False,
            )
        )

    scored.sort(key=lambda c: c.score, reverse=True)
    top = scored[:limit]
    if replace_existing:
        project.social_clip_candidates = top
    else:
        project.social_clip_candidates.extend(top)
    return top


def list_social_clips(
    project: EpisodeProject,
    *,
    approved: bool | None = None,
    review_required: bool | None = None,
) -> list[SocialClipCandidate]:
    out: list[SocialClipCandidate] = []
    for c in project.social_clip_candidates:
        if approved is not None and c.approved != approved:
            continue
        if review_required is not None and c.review_required != review_required:
            continue
        out.append(c)
    return out


def approve_social_clips(project: EpisodeProject, ids: list[str]) -> int:
    def _on_approve(c: SocialClipCandidate) -> None:
        c.approved = True
        c.review_required = False

    return approve_by_id(
        project.social_clip_candidates,
        ids,
        get_id=lambda c: c.id,
        on_approve=_on_approve,
    )


def reject_social_clips(project: EpisodeProject, ids: list[str]) -> int:
    kept, removed = reject_by_id(
        project.social_clip_candidates,
        ids,
        get_id=lambda c: c.id,
    )
    project.social_clip_candidates = kept
    return removed


def add_manual_social_clip(
    project: EpisodeProject,
    *,
    track_id: str,
    start: float,
    end: float,
    title: str | None = None,
) -> SocialClipCandidate:
    """Append a manually created social-clip candidate (timeline clocks)."""
    if end <= start:
        raise ValueError("end must be greater than start")
    if project.track_by_id(track_id) is None:
        raise ValueError(f"unknown track_id: {track_id!r}")
    clip = SocialClipCandidate(
        id=f"manual_{uuid.uuid4().hex[:10]}",
        track_id=track_id,
        start=float(start),
        end=float(end),
        score=0.0,
        reasons=["manual"],
        title_suggestion=title,
        review_required=True,
        approved=False,
    )
    project.social_clip_candidates.append(clip)
    return clip


def update_social_clip_times(
    project: EpisodeProject,
    clip_id: str,
    *,
    start: float,
    end: float,
) -> SocialClipCandidate:
    """Update start/end on one social clip candidate (timeline clocks)."""
    if end <= start:
        raise ValueError("end must be greater than start")
    for i, clip in enumerate(project.social_clip_candidates):
        if clip.id != clip_id:
            continue
        updated = clip.model_copy(update={"start": float(start), "end": float(end)})
        project.social_clip_candidates[i] = updated
        return updated
    raise ValueError(f"social clip not found: {clip_id!r}")


def _source_audio(project: EpisodeProject) -> Path | None:
    from podcast_mcp.export.names import sanitize_export_stem

    export_wav = project.export_dir() / f"{sanitize_export_stem(project.name)}.wav"
    premix = project.artifacts_dir() / "premix.wav"
    if export_wav.is_file():
        return export_wav
    if premix.is_file():
        return premix
    for track in project.tracks:
        if track.media:
            p = Path(track.media.path)
            if not p.is_absolute():
                p = project.workspace_path() / p
            if p.is_file():
                return p
    return None


def export_social_clips(
    project: EpisodeProject,
    defaults: dict[str, Any],
    *,
    ids: list[str] | None = None,
) -> list[dict[str, str]]:
    cfg = defaults.get("social_clips", {})
    padding = float(cfg.get("padding_ms", 150)) / 1000.0
    src = _source_audio(project)
    if not src:
        raise ValueError("No audio source found; run pipeline mix or export first")
    out_dir = project.export_dir() / "clips"
    out_dir.mkdir(parents=True, exist_ok=True)
    engine = FFmpegEngine()
    exported: list[dict[str, str]] = []
    id_set = set(ids) if ids else None

    for clip in project.social_clip_candidates:
        if id_set and clip.id not in id_set:
            continue
        if not id_set and not clip.approved and clip.review_required:
            continue
        start = max(0.0, clip.start - padding)
        end = clip.end + padding
        slug = re.sub(r"[^a-z0-9]+", "-", (clip.title_suggestion or clip.id).lower())[:40]
        wav_out = out_dir / f"{slug}_{clip.id}.wav"
        json_out = out_dir / f"{slug}_{clip.id}.json"
        engine.extract_segment(src, wav_out, start, end)
        clip.exported_path = str(wav_out.relative_to(project.workspace_path()))
        sidecar = clip.model_dump()
        sidecar["exported_wav"] = str(wav_out)
        json_out.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
        exported.append({"id": clip.id, "wav": str(wav_out), "json": str(json_out)})
    return exported


def format_social_clip_report(project: EpisodeProject) -> str:
    lines = ["# Social clip candidates\n"]
    for c in sorted(project.social_clip_candidates, key=lambda x: -x.score):
        status = "approved" if c.approved else ("pending" if c.review_required else "draft")
        lines.append(
            f"- [{status}] **{c.score:.2f}** {c.start:.1f}-{c.end:.1f}s "
            f"{c.speaker or c.track_id}: {c.title_suggestion or c.transcript_excerpt or ''}"
        )
        if c.reasons:
            lines.append(f"  - reasons: {', '.join(c.reasons)}")
    lines.append(
        "\n> Video export (9:16 crop, captions) is not implemented yet; "
        "timestamps are canonical for a future video pipeline."
    )
    return "\n".join(lines)
