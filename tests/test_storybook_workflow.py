"""Keep the component catalog build and deployment contract explicit."""

from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/storybook.yml"


def _workflow() -> dict:
    # BaseLoader preserves GitHub's `on` key (YAML 1.1 otherwise treats it as a bool).
    return yaml.load(WORKFLOW.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def test_storybook_build_covers_component_edits_before_and_after_merge() -> None:
    workflow = _workflow()
    for event in ("push", "pull_request"):
        paths = workflow["on"][event]["paths"]
        assert "gui/web/**" in paths
        assert ".github/workflows/storybook.yml" in paths


def test_storybook_pr_build_cannot_deploy_pages() -> None:
    workflow = _workflow()
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["build"].get("permissions") is None
    upload = next(
        step
        for step in workflow["jobs"]["build"]["steps"]
        if step.get("name") == "Upload Pages artifact"
    )
    assert upload["if"] == "github.event_name == 'push'"

    deploy = workflow["jobs"]["deploy"]
    assert deploy["if"] == ("github.event_name == 'push' && github.ref == 'refs/heads/main'")
    assert deploy["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }
