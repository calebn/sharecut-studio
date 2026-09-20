from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from podcast_mcp.config import repo_root
from podcast_mcp.engines.asr_timing import DEFAULT_MAX_WORD_DURATION_SEC

_GLOBAL_DEFAULTS_PATH = repo_root() / ".agents" / "defaults" / "transcript_glossary.yaml"


@dataclass(frozen=True)
class ReplacementRule:
    match: str
    replace: str
    match_type: str = "phrase"


@dataclass(frozen=True)
class SkipSpan:
    start_sec: float
    end_sec: float
    reason: str | None = None


@dataclass(frozen=True)
class CrossTrackConfig:
    min_overlap_sec: float = 0.2
    min_similarity: float = 0.55
    confidence_margin: float = 0.15
    # Substring floor only when both tokens are similar in length (avoids "i" in "talking").
    min_substring_len_ratio: float = 0.6
    # Skip rewrite when one word is far longer than the other (ASR stretch junk).
    max_duration_ratio: float = 4.0
    max_word_duration_sec: float = DEFAULT_MAX_WORD_DURATION_SEC
    min_overlap_of_both_frac: float = 0.5


@dataclass(frozen=True)
class SpeakerIdConfig:
    mode: str = "never"
    bleed_word_threshold: int = 50
    bleed_ratio_threshold: float = 0.02
    min_enrollment_sec: float = 30.0
    min_window_sec: float = 0.3
    min_margin: float = 0.15
    min_enrollment_confidence: float = 0.6
    auto_suppress: bool = False
    sample_rate: int = 16000
    expected_speaker_count: int | None = None
    speaker_count_source: str | None = None
    max_speaker_gap_sec: float = 0.55
    gate_window_sec: float = 0.75
    gate_hop_sec: float = 0.25


@dataclass
class TranscriptContext:
    show_title: str | None = None
    languages: list[str] = field(default_factory=lambda: ["en"])
    terms: list[str] = field(default_factory=list)
    guest_names: list[str] = field(default_factory=list)
    replacements: list[ReplacementRule] = field(default_factory=list)
    preserve_tokens: list[str] = field(default_factory=list)
    skip_spans: list[SkipSpan] = field(default_factory=list)
    filler_tokens: list[str] = field(default_factory=list)
    cross_track: CrossTrackConfig = field(default_factory=CrossTrackConfig)
    transcribe: dict[str, Any] = field(default_factory=dict)
    speaker_id: SpeakerIdConfig = field(default_factory=SpeakerIdConfig)
    garble_patterns: list[str] = field(default_factory=list)

    def initial_prompt_text(self, *, max_chars: int = 400) -> str | None:
        cfg = self.transcribe or {}
        if not cfg.get("initial_prompt", True):
            return None
        limit = int(cfg.get("initial_prompt_max_chars", max_chars))
        parts: list[str] = []
        if self.show_title:
            parts.append(self.show_title)
        parts.extend(self.terms)
        parts.extend(self.guest_names)
        if not parts:
            return None
        text = ", ".join(dict.fromkeys(p.strip() for p in parts if p.strip()))
        if len(text) > limit:
            text = text[: limit - 3].rsplit(",", 1)[0]
        return text or None

    def context_path(self, workspace: Path) -> Path:
        return workspace / "transcript_context.yaml"

    def save(self, workspace: Path) -> Path:
        path = self.context_path(workspace)
        data = context_to_dict(self)
        path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        return path


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _parse_replacements(raw: list[Any] | None) -> list[ReplacementRule]:
    rules: list[ReplacementRule] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        match = str(item.get("match", "")).strip()
        replace = str(item.get("replace", "")).strip()
        if not match:
            continue
        rules.append(
            ReplacementRule(
                match=match,
                replace=replace,
                match_type=str(item.get("match_type", "phrase")),
            )
        )
    rules.sort(key=lambda r: len(r.match.split()), reverse=True)
    return rules


def _parse_skip_spans(raw: list[Any] | None) -> list[SkipSpan]:
    spans: list[SkipSpan] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        spans.append(
            SkipSpan(
                start_sec=float(item.get("start_sec", 0)),
                end_sec=float(item.get("end_sec", 0)),
                reason=item.get("reason"),
            )
        )
    return spans


def _parse_cross_track(raw: dict[str, Any] | None) -> CrossTrackConfig:
    raw = raw or {}
    return CrossTrackConfig(
        min_overlap_sec=float(raw.get("min_overlap_sec", 0.2)),
        min_similarity=float(raw.get("min_similarity", 0.55)),
        confidence_margin=float(raw.get("confidence_margin", 0.15)),
        min_substring_len_ratio=float(raw.get("min_substring_len_ratio", 0.6)),
        max_duration_ratio=float(raw.get("max_duration_ratio", 4.0)),
        max_word_duration_sec=float(
            raw.get("max_word_duration_sec", DEFAULT_MAX_WORD_DURATION_SEC)
        ),
        min_overlap_of_both_frac=float(raw.get("min_overlap_of_both_frac", 0.5)),
    )


