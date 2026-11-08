from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy

import yaml

from podcast_mcp.config.defaults import EffectiveConfig, join_micro_fade_ms, mix_peak_ceiling_db
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.bleed_gate import bleed_fill_enabled
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.play_audit import mix_gains
from podcast_mcp.export.transcript import CaptionLimits, resolve_caption_limits
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError


def export_config_snapshot(load_config: Callable[[], EffectiveConfig]) -> EffectiveConfig | None:
    try:
        return deepcopy(load_config())
    except (OSError, UnicodeError, yaml.YAMLError):
        return None


def require_source_config(project: EpisodeProject, defaults: EffectiveConfig) -> None:
    try:
        mix = defaults.get("mix")
        if mix is not None and not isinstance(mix, Mapping):
            raise TypeError("mix must be a mapping or null")
        mix_peak_ceiling_db(defaults)
        for track_id in mix_gains(project):
            if any(clip.timing is not None for clip in clips_for_track(project, track_id)):
                cuts = defaults.get("inaudible_cuts")
                if cuts is not None and not isinstance(cuts, Mapping):
                    raise TypeError("inaudible_cuts must be a mapping or null")
                join_micro_fade_ms(defaults)
            track = project.track_by_id(track_id)
            if track is not None and track.transcript_gate:
                AnalysisPolicy.from_defaults(defaults, strict_inputs=True)
                bleed_fill_enabled(defaults, strict_inputs=True)
    except (TypeError, ValueError, OverflowError) as exc:
        raise CodedValueError(
            "The mix settings are invalid. Correct the pipeline settings and retry.",
            code="pipeline_config_value_invalid",
        ) from exc


def transcript_comparison_limits(
    project: EpisodeProject, defaults: EffectiveConfig | None, formats: Sequence[str]
) -> CaptionLimits | None:
    if defaults is None:
        return None
    try:
        export = defaults.get("export", {})
        if not isinstance(export, Mapping):
            return None
        captions = export.get("captions")
        if captions is not None and not isinstance(captions, Mapping):
            return None
        limits = resolve_caption_limits(export)
        if any(fmt in ("txt", "md") for fmt in formats) and (
            project.transcripts or project.combined_transcript is None
        ):
            AsrOptions.from_defaults(defaults, strict_inputs=True)
    except (TypeError, ValueError, OverflowError):
        return None
    return limits
