"""Regression contract for the checked-in beta user-story coverage matrix."""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parents[1]
DOCS_DIR = REPO_ROOT / "docs"

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

# Steps an "Automated" row may still list under "Still manual": they need
# hardware (Tauri desktop recording) or a human ear, so no check can replace them.
HARDWARE_OR_BY_EAR_STEPS = {"tauri recording", "listening by ear"}

_CODE_SPAN_RE = re.compile(r"`([^`]+)`")
_PATH_RE = re.compile(r"(?:gui|tests|src|scripts)/[^`\s]+\.(?:py|ts|tsx|js|mjs)")
_ISSUE_REF_RE = re.compile(r"\s*\(#\d+\)")


def _matrix_rows() -> list[list[str]]:
    document = (DOCS_DIR / "testing.md").read_text(encoding="utf-8")
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


def _manual_steps(cell: str) -> list[str]:
    """Normalize a Still manual cell: split on commas, drop `(#N)` refs, lowercase."""
    return [_ISSUE_REF_RE.sub("", step).strip().lower() for step in cell.split(",") if step.strip()]


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


def test_automated_rows_list_only_hardware_or_by_ear_steps() -> None:
    for story, _issue, status, _coverage, manual in _matrix_rows():
        if status != "Automated":
            continue
        extra = [step for step in _manual_steps(manual) if step not in HARDWARE_OR_BY_EAR_STEPS]
        assert not extra, (
            f"{story}: marked Automated but Still manual lists non-hardware steps {extra}; "
            "automate them or mark the row Partial"
        )


def test_coverage_cells_cite_only_existing_repo_paths() -> None:
    for story, _issue, _status, coverage, _manual in _matrix_rows():
        citations = _CODE_SPAN_RE.findall(coverage)
        assert citations, f"{story}: coverage cell cites no backticked paths: {coverage!r}"
        for citation in citations:
            assert _PATH_RE.fullmatch(citation), (
                f"{story}: {citation!r} is not a full repo-relative path; cite it from a "
                "gui/, tests/, src/ or scripts/ root with a .py, .ts, .tsx, .js or .mjs "
                "extension (widen _PATH_RE if a new root or extension is legitimate)"
            )
            assert (REPO_ROOT / citation).is_file(), f"{story}: missing path {citation}"


def test_path_regex_accepts_only_full_repo_relative_paths() -> None:
    for path in (
        "tests/test_history.py",
        "gui/web/src/record/Room.test.tsx",
        "gui/web/e2e/record-lobby.spec.ts",
        "src/podcast_mcp/services/share.py",
        "scripts/check_ux_pack_sync.py",
        "gui/web/e2e-compat/viewer.spec.mjs",
        "gui/web/src/legacy.test.js",
    ):
        assert _PATH_RE.fullmatch(path), path
    for path in (
        "/tmp/tests/test_history.py",
        "transcript-ignore.spec.ts",
        "ImpactPanel.test.tsx",
        "docs/testing.md",
        "tests/test_history.txt",
        "tests/has space.py",
    ):
        assert _PATH_RE.fullmatch(path) is None, path
    assert _CODE_SPAN_RE.findall("plain text with no backticks tests/test_history.py") == []


def test_manual_steps_normalizes_issue_refs_and_case() -> None:
    assert _manual_steps("Tauri recording (#193), host-drop in the browser, listening by ear") == [
        "tauri recording",
        "host-drop in the browser",
        "listening by ear",
    ]
    assert _manual_steps("Listening by ear") == ["listening by ear"]
