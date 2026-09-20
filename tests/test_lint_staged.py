"""Format-write belongs in lint-staged, not pre-commit (pre-commit fails after rewrite)."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_precommit_config_has_no_formatter_rewrite_hook() -> None:
    text = (ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    assert "biome-format" not in text
    assert "ruff-format" not in text
