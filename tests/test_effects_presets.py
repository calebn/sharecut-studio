from __future__ import annotations

from podcast_mcp.effects.presets import apply_preset_to_chain, get_preset, list_presets
from podcast_mcp.models import EpisodeProject


def test_list_and_apply_preset() -> None:
    names = list_presets()
    assert "noise_reduction" in names
    assert "noise_reduction_rnnoise" in names
    effects = get_preset("deess")
    assert effects[0]["effect"] == "deesser"
    legacy = get_preset("deess_legacy_notch")
    assert legacy[0]["effect"] == "bandreject"
    rnnoise = get_preset("noise_reduction_rnnoise")
    assert rnnoise[0]["effect"] == "arnndn"

    p = EpisodeProject.create("fx", "/tmp")
    p.timeline.tracks = []
    chain = apply_preset_to_chain(p, "host", "gate")
    assert any(e.effect == "agate" for e in chain.effects)


def test_set_effect_bypass_and_list() -> None:
    from podcast_mcp.effects.presets import (
        add_effect,
        list_track_effects,
        set_effect_bypass,
    )

    p = EpisodeProject.create("fx_bypass", "/tmp")
    add_effect(p, "host", "highpass", {"frequency": 80})
    add_effect(p, "host", "agate", {"threshold_db": -30})
    listed = list_track_effects(p, "host")
    assert len(listed) == 2
    assert listed[0]["bypass"] is False

    out = set_effect_bypass(p, "host", 1, True)
    assert out["bypass"] is True
    assert out["effect"] == "agate"
    assert len(out["effects"]) == 2
    assert list_track_effects(p, "host")[1]["bypass"] is True
    assert list_track_effects(p, "host")[0]["bypass"] is False

    try:
        set_effect_bypass(p, "host", 9, True)
    except ValueError as exc:
        assert "out of range" in str(exc)
    else:
        raise AssertionError("expected ValueError")

    try:
        set_effect_bypass(p, "missing", 0, True)
    except ValueError as exc:
        assert "no processing chain" in str(exc)
    else:
        raise AssertionError("expected ValueError")
