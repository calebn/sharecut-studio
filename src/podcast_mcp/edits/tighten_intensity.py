"""Tighten intensity presets: named, deterministic overlays on the ``tighten`` config.

``medium`` is the shipped ``tighten`` block unchanged. ``light`` and ``aggressive``
override only the keys they name (nested dicts merge), and only where the config
still holds the shipped value, so a key the user tuned wins. A preset is plain config:
no model calls, same proposals for the same transcript. See
docs/filler-cut-quality.md § Intensity presets.
"""

from __future__ import annotations

from typing import Any, Final

from podcast_mcp.config import load_defaults
from podcast_mcp.util.dicts import deep_merge

TIGHTEN_INTENSITIES: Final[tuple[str, ...]] = ("light", "medium", "aggressive")
DEFAULT_TIGHTEN_INTENSITY: Final[str] = "medium"

TIGHTEN_INTENSITY_PRESETS: Final[dict[str, dict[str, Any]]] = {
    "light": {
        "filler_words": ["um", "uh", "erm"],
        "min_filler_confidence": 0.5,
        "max_cut_risk_score": 0.5,
        "max_pause_sec": 2.0,
        "min_retained_pause_sec": 0.5,
        "min_retained_solo_pause_sec": 0.75,
        "repetition_candidates": False,
        "acoustic_gap_filler": {"enabled": False},
    },
    "medium": {},
    "aggressive": {
        "min_filler_cluster": 1,
        "discourse_pause_sec": 0.2,
        "discourse_confidence_max": 0.85,
        "max_pause_sec": 0.8,
        "min_retained_solo_pause_sec": 0.3,
        "max_cut_risk_score": 0.8,
        "repetition_candidates": True,
        "acoustic_gap_filler": {"enabled": True},
    },
}


def normalize_tighten_intensity(raw: object) -> str:
    """Return a known intensity name; ``None``/blank -> medium; unknown -> ValueError."""
    if raw is None:
        return DEFAULT_TIGHTEN_INTENSITY
    value = str(raw).strip().lower()
    if not value:
        return DEFAULT_TIGHTEN_INTENSITY
    if value not in TIGHTEN_INTENSITY_PRESETS:
        choices = ", ".join(TIGHTEN_INTENSITIES)
        raise ValueError(f"unknown tighten intensity {raw!r}; expected one of: {choices}")
    return value


def _unchanged_preset_keys(
    tighten: dict[str, Any], preset: dict[str, Any], shipped: dict[str, Any]
) -> dict[str, Any]:
    """The part of ``preset`` whose keys still hold the shipped value in ``tighten``.

    A key the user changed from the shipped default (or that the shipped block
    lacks) is theirs, so the preset leaves it alone. Nested dicts are checked per key.
    """
    out: dict[str, Any] = {}
    for key, value in preset.items():
        current = tighten.get(key)
        if isinstance(value, dict):
            shipped_sub = shipped.get(key)
            sub = _unchanged_preset_keys(
                current if isinstance(current, dict) else {},
                value,
                shipped_sub if isinstance(shipped_sub, dict) else {},
            )
            if sub:
                out[key] = sub
        elif key not in tighten or current == shipped.get(key):
            out[key] = value
    return out


def apply_tighten_intensity(
    tighten: dict[str, Any],
    intensity: object = None,
    *,
    shipped: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Copy of ``tighten`` with the preset layered on top.

    ``intensity`` (explicit caller choice) wins over ``tighten["intensity"]``; both
    unset means medium. The preset only sets keys that still hold the shipped
    ``tighten`` value (``shipped``, default ``load_defaults()["tighten"]``), so a key
    the user tuned (or Pipeline Analyze applied) wins over the tier. The result
    records the resolved name under ``intensity``.
    """
    name = normalize_tighten_intensity(
        intensity if intensity is not None else tighten.get("intensity")
    )
    preset = TIGHTEN_INTENSITY_PRESETS[name]
    if preset:
        base = shipped if shipped is not None else (load_defaults().get("tighten") or {})
        preset = _unchanged_preset_keys(tighten, preset, base)
    out = deep_merge(tighten, preset)
    out["intensity"] = name
    return out


def with_tighten_intensity(defaults: dict[str, Any], intensity: object = None) -> dict[str, Any]:
    """Shallow copy of pipeline ``defaults`` whose ``tighten`` block has the preset applied."""
    cfg = dict(defaults)
    cfg["tighten"] = apply_tighten_intensity(dict(defaults.get("tighten") or {}), intensity)
    return cfg
