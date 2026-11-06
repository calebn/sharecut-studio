"""Keep the component catalog build and deployment contract explicit."""

from pathlib import Path

from github_yaml import load_github_yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/storybook.yml"
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
    assert smoke["run"] == "npm run test:e2e:storybook -- coverage.spec.ts docs-theme.spec.ts"
    assert full["if"] == "github.event_name != 'pull_request'"
    assert full["run"] == "npm run test:e2e:storybook"
