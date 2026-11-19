"""Run fabricated boundary cases locally; GitHub service outcomes remain hosted proof."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/browser-diagnostics-synthetic.yml"
HELPER = ROOT / "scripts/browser_public_synthetic.py"
MARKER = "FABRICATED_BROWSER_CANARY_ORDINARY_TEXT"


def job():
    return load_github_yaml(WORKFLOW)["jobs"]["synthetic-publication"]


def run_step(step, cwd, env):
    command = step["run"].replace("scripts/", f"{ROOT}/scripts/")
    return subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", command],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("mode", ["success", "failure-retry", "malformed", "stale"])
def test_real_boundary_commands_with_only_fabricated_inputs(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    runner = tmp_path / "private-runner"
    runner.mkdir()
    env = {
        **os.environ,
        "RUNNER_TEMP": str(runner),
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
        "SYNTHETIC_MODE": mode,
        "BROWSER_RAW_REPORT": "playwright-report/synthetic.json",
        "BROWSER_CAPTURE_RECEIPT": str(tmp_path / "receipt"),
        "SYNTHETIC_PUBLIC_REPORT": str(tmp_path / "public/result.json"),
        "SYNTHETIC_SUMMARY": str(tmp_path / "bounded-summary.md"),
    }
    channels = (
        "GITHUB_STEP_SUMMARY",
        "GITHUB_OUTPUT",
        "GITHUB_ENV",
        "GITHUB_PATH",
        "GITHUB_STATE",
    )
    for channel in channels:
        env[channel] = str(tmp_path / channel)
        Path(env[channel]).write_text("")
    steps = {s["id"]: s for s in job()["steps"] if "id" in s}
    assert run_step(steps["prepared"], tmp_path, env).returncode == 0
    capture = run_step(steps["capture"], tmp_path, env)
    assert capture.returncode == (7 if mode == "failure-retry" else 0)
    assert MARKER not in capture.stdout + capture.stderr
    assert all(Path(env[name]).read_text() == "" for name in channels)
    assert any(MARKER in f.read_text() for f in runner.rglob("console.log"))
    projected = run_step(steps["projection"], tmp_path, env)
    valid = mode in {"success", "failure-retry"}
    assert projected.returncode == (0 if valid else 2)
    assert MARKER not in projected.stdout + projected.stderr
    if valid:
        summary = run_step(steps["summary"], tmp_path, env)
        assert summary.returncode == 0
        assert MARKER not in Path(env["GITHUB_STEP_SUMMARY"]).read_text()
        data = json.loads(Path(env["SYNTHETIC_PUBLIC_REPORT"]).read_text())
        attempts = [r for spec in data["suites"][0]["specs"] for r in spec["tests"][0]["results"]]
        assert [(r["status"], r["retry"], r["duration"]) for r in attempts] == (
            [("passed", 0, 10)]
            if mode == "success"
            else [("failed", 0, 20), ("failed", 0, 30), ("passed", 1, 40)]
        )
    else:
        assert not Path(env["SYNTHETIC_PUBLIC_REPORT"]).exists()
        assert not Path(env["SYNTHETIC_SUMMARY"]).exists()
    env.update(
        CAPTURE_OUTCOME="failure" if mode == "failure-retry" else "success",
        PROJECTION_OUTCOME="success" if valid else "failure",
        SUMMARY_OUTCOME="success" if valid else "skipped",
        UPLOAD_OUTCOME="success" if valid else "skipped",
    )
    final = next(s for s in job()["steps"] if s.get("name") == "Require exact synthetic outcomes")
    assert run_step(final, tmp_path, env).returncode == 0
    env["UPLOAD_OUTCOME"] = "failure" if valid else "success"
    assert run_step(final, tmp_path, env).returncode == 2


def test_draft_scope_and_publication_guards():
    workflow = load_github_yaml(WORKFLOW)
    assert workflow["on"] == {"pull_request": {"types": ["synchronize"], "branches": ["develop"]}}
    assert workflow["permissions"] == {"contents": "read"}
    gate = job()["if"]
    for clause in (
        "github.event_name == 'pull_request'",
        "github.event.action == 'synchronize'",
        "github.repository == 'calebn/sharecut-studio'",
        "github.event.pull_request.number == 4006",
        "github.event.pull_request.draft == true",
        "github.event.pull_request.head.repo.full_name == github.repository",
        "github.event.pull_request.head.ref == 'chore/browser-diagnostics-privacy-20261119'",
    ):
        assert clause in gate
    steps = job()["steps"]
    assert steps[0]["with"] == {
        "ref": "${{ github.event.pull_request.head.sha }}",
        "persist-credentials": False,
    }
    assert [s.get("id") for s in steps if s.get("continue-on-error")] == ["capture", "projection"]
    projection = next(s for s in steps if s.get("id") == "projection")
    assert projection["if"] == "${{ always() && steps.prepared.outcome == 'success' }}"
    assert "public --mode" in projection["run"]
    summary = next(s for s in steps if s.get("id") == "summary")
    assert summary["if"] == "${{ always() && steps.projection.outcome == 'success' }}"
    assert summary["run"].index("summary --mode") < summary["run"].index('cat "$SYNTHETIC_SUMMARY"')
    upload = next(s for s in steps if s.get("id") == "upload")
    assert (
        upload["if"]
        == "${{ always() && steps.projection.outcome == 'success' && steps.summary.outcome == 'success' }}"
    )
    assert upload["with"]["path"] == "synthetic-public/result.json"
    assert upload["with"]["if-no-files-found"] == "error"
    assert "secrets." not in WORKFLOW.read_text()


def test_canary_rejects_changed_immutable_boundary(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    helper = scripts / HELPER.name
    helper.write_bytes(HELPER.read_bytes())
    for name in ("private_browser_command.sh", "browser_public_report.py", "test_area_summary.py"):
        (scripts / name).write_text("changed")
    result = subprocess.run(
        [sys.executable, str(helper), "prepare", "--mode", "success"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == "Synthetic diagnostics validation failed.\n"
