"""Load GitHub YAML (workflows, dependabot.yml) with string `on` keys."""

from __future__ import annotations

from pathlib import Path

import yaml


def load_github_yaml(path: Path) -> dict:
    """Parse *path* with SafeLoader and restore the `on` key.

    PyYAML 1.1 treats `on` as boolean True; GitHub Actions keys are strings.
    """
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data
