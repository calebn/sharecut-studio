from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, get_args

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.asr_timing import (
    DEFAULT_MAX_SHORT_TOKEN_SEC,
    DEFAULT_MAX_WORD_DURATION_SEC,
    DEFAULT_WORD_SPAN_END_SLACK_SEC,
)
from podcast_mcp.util.coded_error import CodedValueError

BleedReduction = Literal["mute", "attenuate"]
"""What the transcript gate does to another speaker's copy on a lane (#945)."""
BleedHandling = Literal["auto", "mute", "attenuate"]
"""The configured reduction; ``auto`` picks one per lane from the lane's floor."""


def parse_bleed_handling(value: object) -> BleedHandling:
    for handling in get_args(BleedHandling):
        if value == handling:
            return handling
    raise CodedValueError(
        f"analysis.heuristics.bleed_handling must be one of {get_args(BleedHandling)}, not {value!r}",
        code="pipeline_config_value_invalid",
    )


@dataclass(frozen=True)
class AnalysisPolicy:
    bleed_dominance_db: float = 6.0
    # How the transcript gate reduces another speaker's voice on a lane (#945), and
    # how far ``attenuate`` turns it down.
    bleed_handling: BleedHandling = "auto"
    bleed_attenuation_db: float = 20.0
    gate_onset_drop_db: float = 15.0
    boundary_jump_db: float = 12.0
    min_fade_ms: int = 10
    recommended_fade_ms: int = 20
    # Cap for jump-scaled harsh-join recommendations (ms).
    harsh_fade_max_ms: int = 80
    # Words longer than this skip full-span mean RMS (ASR stretch); status deferred.
    max_word_audibility_sec: float = DEFAULT_MAX_WORD_DURATION_SEC
    # Filler, backchannel and discourse tokens longer than this are trimmed (#979).
    max_short_token_sec: float = DEFAULT_MAX_SHORT_TOKEN_SEC
    # The trim looks this far past a word's end for its voice (#979).
    word_span_end_slack_sec: float = DEFAULT_WORD_SPAN_END_SLACK_SEC
    ml_backend: str = "off"
    transcript_mode: str = "reconcile"
    reconcile_on_render: bool = True
    bleed_text_match_enabled: bool = True
    bleed_text_match_min_overlap_sec: float = 0.02
    bleed_text_match_min_dominance_db: float | None = None
    bleed_ratio_warn_threshold: float = 0.2

    @classmethod
    def from_defaults(
        cls, defaults: EffectiveConfig, *, strict_inputs: bool = False
    ) -> AnalysisPolicy:
        cfg = defaults.get("analysis", {})
        if strict_inputs and not isinstance(cfg, Mapping):
            raise CodedValueError(
                "analysis must be a mapping", code="pipeline_config_value_invalid"
            )
        heur = cfg.get("heuristics", {})
        if strict_inputs and not isinstance(heur, Mapping):
            raise CodedValueError(
                "analysis.heuristics must be a mapping", code="pipeline_config_value_invalid"
            )
        ml_backend = cfg.get("ml_backend", "off")
        transcript_mode = cfg.get("transcript_mode", "reconcile")
        reconcile_on_render = cfg.get("reconcile_on_render", True)
        bleed_text_match_enabled = heur.get("bleed_text_match_enabled", True)
        if strict_inputs and any(
            isinstance(value, (Mapping, list, tuple, set, frozenset))
            for value in (
                ml_backend,
                transcript_mode,
                reconcile_on_render,
                bleed_text_match_enabled,
            )
        ):
            raise CodedValueError(
                "analysis string and boolean inputs must be scalars",
                code="pipeline_config_value_invalid",
            )
        min_dom = heur.get("bleed_text_match_min_dominance_db")
        return cls(
            bleed_dominance_db=float(heur.get("bleed_dominance_db", 6.0)),
            bleed_handling=parse_bleed_handling(heur.get("bleed_handling", "auto")),
            bleed_attenuation_db=float(heur.get("bleed_attenuation_db", 20.0)),
            gate_onset_drop_db=float(heur.get("gate_onset_drop_db", 15.0)),
            boundary_jump_db=float(heur.get("boundary_jump_db", 12.0)),
            min_fade_ms=int(heur.get("min_fade_ms", 10)),
            recommended_fade_ms=int(heur.get("recommended_fade_ms", 20)),
            harsh_fade_max_ms=int(heur.get("harsh_fade_max_ms", 80)),
            max_word_audibility_sec=float(
                heur.get("max_word_audibility_sec", DEFAULT_MAX_WORD_DURATION_SEC)
            ),
            max_short_token_sec=float(heur.get("max_short_token_sec", DEFAULT_MAX_SHORT_TOKEN_SEC)),
            word_span_end_slack_sec=float(
                heur.get("word_span_end_slack_sec", DEFAULT_WORD_SPAN_END_SLACK_SEC)
            ),
            ml_backend=str(ml_backend).lower(),
            transcript_mode=str(transcript_mode),
            reconcile_on_render=bool(reconcile_on_render),
            bleed_text_match_enabled=bool(bleed_text_match_enabled),
            bleed_text_match_min_overlap_sec=float(
                heur.get("bleed_text_match_min_overlap_sec", 0.02)
            ),
            bleed_text_match_min_dominance_db=(float(min_dom) if min_dom is not None else None),
            bleed_ratio_warn_threshold=float(heur.get("bleed_ratio_warn_threshold", 0.2)),
        )
