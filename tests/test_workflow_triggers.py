"""Workflow triggers follow config/branches.json: develop integrates, promote.yml releases."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

promote = load_script("promote", register=True)

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
BRANCHES = json.loads((ROOT / "config" / "branches.json").read_text(encoding="utf-8"))
BASE = BRANCHES["base"]
RELEASE = BRANCHES["release"]

PUSH_ON_BASE = (
    "test",
    "secret-scan",
    "extras-import",
    "registry-backup-windows",
    "deploy-config",
    "release-wheel",
)
FILTERED_PULL_REQUESTS = ("test", "registry-backup-windows")
UNFILTERED_PULL_REQUESTS = (
    "secret-scan",
    "extras-import",
    "deploy-config",
    "release-wheel",
    "desktop",
    "storybook",
    "relay-ci",
)
DISPATCHABLE = (
    "test",
    "secret-scan",
    "desktop",
    "registry-backup-windows",
    "storybook",
    "promote",
    "close-issues-on-develop",
)
WEEKLY_SCHEDULES = {
    "secret-scan": "17 5 * * 1",
    "extras-import": "41 6 * * 1",
}


def workflow(name: str) -> dict:
    return load_github_yaml(WORKFLOWS / f"{name}.yml")


@pytest.mark.parametrize("name", PUSH_ON_BASE)
def test_push_runs_on_the_base_branch(name: str) -> None:
    assert BASE in workflow(name)["on"]["push"]["branches"]


@pytest.mark.parametrize("name", FILTERED_PULL_REQUESTS)
def test_pull_requests_to_base_and_release_run_where_trunk_filtered(name: str) -> None:
    assert {BASE, RELEASE} <= set(workflow(name)["on"]["pull_request"]["branches"])


@pytest.mark.parametrize("name", UNFILTERED_PULL_REQUESTS)
def test_pull_requests_stay_unfiltered_where_trunk_had_no_filter(name: str) -> None:
    assert "branches" not in workflow(name)["on"]["pull_request"]


def test_relay_ci_has_no_push_trigger() -> None:
    assert "push" not in workflow("relay-ci")["on"]


def test_desktop_has_no_push_trigger() -> None:
    assert "push" not in workflow("desktop")["on"]


@pytest.mark.parametrize("name", DISPATCHABLE)
def test_dispatchable_workflows_accept_workflow_dispatch(name: str) -> None:
    assert "workflow_dispatch" in workflow(name)["on"]


def test_schedules_live_only_in_promote_and_the_weekly_drift_checks() -> None:
    scheduled = {
        path.stem: [entry["cron"] for entry in data["on"]["schedule"]]
        for path in sorted(WORKFLOWS.glob("*.yml"))
        if "schedule" in (data := load_github_yaml(path))["on"]
    }
    assert scheduled == {
        "promote": ["23 7 * * *"],
        **{name: [cron] for name, cron in WEEKLY_SCHEDULES.items()},
    }


@pytest.mark.parametrize("name", ["test", "desktop", "registry-backup-windows"])
def test_promote_owns_the_nightly_alert(name: str) -> None:
    assert "nightly-alert" not in workflow(name)["jobs"]


def test_storybook_deploys_only_from_the_release_branch() -> None:
    data = workflow("storybook")
    assert data["on"]["push"]["branches"] == [RELEASE]
    condition = f"github.ref == 'refs/heads/{RELEASE}' && contains(fromJSON('[\"push\",\"workflow_dispatch\"]'), github.event_name)"
    assert data["jobs"]["deploy"]["if"] == condition
    upload = next(
        step
        for step in data["jobs"]["build"]["steps"]
        if step.get("name") == "Upload Pages artifact"
    )
    assert upload["if"] == condition


def test_concurrency_coalesces_pushes_to_both_branches() -> None:
    for name in (*PUSH_ON_BASE, "desktop", "relay-ci"):
        group = workflow(name).get("concurrency", {}).get("group", "")
        if name in {"deploy-config", "release-wheel"}:
            assert "github.ref" in group
            continue
        assert f"github.ref == 'refs/heads/main' && '{name}-main'" in group, name
        assert f"github.ref == 'refs/heads/develop' && '{name}-develop'" in group, name
    storybook_group = workflow("storybook")["concurrency"]["group"]
    assert f"refs/heads/{RELEASE}' && 'storybook-{RELEASE}'" in storybook_group


def test_dependabot_targets_the_base_branch() -> None:
    updates = load_github_yaml(ROOT / ".github" / "dependabot.yml")["updates"]
    assert updates
    assert {update["target-branch"] for update in updates} == {BASE}


def test_required_jobs_exist_in_the_workflows_promote_dispatches() -> None:
    names = {
        job.get("name", job_id)
        for file in promote.CI_WORKFLOWS
        for job_id, job in load_github_yaml(WORKFLOWS / file)["jobs"].items()
    }
    assert set(BRANCHES["required_jobs"]) <= names


def test_promote_is_scheduled_nightly_serialised_and_privileged_for_the_push() -> None:
    data = workflow("promote")
    assert data["on"]["schedule"] == [{"cron": "23 7 * * *"}]
    inputs = data["on"]["workflow_dispatch"]["inputs"]
    assert inputs["dry-run"]["type"] == "boolean" and inputs["dry-run"]["default"] is False
    assert inputs["target"]["default"] == RELEASE
    assert data["permissions"] == {"contents": "write", "actions": "write"}
    group = data["concurrency"]["group"]
    assert data["concurrency"]["cancel-in-progress"] is False
    assert group.endswith("&& 'promote-rehearsal' || 'promote' }}")
    assert "inputs.dry-run == true" in group and "inputs.target != 'main'" in group
    assert data["jobs"]["promote"]["timeout-minutes"] == 330
    assert data["jobs"]["promote"]["if"] == f"github.ref == 'refs/heads/{RELEASE}'"
    checkout = data["jobs"]["promote"]["steps"][0]
    assert checkout["with"]["ref"] == RELEASE
    assert data["on"]["workflow_dispatch"]["inputs"]["target"]["default"] == RELEASE


def test_promote_runs_the_script_cleans_up_always_and_never_forces() -> None:
    steps = workflow("promote")["jobs"]["promote"]["steps"]
    run = next(step for step in steps if "promote.py run" in step.get("run", ""))
    assert "--no-push" in run["run"]
    assert run["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
    cleanup = next(step for step in steps if "promote.py cleanup" in step.get("run", ""))
    assert cleanup["if"] == "always()"
    assert "--force" not in (WORKFLOWS / "promote.yml").read_text(encoding="utf-8")


def test_promote_alerts_on_scheduled_and_real_runs_but_not_dry_runs() -> None:
    alert = workflow("promote")["jobs"]["nightly-alert"]
    assert alert["needs"] == "promote"
    clauses = alert["if"].removeprefix("${{").removesuffix("}}").split("&&", 2)
    assert [c.strip() for c in clauses[:2]] == ["always()", f"github.ref == 'refs/heads/{RELEASE}'"]
    dry_run, target = (c.strip() for c in clauses[2].split("&&"))
    assert dry_run == "inputs.dry-run != true"
    assert target == f"(inputs.target == '' || inputs.target == '{RELEASE}')"
    assert alert["permissions"] == {"contents": "read", "issues": "write"}
    step = next(s for s in alert["steps"] if s.get("uses") == "./.github/actions/nightly-alert")
    assert step["with"]["workflow"] == "promote"
    assert step["with"]["results"] == "${{ join(needs.*.result, ' ') }}"


def test_release_please_targets_the_base_branch_and_waits_for_promotion() -> None:
    text = (WORKFLOWS / "release-please.yml").read_text(encoding="utf-8")
    workflow = load_github_yaml(WORKFLOWS / "release-please.yml")
    steps = workflow["jobs"]["release-please"]["steps"]

    action = next(step for step in steps if "release-please-action" in step.get("uses", ""))
    assert action["with"]["target-branch"] == "${{ steps.branches.outputs.base }}"
    guard = next(step for step in steps if "not yet on" in step.get("run", ""))
    assert "merge-base --is-ancestor" in guard["run"]
    assert steps.index(guard) < steps.index(action)
    assert "refs/heads/main" not in text
