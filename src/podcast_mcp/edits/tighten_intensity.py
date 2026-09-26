"""Tighten intensity presets: named, deterministic overlays on the ``tighten`` config.

``medium`` is the shipped ``tighten`` block unchanged. ``light`` and ``aggressive``
override only the keys they name (nested dicts merge), so a preset is plain config:
no model calls, same proposals for the same transcript. See
docs/filler-cut-quality.md § Intensity presets.
"""

from __future__ import annotations

from typing import Any, Final

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


def apply_tighten_intensity(tighten: dict[str, Any], intensity: object = None) -> dict[str, Any]:
    """Copy of ``tighten`` with the preset layered on top.

    ``intensity`` (explicit caller choice) wins over ``tighten["intensity"]``; both
    unset means medium. The result records the resolved name under ``intensity``.
    """
    name = normalize_tighten_intensity(
        intensity if intensity is not None else tighten.get("intensity")
    )
    out = deep_merge(tighten, TIGHTEN_INTENSITY_PRESETS[name])
    out["intensity"] = name
    return out
