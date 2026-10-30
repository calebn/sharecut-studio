from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from podcast_mcp.config.defaults import load_defaults, repo_root
from podcast_mcp.effects.presets import _BUILTIN_PRESETS
from podcast_mcp.engines.effect_filters import validate_effect_params
from podcast_mcp.pipeline import steps
from podcast_mcp.pipeline.meta import PARAM_FIELDS
from test_pipeline_steps import _project_with_host


@pytest.mark.parametrize("name", sorted(_BUILTIN_PRESETS))
def test_every_builtin_preset_validates(name):
    for spec in _BUILTIN_PRESETS[name]:
        validate_effect_params(spec["effect"], spec["params"])


def test_every_shipped_defaults_overlay_preset_validates():
    for spec in load_defaults().get("effects", {}).values():
        for node in spec:
            validate_effect_params(node["effect"], node.get("params") or {})


def test_the_chains_the_pipeline_writes_from_shipped_defaults_validate(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.clean_audio(proj, defaults)
    steps.compress_tracks(proj, defaults)
    written = [fx for chain in proj.processing_chains for fx in chain.effects]
    assert {fx.effect for fx in written} >= {"highpass", "acompressor"}
    for fx in written:
        validate_effect_params(fx.effect, fx.params)


@pytest.mark.parametrize("fixture", ["e2e_pipeline.yaml", "synthetic_bleed_e2e_pipeline.yaml"])
def test_fixture_compression_validates(fixture):
    path = Path(repo_root()) / "tests" / "fixtures" / fixture
    compression = yaml.safe_load(path.read_text(encoding="utf-8")).get("compression", {})
    validate_effect_params("acompressor", compression)


@pytest.mark.parametrize(
    "field", [f for f in PARAM_FIELDS if f.path.startswith("compression.")], ids=lambda f: f.path
)
def test_compression_bounds_in_the_ui_fit_the_effect_schema(field):
    for bound in (field.minimum, field.maximum, field.default):
        validate_effect_params("acompressor", {field.path.split(".", 1)[1]: bound})


@pytest.mark.parametrize("path", ["master.integrated_lufs", "master.true_peak_db"])
def test_master_bounds_in_the_ui_fit_the_loudnorm_schema(path):
    field = next(f for f in PARAM_FIELDS if f.path == path)
    for bound in (field.minimum, field.maximum, field.default):
        validate_effect_params("loudnorm", {path.split(".", 1)[1]: bound})
