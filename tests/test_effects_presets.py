from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

from podcast_mcp.config import repo_root
from podcast_mcp.effects.presets import (
    _BUILTIN_PRESETS,
    apply_preset_to_chain,
    get_preset,
    list_presets,
    resolve_presets,
)
from podcast_mcp.models import EpisodeProject


def test_list_and_apply_preset() -> None:
    names = list_presets()
    assert "noise_reduction" in names
    assert "noise_reduction_rnnoise" in names
    effects = get_preset("deess")
    assert effects[0]["effect"] == "deesser"
    rnnoise = get_preset("noise_reduction_rnnoise")
    assert rnnoise[0]["effect"] == "arnndn"
    # Removed preset: gone from builtins, and repo YAMLs cannot redefine it.
    assert "deess_legacy_notch" not in names
    with pytest.raises(ValueError, match="unknown effect preset"):
        get_preset("deess_legacy_notch")

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


_YAML_SCAN_ROOTS = (".agents", "config", "deploy", "tests/fixtures")


def _repo_yaml_paths() -> list[Path]:
    """Every git-tracked YAML under the roots where pipeline defaults can live (recursive).

    Uses ``git ls-files`` so untracked or gitignored local files (for example a
    developer's ``config/relay.yaml``) never change the result. Falls back to
    ``rglob`` on disk only when git is unavailable.
    """
    root = repo_root()
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", *_YAML_SCAN_ROOTS],
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        found: set[Path] = set()
        for rel in _YAML_SCAN_ROOTS:
            base = root / rel
            if base.is_dir():
                for pattern in ("*.yaml", "*.yml"):
                    found.update(base.rglob(pattern))
        return sorted(found)
    paths = (
        root / os.fsdecode(raw) for raw in out.split(b"\0") if raw.endswith((b".yaml", b".yml"))
    )
    return sorted(p for p in paths if p.is_file())


def test_repo_yaml_scan_includes_known_pipeline_defaults() -> None:
    rel = {p.relative_to(repo_root()).as_posix() for p in _repo_yaml_paths()}
    assert {
        ".agents/defaults/pipeline.yaml",
        "tests/fixtures/e2e_pipeline.yaml",
        "tests/fixtures/synthetic_bleed_e2e_pipeline.yaml",
    } <= rel


@pytest.mark.parametrize(
    "path",
    _repo_yaml_paths(),
    ids=lambda p: p.relative_to(repo_root()).as_posix(),
)
def test_repo_pipeline_yamls_do_not_redefine_builtin_presets(path: Path) -> None:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict) or "effects" not in data:
        return  # not a pipeline-defaults YAML (e.g. docker-compose, ground-truth manifest)
    overlay = data.get("effects") or {}
    assert isinstance(overlay, dict), f"{path}: effects: must be a mapping"
    collisions = set(overlay) & set(_BUILTIN_PRESETS)
    assert not collisions, (
        f"{path}: effects: redefines builtin preset name(s) {sorted(collisions)}; "
        "builtins are defined once in effects/presets.py and repo YAMLs may only "
        "add new preset names, not override builtins"
    )


def test_defaults_overlay_overrides_and_extends_by_name(tmp_path, monkeypatch) -> None:
    custom = tmp_path / "custom_pipeline.yaml"
    custom.write_text(
        yaml.safe_dump(
            {
                "effects": {
                    "deess": [{"effect": "bandreject", "params": {"f": 6500, "w": 3000}}],
                    "my_chain": [{"effect": "highpass", "params": {"frequency": 100}}],
                }
            }
        )
    )
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(custom))

    names = list_presets()
    assert "my_chain" in names
    for builtin_name in _BUILTIN_PRESETS:
        assert builtin_name in names

    assert get_preset("deess")[0]["effect"] == "bandreject"
    assert get_preset("my_chain")[0]["params"] == {"frequency": 100}
    assert get_preset("gate") == _BUILTIN_PRESETS["gate"]


def test_get_preset_returns_independent_copy() -> None:
    preset = get_preset("gate")
    preset[0]["params"]["threshold_db"] = 0
    assert _BUILTIN_PRESETS["gate"][0]["params"]["threshold_db"] == -30
    assert get_preset("gate")[0]["params"]["threshold_db"] == -30


def test_resolve_presets_ignores_malformed_overlay() -> None:
    assert resolve_presets({"effects": ["x"]}) == _BUILTIN_PRESETS
    assert resolve_presets({}) == _BUILTIN_PRESETS
