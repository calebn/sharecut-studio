"""Generated TypeScript is formatted in the web project and failures are visible."""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "biome_format.py"


def _load_formatter() -> ModuleType:
    spec = importlib.util.spec_from_file_location("biome_format", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_biome_formatter_uses_web_config_and_cleans_temporary_file(tmp_path: Path) -> None:
    biome_format = _load_formatter()
    web = tmp_path / "web"
    biome = web / "node_modules" / ".bin" / "biome"
    biome.parent.mkdir(parents=True)
    biome.touch()
    config = web / "biome.json"
    config.write_text("{}", encoding="utf-8")

    def format_file(command: list[str], *, cwd: Path, check: bool, capture_output: bool) -> None:
        temp_file = Path(command[-1])
        assert temp_file.parent == web
        assert command[:5] == [str(biome), "check", "--write", "--config-path", str(config)]
        assert cwd == web and check and capture_output
        temp_file.write_text("formatted\n", encoding="utf-8")

    with (
        patch.object(biome_format, "WEB", web),
        patch.object(biome_format.subprocess, "run", side_effect=format_file),
    ):
        assert biome_format.biome_format_ts("raw\n") == "formatted\n"
    assert list(web.glob("*.ts")) == []


def test_biome_formatter_reports_failure_and_cleans_temporary_file(tmp_path: Path) -> None:
    biome_format = _load_formatter()
    web = tmp_path / "web"
    biome = web / "node_modules" / ".bin" / "biome"
    biome.parent.mkdir(parents=True)
    biome.touch()

    with (
        patch.object(biome_format, "WEB", web),
        patch.object(
            biome_format.subprocess,
            "run",
            side_effect=subprocess.CalledProcessError(1, [str(biome)]),
        ),
    ):
        with pytest.raises(subprocess.CalledProcessError):
            biome_format.biome_format_ts("raw\n")
    assert list(web.glob("*.ts")) == []
