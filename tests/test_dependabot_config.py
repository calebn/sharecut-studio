"""Dependabot config stays in sync with tracked lockfiles; audit stays advisory."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
TEST_WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
AUDIT_COMMAND = "npm audit --omit=dev --audit-level=high"


_LOCKFILE_ECOSYSTEM = {
    "package-lock.json": "npm",
    "uv.lock": "uv",
    "Cargo.lock": "cargo",
}


def _tracked_lockfiles() -> list[Path]:
    out = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
    ).split(b"\0")
    paths = (ROOT / os.fsdecode(raw) for raw in out if raw)
    return [p for p in paths if p.name in _LOCKFILE_ECOSYSTEM]


def _entries() -> set[tuple[str, str]]:
    config = load_github_yaml(DEPENDABOT)
    return {(update["package-ecosystem"], update["directory"]) for update in config["updates"]}


def test_dependabot_config_is_v2_with_expected_ecosystems() -> None:
    config = load_github_yaml(DEPENDABOT)
    assert config["version"] == 2
    assert _entries() == {
        ("npm", "/gui/web"),
        ("npm", "/gui/desktop"),
        ("cargo", "/gui/desktop/src-tauri"),
        ("uv", "/"),
        ("github-actions", "/"),
    }


def test_every_tracked_lockfile_has_a_dependabot_entry() -> None:
    tracked = _tracked_lockfiles()
    rel = {p.relative_to(ROOT).as_posix() for p in tracked}
    assert "gui/web/package-lock.json" in rel

    entries = _entries()
    for path in tracked:
        ecosystem = _LOCKFILE_ECOSYSTEM[path.name]
        parent = path.relative_to(ROOT).parent
        directory = "/" if parent == Path(".") else "/" + parent.as_posix()
        assert (ecosystem, directory) in entries, (ecosystem, directory)


def test_every_update_is_weekly_grouped_and_conventional() -> None:
    config = load_github_yaml(DEPENDABOT)
    for update in config["updates"]:
        assert update["schedule"]["interval"] == "weekly"
        assert update["open-pull-requests-limit"] >= 1
        assert update["commit-message"] == {"prefix": "chore", "include": "scope"}
        groups = update["groups"]
        version_groups = [g for g in groups.values() if g.get("applies-to") == "version-updates"]
        security_groups = [g for g in groups.values() if g.get("applies-to") == "security-updates"]
        assert len(version_groups) == 1
        assert version_groups[0]["update-types"] == ["minor", "patch"]
        # Security fixes batch into one PR per ecosystem instead of one PR per package.
        assert len(security_groups) == 1
        assert security_groups[0]["patterns"] == ["*"]
        assert len(groups) == 2
        assert "labels" not in update


def test_frontend_job_runs_nonblocking_prod_audit_after_install() -> None:
    workflow = load_github_yaml(TEST_WORKFLOW)
    job = workflow["jobs"]["frontend"]
    assert job["defaults"]["run"]["working-directory"] == "gui/web"

    steps = job["steps"]
    run_commands = [step.get("run") for step in steps]
    assert "npm ci" in run_commands, "frontend job must run npm ci"
    assert AUDIT_COMMAND in run_commands, f"frontend job must run {AUDIT_COMMAND}"
    ci_index = run_commands.index("npm ci")
    audit_index = run_commands.index(AUDIT_COMMAND)
    assert audit_index > ci_index, "npm audit must run after npm ci"

    audit_step = steps[audit_index]
    assert audit_step["continue-on-error"] is True
    assert "working-directory" not in audit_step


def test_frontend_audit_failure_is_written_to_job_summary() -> None:
    steps = load_github_yaml(TEST_WORKFLOW)["jobs"]["frontend"]["steps"]
    run_commands = [step.get("run") for step in steps]
    assert AUDIT_COMMAND in run_commands, f"frontend job must run {AUDIT_COMMAND}"
    audit_index = run_commands.index(AUDIT_COMMAND)
    assert steps[audit_index]["id"] == "npm-audit"

    summary_step = steps[audit_index + 1]
    assert summary_step["if"] == "steps.npm-audit.outcome == 'failure'"
    assert "GITHUB_STEP_SUMMARY" in summary_step["run"]
    assert "continue-on-error" not in summary_step
