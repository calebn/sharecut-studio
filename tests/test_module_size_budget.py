"""Size budgets for packages split by the #1807 refactor (see #1814)."""

from __future__ import annotations

from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"

# package directory -> max lines in any one module
BUDGETS = {
    "edits/tighten": 800,
}


@pytest.mark.parametrize("package", sorted(BUDGETS))
def test_no_module_in_a_split_package_exceeds_its_line_budget(package: str) -> None:
    limit = BUDGETS[package]
    over = {
        path.name: count
        for path in sorted((SRC / package).glob("*.py"))
        if (count := len(path.read_text(encoding="utf-8").splitlines())) > limit
    }
    assert not over, f"{package} modules over {limit} lines: {over}"
