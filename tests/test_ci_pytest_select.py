from __future__ import annotations

from pathlib import Path

import pytest

from script_loader import load_script

sel = load_script("ci_pytest_select", register=True)


def _tree(root: Path, files: dict[str, str]) -> None:
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


BASE = {
    "src/podcast_mcp/__init__.py": "",
    "src/podcast_mcp/util/__init__.py": "",
    "src/podcast_mcp/util/clock.py": "def now(): ...\n",
    "src/podcast_mcp/edits/__init__.py": "",
    "src/podcast_mcp/edits/cuts.py": "from podcast_mcp.util.clock import now\n",
    "src/podcast_mcp/edits/other.py": "VALUE = 1\n",
    "src/podcast_mcp/lazy/__init__.py": "",
    "scripts/tool.py": "from podcast_mcp.edits import cuts\n",
    "tests/conftest.py": "",
    "tests/test_cuts.py": "from podcast_mcp.edits import cuts\n",
    "tests/test_clock.py": "import podcast_mcp.util.clock\n",
    "tests/test_other.py": "from podcast_mcp.edits.other import VALUE\n",
    "tests/test_script.py": "def test_x():\n    run('scripts/tool.py')\n",
    "tests/test_string.py": "T = 'podcast_mcp.edits.other.VALUE'\n",
    "tests/test_unrelated.py": "def test_x(): ...\n",
    "tests/test_tree.py": "def test_x():\n    list(Path('src').rglob('*.py'))\n",
}


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    _tree(tmp_path, BASE)
    return tmp_path


def test_a_changed_module_selects_its_direct_and_transitive_importers(tree: Path) -> None:
    selected = sel.select_tests(["src/podcast_mcp/util/clock.py"], tree)
    assert "tests/test_clock.py" in selected
    assert "tests/test_cuts.py" in selected
    assert "tests/test_script.py" in selected
    assert "tests/test_other.py" not in selected
    assert "tests/test_unrelated.py" not in selected


def test_a_dotted_string_and_a_script_path_count_as_references(tree: Path) -> None:
    selected = sel.select_tests(["src/podcast_mcp/edits/other.py"], tree)
    assert {"tests/test_other.py", "tests/test_string.py"} <= set(selected)
    assert "tests/test_cuts.py" not in selected


def test_tree_scanners_run_for_any_source_change_and_no_other_change(tree: Path) -> None:
    assert "tests/test_tree.py" in sel.select_tests(["src/podcast_mcp/edits/other.py"], tree)
    assert "tests/test_tree.py" not in sel.select_tests(["tests/test_other.py"], tree)


def test_a_changed_test_selects_itself(tree: Path) -> None:
    assert sel.select_tests(["tests/test_unrelated.py"], tree) == ["tests/test_unrelated.py"]


def test_a_deleted_module_selects_the_files_that_still_name_it(tree: Path) -> None:
    (tree / "src/podcast_mcp/edits/other.py").unlink()
    selected = sel.select_tests(["src/podcast_mcp/edits/other.py"], tree)
    assert {"tests/test_other.py", "tests/test_string.py"} <= set(selected)


def test_a_package_init_reaches_everything_that_imports_below_it(tree: Path) -> None:
    selected = set(sel.select_tests(["src/podcast_mcp/util/__init__.py"], tree))
    assert {"tests/test_clock.py", "tests/test_cuts.py"} <= selected


def test_a_conftest_import_reaches_every_test(tree: Path) -> None:
    (tree / "tests/conftest.py").write_text("from podcast_mcp.edits.other import VALUE\n")
    selected = set(sel.select_tests(["src/podcast_mcp/edits/other.py"], tree))
    assert "tests/test_unrelated.py" in selected


def test_a_relative_import_resolves(tree: Path) -> None:
    (tree / "src/podcast_mcp/edits/sibling.py").write_text("from . import other\n")
    (tree / "tests/test_sibling.py").write_text("import podcast_mcp.edits.sibling\n")
    assert "tests/test_sibling.py" in sel.select_tests(["src/podcast_mcp/edits/other.py"], tree)


def test_a_syntax_error_raises_so_the_caller_runs_everything(tree: Path) -> None:
    (tree / "src/podcast_mcp/edits/other.py").write_text("def (:\n")
    with pytest.raises(ValueError, match="cannot parse"):
        sel.select_tests(["src/podcast_mcp/edits/other.py"], tree)


@pytest.mark.parametrize(
    ("path", "eligible"),
    [
        ("src/podcast_mcp/edits/cuts.py", True),
        ("src/podcast_relay/app.py", True),
        ("tests/test_x.py", True),
        ("tests/conftest.py", False),
        ("tests/e2e/conftest.py", False),
        ("src/podcast_mcp/data/template.json", False),
        ("scripts/ci_plan.py", False),
        ("pyproject.toml", False),
    ],
)
def test_eligibility(path: str, eligible: bool) -> None:
    assert sel.is_eligible(path) is eligible


def test_every_repo_tree_scanner_is_selected_for_a_source_change() -> None:
    selected = set(sel.select_tests(["src/podcast_mcp/edits/cuts.py"]))
    for name in (
        "test_module_size_budget",
        "test_service_boundaries",
        "test_service_result_types",
        "test_css_policy",
    ):
        assert f"tests/{name}.py" in selected


def test_a_module_an_exporter_script_imports_selects_the_generated_artifact_checks() -> None:
    selected = sel.select_tests(["src/podcast_mcp/gui/schemas.py"])
    assert "tests/test_generated_artifacts.py" in selected
