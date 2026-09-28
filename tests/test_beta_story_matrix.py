"""Regression contract for the checked-in beta user-story coverage matrix."""

import re
from pathlib import Path

DOCS_DIR = Path(__file__).parents[1] / "docs"
REPO_ROOT = Path(__file__).parents[1]

STORY_ISSUES = {
    "US-1": 3,
    "US-2": 9,
    "US-3": 10,
    "US-4": 4,
    "US-5": 5,
    "US-6": 6,
    "US-7": 7,
    "US-8": 11,
    "US-9": 8,
}

STATUSES = {"Automated", "Partial"}

_PATH_RE = re.compile(r"`((?:gui|tests)/[^`\s]+\.(?:py|ts|tsx))`")


def _matrix_rows() -> list[list[str]]:
    document = (DOCS_DIR / "testing.md").read_text()
    lines = document.splitlines()

    start = None
    for i, line in enumerate(lines):
        if line.startswith("### Beta user stories"):
            start = i
            break
    assert start is not None, "docs/testing.md is missing the Beta user stories section"

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("#"):
            end = i
            break

    section = lines[start:end]
    rows = []
    for line in section:
        if not line.startswith("| US-"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        rows.append(cells)
    return rows


def test_every_story_is_listed_exactly_once() -> None:
    rows = _matrix_rows()
    story_ids = [row[0] for row in rows]

    assert set(story_ids) == set(STORY_ISSUES)
    assert len(story_ids) == len(set(story_ids))


def test_every_row_has_five_columns() -> None:
    rows = _matrix_rows()

    for row in rows:
        assert len(row) == 5, f"expected 5 columns, got {len(row)}: {row}"


def test_issue_and_status_cells_are_valid() -> None:
    rows = _matrix_rows()

    for story, issue, status, _coverage, _manual in rows:
        assert re.fullmatch(r"#\d+", issue), f"{story}: bad issue cell {issue!r}"
        assert int(issue[1:]) == STORY_ISSUES[story], f"{story}: issue mismatch {issue!r}"
        assert status in STATUSES, f"{story}: bad status {status!r}"


def test_coverage_cells_cite_at_least_one_existing_path() -> None:
    rows = _matrix_rows()

    for story, _issue, _status, coverage, _manual in rows:
        paths = _PATH_RE.findall(coverage)
        assert paths, f"{story}: no cited paths in coverage cell {coverage!r}"
        for path in paths:
            assert (REPO_ROOT / path).is_file(), f"{story}: missing path {path}"


def test_path_regex_matches_only_repo_relative_paths() -> None:
    assert _PATH_RE.findall("`tests/test_history.py`") == ["tests/test_history.py"]
    assert _PATH_RE.findall("`gui/web/src/record/Room.test.tsx`") == [
        "gui/web/src/record/Room.test.tsx"
    ]
    assert _PATH_RE.findall("`/tmp/tests/test_history.py`") == []
    assert _PATH_RE.findall("`tests/test_history.js`") == []
    assert _PATH_RE.findall("plain text with no backticks tests/test_history.py") == []