def _parse_speaker_id(raw: dict[str, Any] | None) -> SpeakerIdConfig:
    raw = raw or {}
    return SpeakerIdConfig(
        mode=str(raw.get("mode", "never")).lower(),
        bleed_word_threshold=int(raw.get("bleed_word_threshold", 50)),
        bleed_ratio_threshold=float(raw.get("bleed_ratio_threshold", 0.02)),
        min_enrollment_sec=float(raw.get("min_enrollment_sec", 30.0)),
        min_window_sec=float(raw.get("min_window_sec", 0.3)),
        min_margin=float(raw.get("min_margin", 0.15)),
        min_enrollment_confidence=float(raw.get("min_enrollment_confidence", 0.6)),
        auto_suppress=bool(raw.get("auto_suppress", False)),
        sample_rate=int(raw.get("sample_rate", 16000)),
        expected_speaker_count=(
            int(raw["expected_speaker_count"])
            if raw.get("expected_speaker_count") is not None
            else None
        ),
        speaker_count_source=(
            str(raw["speaker_count_source"])
            if raw.get("speaker_count_source") is not None
            else None
        ),
        max_speaker_gap_sec=float(raw.get("max_speaker_gap_sec", 0.55)),
        gate_window_sec=float(raw.get("gate_window_sec", 0.75)),
        gate_hop_sec=float(raw.get("gate_hop_sec", 0.25)),
    )


def context_from_dict(data: dict[str, Any]) -> TranscriptContext:
    analysis = data.get("analysis") or {}
    speaker_raw = analysis.get("speaker_id") or data.get("speaker_id") or {}
    return TranscriptContext(
        show_title=data.get("show_title"),
        languages=list(data.get("languages") or ["en"]),
        terms=list(data.get("terms") or []),
        guest_names=list(data.get("guest_names") or []),
        replacements=_parse_replacements(data.get("replacements")),
        preserve_tokens=[str(t).lower() for t in (data.get("preserve_tokens") or [])],
        skip_spans=_parse_skip_spans(data.get("skip_spans")),
        filler_tokens=[str(t).lower() for t in (data.get("filler_tokens") or [])],
        cross_track=_parse_cross_track(data.get("cross_track")),
        transcribe=dict(data.get("transcribe") or {}),
        speaker_id=_parse_speaker_id(speaker_raw),
        garble_patterns=list(data.get("garble_patterns") or []),
    )


def context_to_dict(ctx: TranscriptContext) -> dict[str, Any]:
    return {
        "show_title": ctx.show_title,
        "languages": ctx.languages,
        "terms": ctx.terms,
        "guest_names": ctx.guest_names,
        "replacements": [
            {
                "match": r.match,
                "replace": r.replace,
                "match_type": r.match_type,
            }
            for r in ctx.replacements
        ],
        "preserve_tokens": ctx.preserve_tokens,
        "skip_spans": [
            {
                "start_sec": s.start_sec,
                "end_sec": s.end_sec,
                "reason": s.reason,
            }
            for s in ctx.skip_spans
        ],
        "filler_tokens": ctx.filler_tokens,
        "cross_track": {
            "min_overlap_sec": ctx.cross_track.min_overlap_sec,
            "min_similarity": ctx.cross_track.min_similarity,
            "confidence_margin": ctx.cross_track.confidence_margin,
            "min_substring_len_ratio": ctx.cross_track.min_substring_len_ratio,
            "max_duration_ratio": ctx.cross_track.max_duration_ratio,
            "max_word_duration_sec": ctx.cross_track.max_word_duration_sec,
            "min_overlap_of_both_frac": ctx.cross_track.min_overlap_of_both_frac,
        },
        "transcribe": ctx.transcribe,
        "analysis": {
            "speaker_id": {
                "mode": ctx.speaker_id.mode,
                "bleed_word_threshold": ctx.speaker_id.bleed_word_threshold,
                "bleed_ratio_threshold": ctx.speaker_id.bleed_ratio_threshold,
                "min_enrollment_sec": ctx.speaker_id.min_enrollment_sec,
                "min_window_sec": ctx.speaker_id.min_window_sec,
                "min_margin": ctx.speaker_id.min_margin,
                "min_enrollment_confidence": ctx.speaker_id.min_enrollment_confidence,
                "auto_suppress": ctx.speaker_id.auto_suppress,
                "sample_rate": ctx.speaker_id.sample_rate,
                "expected_speaker_count": ctx.speaker_id.expected_speaker_count,
                "speaker_count_source": ctx.speaker_id.speaker_count_source,
                "max_speaker_gap_sec": ctx.speaker_id.max_speaker_gap_sec,
                "gate_window_sec": ctx.speaker_id.gate_window_sec,
                "gate_hop_sec": ctx.speaker_id.gate_hop_sec,
            }
        },
        "garble_patterns": ctx.garble_patterns,
    }


def load_transcript_context(workspace: Path) -> TranscriptContext:
    merged: dict[str, Any] = _load_yaml(_GLOBAL_DEFAULTS_PATH)
    show_path = workspace / "show_glossary.yaml"
    merged = _deep_merge(merged, _load_yaml(show_path))
    episode_path = workspace / "transcript_context.yaml"
    merged = _deep_merge(merged, _load_yaml(episode_path))
    return context_from_dict(merged)
