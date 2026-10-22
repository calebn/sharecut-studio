"""The shipped default YAMLs resolve from a checkout and are mapped into the wheel (#1879)."""

from __future__ import annotations

import tomllib
from pathlib import Path

from podcast_mcp.config import defaults as config
from podcast_mcp.project.transcript_context import _GLOBAL_DEFAULTS_PATH

ROOT = Path(__file__).resolve().parents[1]


def test_a_checkout_reads_the_repo_defaults() -> None:
    assert config.defaults_dir() == ROOT / ".agents" / "defaults"
    assert (config.defaults_dir() / "pipeline.yaml").is_file()
    assert config.defaults_dir() / "transcript_glossary.yaml" == _GLOBAL_DEFAULTS_PATH
    assert _GLOBAL_DEFAULTS_PATH.is_file()


def test_the_packaged_directory_wins_when_it_exists(monkeypatch) -> None:
    packaged = Path(config.__file__).resolve().parents[1] / "defaults"
    real_is_dir = Path.is_dir
    monkeypatch.setattr(
        Path, "is_dir", lambda self: True if self == packaged else real_is_dir(self)
    )
    assert config.defaults_dir() == packaged


def test_the_wheel_maps_the_defaults_next_to_the_code() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    mapping = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    assert mapping[".agents/defaults"] == "podcast_mcp/defaults"
