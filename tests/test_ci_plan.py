"""scripts/ci_plan.py: which test.yml jobs a pull request, push or nightly run needs."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
cp = load_script("ci_plan", register=True)

MAIN = ["main-1of4", "main-2of4", "main-3of4", "main-4of4"]
PR_E2E = [*MAIN, "compat-webkit-1of2", "compat-webkit-2of2"]
FULL_E2E = [*MAIN, "compat-chromium", "compat-webkit"]

# Every pattern whose changes run Vitest and the browser suites on a PR. Editing
# this list is a review decision: a path left out skips e2e until main runs it.
GUI_PATTERNS = [
    "gui/web/**",
    "src/podcast_mcp/gui/**",
    "src/podcast_mcp/services/**",
    "src/podcast_mcp/models/**",
    "src/podcast_mcp/mcp/**",
    "src/podcast_mcp/extensions/**",
    "src/podcast_mcp/history/**",
    "src/podcast_mcp/cli/**",
    "src/podcast_mcp/*.py",
    "contracts/**",
    "schemas/**",
    "deploy/brand/**",
    "tests/fixtures/aligned_dialogue/**",
    "tests/fixtures/sharecut_ux_demo/**",
    "scripts/ci_plan.py",
    "scripts/docs_sync.py",
    "scripts/export_timeline_zoom.py",
    "scripts/build_large_project_fixture.py",
    "scripts/ux_demo_prepare_shares.py",
    "docs/daw-shortcuts.md",
    "ux/pages/shortcuts.md",
    ".github/workflows/test.yml",
    ".github/actions/**",
    "pyproject.toml",
    "uv.lock",
    ".nvmrc",
]


def _names(plan) -> list[str]:
    return [job.name for job in plan.e2e]


def test_gui_path_set_is_pinned() -> None:
    gui = [glob.text for glob, scope in cp.PATH_RULES if scope is cp.Scope.GUI]
    assert gui == GUI_PATTERNS


def test_every_tracked_path_is_classified_by_a_rule() -> None:
    tracked = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    unclassified = [path for path in tracked if cp.rule_for(path) is None]
    assert unclassified == [], "classify these in scripts/ci_plan.py PATH_RULES"


def test_every_python_package_is_classified_at_its_own_directory() -> None:
    packages = sorted(
        path.name
        for path in (ROOT / "src" / "podcast_mcp").iterdir()
        if path.is_dir() and (path / "__init__.py").exists()
    )
    rules = {glob.text for glob, _ in cp.PATH_RULES}
    assert [name for name in packages if f"src/podcast_mcp/{name}/**" not in rules] == []


def test_no_rule_is_shadowed_by_an_earlier_one() -> None:
    for glob, scope in cp.PATH_RULES:
        probe = glob.text.replace("**", "probe.py")
        probe = probe.replace("*", "probe")
        assert cp.rule_for(probe) == (glob, scope), glob.text


@pytest.mark.parametrize(
    "path",
    ["brand-new-dir/x.py", "src/podcast_mcp/new_package/x.py", "gui/new_shell/main.ts"],
)
def test_an_unclassified_path_runs_the_browser_suites(path: str) -> None:
    assert cp.rule_for(path) is None
    plan = cp.plan("pull_request", [path])
    assert plan.gui is True
    assert _names(plan) == PR_E2E


@pytest.mark.parametrize(
    ("changed", "gui", "pytest_scope", "e2e"),
    [
        (["docs/setup.md", "README.md"], False, "full", []),
        (["src/podcast_mcp/engines/bleed_gate.py", "tests/test_bleed_gate.py"], False, "full", []),
        (["src/podcast_mcp/edits/cuts.py"], False, "full", []),
        (["gui/web/src/App.tsx", "gui/web/e2e/recordRoom.ts"], True, "web", PR_E2E),
        (["gui/web/src/App.tsx", "docs/gui-integration.md"], True, "full", PR_E2E),
        (["src/podcast_mcp/services/play.py"], True, "full", PR_E2E),
        (["src/podcast_mcp/project_io.py"], True, "full", PR_E2E),
        (["contracts/timeline-zoom.json"], True, "full", PR_E2E),
        (["docs/daw-shortcuts.md"], True, "full", PR_E2E),
        (["tests/fixtures/aligned_dialogue/episode.project.json"], True, "full", PR_E2E),
        ([".github/workflows/test.yml"], True, "full", PR_E2E),
        ([".github/workflows/desktop.yml"], False, "full", []),
        (["gui/desktop/src-tauri/src/main.rs"], False, "full", []),
        ([], True, "full", PR_E2E),
    ],
)
def test_pull_request_plan(
    changed: list[str], gui: bool, pytest_scope: str, e2e: list[str]
) -> None:
    plan = cp.plan("pull_request", changed)
    assert (plan.gui, plan.pytest, _names(plan)) == (gui, pytest_scope, e2e)


@pytest.mark.parametrize("event", ["push", "schedule", "workflow_dispatch"])
def test_main_nightly_and_dispatch_run_everything(event: str) -> None:
    plan = cp.plan(event, [])
    assert (plan.gui, plan.pytest, _names(plan)) == (True, "full", FULL_E2E)


def test_matrix_output_is_the_workflow_include_list() -> None:
    outputs = cp.plan("pull_request", ["gui/web/src/App.tsx"]).outputs()
    assert outputs["gui"] == "true"
    assert outputs["pytest"] == "web"
    assert json.loads(outputs["e2e-matrix"])["include"][-1] == {
        "name": "compat-webkit-2of2",
        "command": "npm run test:e2e:compat -- --project=webkit --shard=2/2",
        "browser": "webkit",
    }


def test_web_tests_select_files_that_name_gui_web(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    (tests / "nested").mkdir(parents=True)
    (tests / "test_slash.py").write_text('CSS = ROOT / "gui/web/src/App.css"\n')
    (tests / "test_parts.py").write_text("WEB = ROOT / 'gui' / 'web'\n")
    (tests / "nested" / "test_args.py").write_text('WEB = Path("gui", "web")\n')
    (tests / "test_other.py").write_text('DOCS = ROOT / "docs"\n')
    (tests / "helper_gui_web.py").write_text('X = "gui/web"\n')
    assert cp.web_tests(tmp_path) == [
        "tests/nested/test_args.py",
        "tests/test_parts.py",
        "tests/test_slash.py",
    ]


def test_web_tests_include_the_repo_gui_web_readers() -> None:
    selected = set(cp.web_tests())
    assert {
        "tests/test_browser_acceptance_matrix.py",
        "tests/test_css_policy.py",
        "tests/test_gui_api.py",
        "tests/test_gui_static_root.py",
        "tests/test_ci_plan.py",
    } <= selected
    assert "tests/test_bleed_gate_channels.py" not in selected


def test_changed_files_diffs_from_the_merge_base(tmp_path: Path) -> None:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(tmp_path), *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "ci")
    (tmp_path / "README.md").write_text("a\n")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-b", "pr")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "x.md").write_text("x\n")
    git("add", ".")
    git("commit", "-q", "-m", "pr")
    git("checkout", "-q", "main")
    (tmp_path / "README.md").write_text("b\n")
    git("commit", "-q", "-am", "trunk moved")
    assert cp.changed_files("main", "pr", root=tmp_path) == ["docs/x.md"]


def test_pytest_job_plans_in_job_and_gates_coverage_on_full_runs() -> None:
    steps = load_github_yaml(WORKFLOW)["jobs"]["pytest"]["steps"]
    assert "needs" not in load_github_yaml(WORKFLOW)["jobs"]["pytest"]
    by_name = {step.get("name"): step for step in steps}
    plan = by_name["Plan the pytest scope"]
    assert plan["id"] == "plan"
    assert plan["run"].startswith("python3 scripts/ci_plan.py plan --event")
    assert by_name["Run tests with coverage gate"]["if"] == "steps.plan.outputs.pytest != 'web'"
    web = by_name["Run the tests that read gui/web"]
    assert web["if"] == "steps.plan.outputs.pytest == 'web'"
    assert '"$(python3 scripts/ci_plan.py web-tests)"' in web["run"]
    assert "--no-cov" in web["run"]
    docs_sync = by_name["Docs-sync gate (PR diff)"]
    assert "pytest" not in docs_sync["if"]


def test_changes_job_feeds_frontend_and_the_browser_suites() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    changes = jobs["changes"]
    assert changes["outputs"] == {
        "gui": "${{ steps.plan.outputs.gui }}",
        "e2e-matrix": "${{ steps.plan.outputs.e2e-matrix }}",
    }
    (plan,) = [step for step in changes["steps"] if step.get("id") == "plan"]
    assert plan["run"].startswith("python3 scripts/ci_plan.py plan --event")
    for name in ("frontend", "frontend-e2e-suites"):
        assert jobs[name]["needs"] == "changes"
        assert jobs[name]["if"] == "needs.changes.outputs.gui == 'true'"
    assert set(load_github_yaml(WORKFLOW)["on"]) == {
        "push",
        "pull_request",
        "schedule",
        "workflow_dispatch",
    }
