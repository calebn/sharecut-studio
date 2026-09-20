from __future__ import annotations

from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.models import EpisodeProject, ProcessingChain, ProcessingEffect

_BUILTIN_PRESETS: dict[str, list[dict[str, Any]]] = {
    "noise_reduction": [{"effect": "afftdn", "params": {"nr": 12, "nf": -25}}],
    "noise_reduction_heavy": [{"effect": "afftdn", "params": {"nr": 20, "nf": -25}}],
    "noise_reduction_rnnoise": [{"effect": "arnndn", "params": {}}],
    "deess": [{"effect": "deesser", "params": {"intensity": 0.5, "frequency": 0.5}}],
    "deess_legacy_notch": [{"effect": "bandreject", "params": {"f": 6500, "w": 3000}}],
    "gate": [
        {
            "effect": "agate",
            "params": {
                "threshold_db": -30,
                "range_db": -20,
                "attack_ms": 5,
                "release_ms": 50,
            },
        }
    ],
    "eq_presence": [{"effect": "equalizer", "params": {"f": 4000, "t": "q", "w": 1.5, "g": 3}}],
    "eq_clarity": [
        {"effect": "highpass", "params": {"frequency": 80}},
        {"effect": "equalizer", "params": {"f": 250, "t": "q", "w": 1, "g": -2}},
    ],
    "eq_warm": [{"effect": "equalizer", "params": {"f": 200, "t": "q", "w": 1, "g": 2}}],
    "podcast_standard": [
        {"effect": "highpass", "params": {"frequency": 80}},
        {
            "effect": "acompressor",
            "params": {
                "threshold_db": -18,
                "ratio": 3,
                "attack_ms": 15,
                "release_ms": 150,
                "makeup_db": 0,
            },
        },
        {"effect": "loudnorm", "params": {"integrated_lufs": -16, "true_peak_db": -1.5}},
    ],
}


def list_presets() -> list[str]:
    defaults = load_defaults()
    custom = defaults.get("effects", {})
    names = set(_BUILTIN_PRESETS) | set(custom.keys())
    return sorted(names)


def get_preset(name: str) -> list[dict[str, Any]]:
    defaults = load_defaults()
    custom = defaults.get("effects", {})
    if name in custom:
        return list(custom[name])
    if name in _BUILTIN_PRESETS:
        return list(_BUILTIN_PRESETS[name])
    raise ValueError(f"unknown effect preset: {name!r}")


def _chain_for_track(project: EpisodeProject, track_id: str) -> ProcessingChain:
    chain = next(
        (c for c in project.processing_chains if c.track_id == track_id),
        None,
    )
    if chain is None:
        chain = ProcessingChain(track_id=track_id, effects=[])
        project.processing_chains.append(chain)
    return chain


def apply_preset_to_chain(
    project: EpisodeProject,
    track_id: str,
    preset: str,
) -> ProcessingChain:
    specs = get_preset(preset)
    chain = _chain_for_track(project, track_id)
    for spec in specs:
        chain.effects.append(
            ProcessingEffect(effect=spec["effect"], params=dict(spec.get("params", {})))
        )
    return chain


def add_effect(
    project: EpisodeProject,
    track_id: str,
    effect: str,
    params: dict[str, Any] | None = None,
) -> ProcessingChain:
    chain = _chain_for_track(project, track_id)
    chain.effects.append(ProcessingEffect(effect=effect, params=params or {}))
    return chain


def remove_effect(
    project: EpisodeProject,
    track_id: str,
    effect: str | None = None,
) -> int:
    chain = _chain_for_track(project, track_id)
    before = len(chain.effects)
    if effect is None:
        chain.effects.clear()
    else:
        chain.effects = [e for e in chain.effects if e.effect != effect]
    return before - len(chain.effects)


def set_effect_bypass(
    project: EpisodeProject,
    track_id: str,
    effect_index: int,
    bypass: bool,
) -> dict[str, Any]:
    """Toggle bypass on one effect by index without removing it from the chain."""
    chain = next(
        (c for c in project.processing_chains if c.track_id == track_id),
        None,
    )
    if chain is None:
        raise ValueError(f"no processing chain for track_id={track_id!r}")
    if effect_index < 0 or effect_index >= len(chain.effects):
        raise ValueError(
            f"effect_index {effect_index} out of range for track {track_id!r} "
            f"(len={len(chain.effects)})"
        )
    chain.effects[effect_index].bypass = bool(bypass)
    return {
        "track_id": track_id,
        "effect_index": effect_index,
        "bypass": chain.effects[effect_index].bypass,
        "effect": chain.effects[effect_index].effect,
        "effects": list_track_effects(project, track_id),
    }


def list_track_effects(project: EpisodeProject, track_id: str) -> list[dict[str, Any]]:
    chain = next(
        (c for c in project.processing_chains if c.track_id == track_id),
        None,
    )
    if not chain:
        return []
    return [{"effect": e.effect, "params": e.params, "bypass": e.bypass} for e in chain.effects]
