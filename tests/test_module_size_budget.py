"""Size budgets for packages split by the #1807 refactor (see #1814)."""

from __future__ import annotations

from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"

# package directory -> max lines in any one module
BUDGETS = {
    "edits/tighten": 800,
}

# services/document modules the EditService split (#1814) is accountable for. play.py is
# not one of them (1950 lines); it needs its own split, tracked as a follow-up.
DOCUMENT_SPLIT_MODULES = (
    "edit",
    "timeline",
    "analysis",
    "transcript",
    "service_base",
    "suggested_actions",
)
MAX_PUBLIC_SERVICE_METHODS = 40


# glob under src/podcast_mcp -> max lines in any one matching module
FILE_BUDGETS = {
    "services/document/play*.py": 800,
}


@pytest.mark.parametrize("pattern", sorted(FILE_BUDGETS))
def test_no_module_matching_a_split_family_exceeds_its_line_budget(pattern: str) -> None:
    limit = FILE_BUDGETS[pattern]
    matches = sorted(SRC.glob(pattern))
    assert matches, f"{pattern} matches no module"
    over = {
        path.name: count
        for path in matches
        if (count := len(path.read_text(encoding="utf-8").splitlines())) > limit
    }
    assert not over, f"{pattern} modules over {limit} lines: {over}"


@pytest.mark.parametrize("package", sorted(BUDGETS))
def test_no_module_in_a_split_package_exceeds_its_line_budget(package: str) -> None:
    limit = BUDGETS[package]
    over = {
        path.name: count
        for path in sorted((SRC / package).glob("*.py"))
        if (count := len(path.read_text(encoding="utf-8").splitlines())) > limit
    }
    assert not over, f"{package} modules over {limit} lines: {over}"


@pytest.mark.parametrize("module", DOCUMENT_SPLIT_MODULES)
def test_document_edit_service_modules_stay_under_the_line_budget(module: str) -> None:
    count = len((SRC / "services" / "document" / f"{module}.py").read_text("utf-8").splitlines())
    assert count <= 850, f"services/document/{module}.py is {count} lines"


@pytest.mark.parametrize(
    "name", ["EditService", "TimelineService", "TranscriptService", "AnalysisService"]
)
def test_document_services_stay_under_the_public_method_budget(name: str) -> None:
    import inspect

    from podcast_mcp.services import document

    service = getattr(document, name)
    public = [
        member
        for member, _ in inspect.getmembers(service, predicate=inspect.isfunction)
        if not member.startswith("_")
    ]
    assert len(public) < MAX_PUBLIC_SERVICE_METHODS, f"{name} has {len(public)} public methods"
