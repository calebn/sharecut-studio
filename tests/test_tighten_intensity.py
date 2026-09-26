from __future__ import annotations

import copy

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.tighten_intensity import (
    TIGHTEN_INTENSITY_PRESETS,
    apply_tighten_intensity,
    normalize_tighten_intensity,
)


def test_medium_is_identity_over_shipped_defaults() -> None:
    base = load_defaults()["tighten"]
    before = copy.deepcopy(base)
    assert apply_tighten_intensity(base, "medium") == {**base, "intensity": "medium"}
    assert base == before


def test_config_key_used_when_no_explicit_intensity() -> None:
    out = apply_tighten_intensity({"intensity": "light", "max_pause_sec": 1.2})
    assert out["max_pause_sec"] == 2.0


def test_explicit_intensity_beats_config_key() -> None:
    out = apply_tighten_intensity({"intensity": "light"}, "aggressive")
    assert out["max_pause_sec"] == 0.8
    assert out["intensity"] == "aggressive"


def test_normalize_blank_case_and_unknown() -> None:
    assert normalize_tighten_intensity(None) == "medium"
    assert normalize_tighten_intensity("") == "medium"
    assert normalize_tighten_intensity("  ") == "medium"
    assert normalize_tighten_intensity(" Aggressive ") == "aggressive"
    with pytest.raises(ValueError, match="light, medium, aggressive"):
        normalize_tighten_intensity("extreme")


def test_nested_overlay_keeps_sibling_keys() -> None:
    out = apply_tighten_intensity(
        {"acoustic_gap_filler": {"enabled": True, "min_gap_sec": 0.5}}, "light"
    )
    assert out["acoustic_gap_filler"] == {"enabled": False, "min_gap_sec": 0.5}


def test_result_does_not_alias_preset() -> None:
    out = apply_tighten_intensity({}, "light")
    out["filler_words"].append("x")
    assert TIGHTEN_INTENSITY_PRESETS["light"]["filler_words"] == ["um", "uh", "erm"]


def test_every_preset_key_exists_in_shipped_defaults() -> None:
    base = load_defaults()["tighten"]
    for name, overlay in TIGHTEN_INTENSITY_PRESETS.items():
        for key, value in overlay.items():
            assert key in base, f"{name}: {key}"
            if isinstance(value, dict):
                for sub in value:
                    assert sub in base[key], f"{name}: {key}.{sub}"
