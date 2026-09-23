"""Format-write belongs in lint-staged, not pre-commit (pre-commit fails after rewrite)."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]


def test_precommit_config_has_no_formatter_rewrite_hook() -> None:
    text = (ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    assert "biome-format" not in text
    assert "ruff-format" not in text


def test_ux_pack_sync_hook_covers_every_script_trigger() -> None:
    """The hook's file filter must run for every trigger the script recognizes."""
    config = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8"))
    hooks = config["repos"][0]["hooks"]
    ux_pack_sync = next(hook for hook in hooks if hook["id"] == "ux-pack-sync")

    module = load_script("check_ux_pack_sync")

    files_pattern = re.compile(ux_pack_sync["files"])
    for trigger in module.TRIGGER_PREFIXES:
        assert files_pattern.match(trigger), trigger
