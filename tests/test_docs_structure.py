"""Docs keep one owner per feature section and bounded page sizes (#1821)."""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

ONE_OWNER_HEADINGS = (
    "Exact selected ranges",
    "Move clips without dragging",
    "MCP tools",
    "CLI",
    "Occurrence proxy publication",
    "Guest failure presentation",
)
ARCHITECTURE_HEADINGS = ("Layers", "Service contexts", "Data flow", "Design decisions")
ARCHITECTURE_MAX_LINES = 400
TESTING_MAX_LINES = 1200


def _headings(path: Path) -> list[str]:
    found: list[str] = []
    in_fence = False
    for line in path.read_text().splitlines():
        if line.startswith("```"):
            in_fence = not in_fence
        elif not in_fence and (match := re.match(r"#{2,6} (.+?)\s*$", line)):
            found.append(match.group(1))
    return found


def test_each_listed_heading_has_one_owner_doc() -> None:
    owners: dict[str, list[str]] = defaultdict(list)
    for path in sorted(DOCS.glob("*.md")):
        for heading in set(_headings(path)):
            if heading in ONE_OWNER_HEADINGS:
                owners[heading].append(path.name)
    assert {h: owners[h] for h in ONE_OWNER_HEADINGS if len(owners[h]) > 1} == {}


def test_architecture_keeps_its_four_sections_and_stays_short() -> None:
    path = DOCS / "architecture.md"
    headings = _headings(path)
    assert [h for h in ARCHITECTURE_HEADINGS if h not in headings] == []
    lines = len(path.read_text().splitlines())
    assert lines < ARCHITECTURE_MAX_LINES, f"architecture.md is {lines} lines"


def test_testing_doc_stays_short() -> None:
    lines = len((DOCS / "testing.md").read_text().splitlines())
    assert lines < TESTING_MAX_LINES, f"testing.md is {lines} lines"
