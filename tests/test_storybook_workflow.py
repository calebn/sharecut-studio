"""Keep the component catalog build and deployment contract explicit."""

import json
from pathlib import Path

import pytest

from github_yaml import load_github_yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = REPO_ROOT / ".github/workflows/storybook.yml"
PACKAGE = REPO_ROOT / "gui/web/package.json"
PRIVATE_BROWSER_COMMAND = "bash ../../scripts/private_browser_command.sh"
DEPLOYS_ONLY_FROM_MAIN = (
    "github.ref == 'refs/heads/main' && "
    """contains(fromJSON('["push","workflow_dispatch"]'), github.event_name)"""
)


def test_storybook_build_covers_component_edits_before_and_after_merge() -> None:
    workflow = load_github_yaml(WORKFLOW)
    for event in ("push", "pull_request"):
        paths = workflow["on"][event]["paths"]
        assert "gui/web/**" in paths
        assert ".github/workflows/storybook.yml" in paths


def test_storybook_pr_build_cannot_deploy_pages() -> None:
    workflow = load_github_yaml(WORKFLOW)
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["build"].get("permissions") is None
    upload = next(
        step
        for step in workflow["jobs"]["build"]["steps"]
        if step.get("name") == "Upload Pages artifact"
    )
    assert upload["if"] == DEPLOYS_ONLY_FROM_MAIN

    deploy = workflow["jobs"]["deploy"]
    assert deploy["if"] == DEPLOYS_ONLY_FROM_MAIN
    assert deploy["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }


def test_storybook_pull_requests_run_only_the_render_smoke() -> None:
    workflow = load_github_yaml(WORKFLOW)
    assert workflow["jobs"]["sweep"]["if"] == "github.event_name != 'pull_request'"
    steps = {step["name"]: step for step in workflow["jobs"]["build"]["steps"] if "name" in step}
    smoke = steps["Build Storybook and run the render smoke"]
    full = steps["Build Storybook and verify browser geometry"]
    assert smoke["if"] == "github.event_name == 'pull_request'"
    assert smoke["run"] == (
        f"{PRIVATE_BROWSER_COMMAND} npm run test:e2e:storybook -- coverage.spec.ts docs-theme.spec.ts"
    )
    assert full["if"] == "github.event_name != 'pull_request'"
    assert full["run"] == f"{PRIVATE_BROWSER_COMMAND} npm run test:e2e:storybook"
    for step in (smoke, full):
        assert step["working-directory"] == "gui/web"
        assert step.get("continue-on-error", False) is False
    sweep = next(
        step
        for step in workflow["jobs"]["sweep"]["steps"]
        if step.get("name") == "Sweep every story for axe violations and overflow"
    )
    assert sweep["run"] == f"{PRIVATE_BROWSER_COMMAND} npm run test:stories"
    assert sweep["working-directory"] == "gui/web"
    assert sweep.get("continue-on-error", False) is False


def _assert_layout_wiring(workflow_path: Path, package_path: Path) -> None:
    workflow = load_github_yaml(workflow_path)
    layout = [
        step
        for step in workflow["jobs"]["build"]["steps"]
        if step.get("run") == f"{PRIVATE_BROWSER_COMMAND} npm run test:layout"
    ]
    assert len(layout) == 1, "the build must run the layout suite exactly once"
    assert layout[0].get("if") == "github.event_name != 'pull_request'"
    assert layout[0].get("working-directory") == "gui/web"
    assert layout[0].get("continue-on-error", False) is False
    scripts = json.loads(package_path.read_text(encoding="utf-8"))["scripts"]
    command = "vitest run --config vitest.stories.config.ts"
    assert scripts.get("test:layout") == f"{command} layout.browser"
    assert scripts.get("test:stories") == f"{command} sweep.browser"


def test_storybook_layout_runs_only_outside_prs_with_separate_suite_filters() -> None:
    _assert_layout_wiring(WORKFLOW, PACKAGE)


@pytest.mark.parametrize(
    "mutation",
    [
        "unchanged",
        "missing-layout",
        "unwrapped-layout",
        "ignored-layout-failure",
        "unguarded-layout",
        "pr-layout",
        "layout-selects-sweep",
        "sweep-selects-layout",
    ],
)
def test_layout_wiring_controls_use_isolated_copies(tmp_path: Path, mutation: str) -> None:
    workflow = load_github_yaml(WORKFLOW)
    package = json.loads(PACKAGE.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["build"]["steps"]
    layout = next(
        step for step in steps if step.get("name") == "Verify Prepare text layout (Vitest browser)"
    )
    match mutation:
        case "missing-layout":
            steps.remove(layout)
        case "unwrapped-layout":
            layout["run"] = "npm run test:layout"
        case "ignored-layout-failure":
            layout["continue-on-error"] = True
        case "unguarded-layout":
            layout.pop("if")
        case "pr-layout":
            layout["if"] = "github.event_name == 'pull_request'"
        case "layout-selects-sweep":
            package["scripts"]["test:layout"] = package["scripts"]["test:stories"]
        case "sweep-selects-layout":
            package["scripts"]["test:stories"] = package["scripts"]["test:layout"]
    workflow_copy = tmp_path / "storybook.yml"
    package_copy = tmp_path / "package.json"
    workflow_copy.write_text(json.dumps(workflow), encoding="utf-8")
    package_copy.write_text(json.dumps(package), encoding="utf-8")
    if mutation == "unchanged":
        _assert_layout_wiring(workflow_copy, package_copy)
    else:
        with pytest.raises(AssertionError):
            _assert_layout_wiring(workflow_copy, package_copy)
