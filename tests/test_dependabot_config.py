"""Dependabot config stays in sync with tracked lockfiles; audit stays advisory."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
TEST_WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"


def _load(path: Path) -> dict:
    # BaseLoader-free load, with GitHub's `on` -> True (YAML 1.1 bool) quirk fixed.
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data


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
    config = _load(DEPENDABOT)
    return {(update["package-ecosystem"], update["directory"]) for update in config["updates"]}


def test_dependabot_config_is_v2_with_expected_ecosystems() -> None:
    config = _load(DEPENDABOT)
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
    config = _load(DEPENDABOT)
    for update in config["updates"]:
        assert update["schedule"]["interval"] == "weekly"
        assert update["open-pull-requests-limit"] >= 1
        assert update["commit-message"] == {"prefix": "chore", "include": "scope"}
        groups = update["groups"]
        assert groups
        for group in groups.values():
            assert group["update-types"] == ["minor", "patch"]
        assert "labels" not in update


def test_frontend_job_runs_nonblocking_prod_audit_after_install() -> None:
    workflow = _load(TEST_WORKFLOW)
    job = workflow["jobs"]["frontend"]
    assert job["defaults"]["run"]["working-directory"] == "gui/web"

    steps = job["steps"]
    run_commands = [step.get("run") for step in steps]
    ci_index = run_commands.index("npm ci")
    audit_index = next(
        i
        for i, step in enumerate(steps)
        if step.get("run") == "npm audit --omit=dev --audit-level=high"
    )
    assert audit_index > ci_index

    audit_step = steps[audit_index]
    assert audit_step["continue-on-error"] is True
    assert "working-directory" not in audit_step
