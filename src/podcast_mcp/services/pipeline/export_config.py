from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

from podcast_mcp.config.defaults import EffectiveConfig, join_micro_fade_ms, mix_peak_ceiling_db
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.bleed_gate import bleed_fill_enabled
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.mastering import MasterQcLimits, MasterTarget
from podcast_mcp.engines.play_audit import mix_gains
from podcast_mcp.export.audio import AUDIO_EXPORT_MEDIA, ExportFormatSpec
from podcast_mcp.export.episode import resolve_episode_audio_plan
from podcast_mcp.export.transcript import CaptionLimits, resolve_caption_limits
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError

if TYPE_CHECKING:
    from .export_variant import ExportTarget


@dataclass(frozen=True)
class ExportSettingsEvidence:
    basis: str
    target: ExportTarget | None
    master_target: MasterTarget
    qc_limits: MasterQcLimits
    audio_formats: tuple[str, ...]

    def to_record(self) -> dict[str, Any]:
        return {
            "version": 1,
            "basis": self.basis,
            "target": self.target.value if self.target is not None else None,
            "master_target": asdict(self.master_target),
            "qc_limits": asdict(self.qc_limits),
            "audio_formats": list(self.audio_formats),
        }


def _typed_recipe(value: object) -> object:
    if value is None:
        return ["null"]
    if type(value) in (bool, int, str):
        return [type(value).__name__, value]
    if type(value) is float and math.isfinite(value):
        return ["float", value.hex()]
    if isinstance(value, tuple):
        return ["tuple", [_typed_recipe(item) for item in value]]
    raise TypeError("Unsupported export settings evidence")


def export_settings_evidence(
    target: ExportTarget | None,
    master_target: MasterTarget,
    limits: MasterQcLimits,
    formats: tuple[ExportFormatSpec, ...],
) -> ExportSettingsEvidence | None:
    """Project a private producer recipe without making optional evidence a failure."""
    try:
        master_values = tuple(asdict(master_target).values())
        limit_values = tuple(asdict(limits).values())
        if not all(math.isfinite(value) for value in (*master_values, *limit_values)):
            return None
        recipe = (
            target.value if target is not None else None,
            master_values,
            limit_values,
            tuple(tuple(asdict(spec).values()) for spec in formats),
        )
        encoded = json.dumps(_typed_recipe(recipe), ensure_ascii=True, separators=(",", ":"))
        basis = hashlib.sha256(
            b"sharecut.export-settings.v1\0" + encoded.encode("ascii")
        ).hexdigest()
        return ExportSettingsEvidence(
            basis,
            target,
            master_target,
            limits,
            tuple(spec.ext if spec.ext in AUDIO_EXPORT_MEDIA else "other" for spec in formats),
        )
    except Exception:
        return None


def canonical_export_defaults(
    defaults: EffectiveConfig, formats: list[dict[str, Any]] | None
) -> EffectiveConfig:
    if formats is not None:
        return {**defaults, "export": {**defaults.get("export", {}), "formats": deepcopy(formats)}}
    return defaults


def canonical_settings_evidence(
    defaults: EffectiveConfig, formats: tuple[ExportFormatSpec, ...]
) -> ExportSettingsEvidence | None:
    try:
        return export_settings_evidence(
            None,
            MasterTarget.from_defaults(defaults),
            MasterQcLimits.from_defaults(defaults),
            formats,
        )
    except Exception:
        return None


def read_export_settings(
    path: Path, formats: list[dict[str, Any]] | None = None, target: ExportTarget | None = None
) -> dict[str, Any]:
    from .config import run_defaults_for
    from .export_variant import resolve_named_settings

    try:
        defaults = run_defaults_for(path)
        if target is None:
            defaults = canonical_export_defaults(defaults, formats)
            evidence = canonical_settings_evidence(
                defaults, resolve_episode_audio_plan(defaults.get("export", {}))
            )
        else:
            settings = resolve_named_settings(target, defaults, formats)
            evidence = export_settings_evidence(
                target, settings.master_target, settings.limits, settings.formats
            )
        if evidence is not None:
            return {"status": "available", "settings": evidence.to_record()}
    except Exception:
        pass
    return {"status": "unavailable", "code": "export_settings_unavailable"}


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
