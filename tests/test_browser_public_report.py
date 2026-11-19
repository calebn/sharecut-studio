import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/browser_public_report.py"
CAPTURE = ROOT / "scripts/private_browser_command.sh"
spec = importlib.util.spec_from_file_location("browser_public_report", SCRIPT)
assert spec and spec.loader
public_report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public_report)
MARKER = "FABRICATED_ORDINARY_MARKER"


def report():
    return {
        "config": {"metadata": MARKER},
        "errors": [{"message": MARKER}],
        "suites": [
            {
                "title": MARKER,
                "file": MARKER,
                "specs": [],
                "suites": [
                    {
                        "title": MARKER,
                        "specs": [
                            {
                                "title": MARKER,
                                "tags": [MARKER],
                                "tests": [
                                    {
                                        "projectName": MARKER,
                                        "expectedStatus": "passed",
                                        "status": "flaky",
                                        "annotations": [{"description": MARKER}],
                                        "results": [
                                            {
                                                "status": "failed",
                                                "retry": 0,
                                                "duration": 12.5,
                                                "error": {"message": MARKER},
                                                "stdout": [{"text": MARKER}],
                                                "stderr": [{"text": MARKER}],
                                                "attachments": [{"path": MARKER}],
                                            },
                                            {"status": "passed", "retry": 1, "duration": 7},
                                        ],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    }


def logical_test(value):
    return value["suites"][0]["suites"][0]["specs"][0]["tests"][0]


def capture_receipt(tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    receipt = tmp_path / "capture.txt"
    receipt.write_text("123 2\n")
    return receipt


def test_projection_drops_free_form_data_and_retains_failed_retry():
    result = public_report.project(report())
    assert MARKER not in json.dumps(result)
    assert result == {
        "format": "sharecut-browser-public-v1",
        "global_error_count": 1,
        "suites": [
            {
                "specs": [
                    {
                        "case_id": 1,
                        "tests": [
                            {
                                "status": "flaky",
                                "expectedStatus": "passed",
                                "results": [
                                    {"status": "failed", "retry": 0, "duration": 12.5},
                                    {"status": "passed", "retry": 1, "duration": 7},
                                ],
                            }
                        ],
                    }
                ],
                "suites": [],
            }
        ],
    }


@pytest.mark.parametrize("status", ["failed", "timedOut", "interrupted", "skipped"])
def test_attempt_status_and_missing_duration_are_not_changed(status):
    value = report()
    test = logical_test(value)
    test.update(status="unexpected", expectedStatus="failed")
    test["results"] = [{"status": status, "retry": 0}]
    projected = public_report.project(value)["suites"][0]["specs"][0]["tests"][0]
    assert projected == {
        "status": "unexpected",
        "expectedStatus": "failed",
        "results": [{"status": status, "retry": 0}],
    }


def test_skipped_empty_results_and_distinct_logical_cases_are_retained():
    value = report()
    tests = value["suites"][0]["suites"][0]["specs"][0]["tests"]
    tests.extend([{"status": "skipped", "expectedStatus": "skipped", "results": []}])
    specs = public_report.project(value)["suites"][0]["specs"]
    assert [s["case_id"] for s in specs] == [1, 2]
    assert specs[1]["tests"][0]["results"] == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("duration", float("nan")),
        ("duration", -1),
        ("duration", MARKER),
        ("retry", True),
        ("status", MARKER),
    ],
)
def test_unrecognized_attempt_values_fail_closed(field, value):
    source = report()
    logical_test(source)["results"][0][field] = value
    with pytest.raises(public_report.InvalidReport):
        public_report.project(source)


def test_cli_removes_stale_projection_without_echoing_bad_input(tmp_path, monkeypatch):
    receipt = capture_receipt(tmp_path, monkeypatch)
    source = tmp_path / "raw.json"
    source.write_text(MARKER)
    output = tmp_path / "public.json"
    output.write_text("stale")
    child = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--report",
            str(source),
            "--output",
            str(output),
            "--capture-receipt",
            str(receipt),
        ],
        capture_output=True,
        text=True,
    )
    assert child.returncode == 2
    assert MARKER not in child.stdout + child.stderr
    assert not output.exists()


@pytest.mark.parametrize("problem", ["missing", "old-attempt", "old-report"])
def test_projection_rejects_unbound_or_stale_raw_reports(tmp_path, monkeypatch, problem):
    receipt = capture_receipt(tmp_path, monkeypatch)
    source = tmp_path / "raw.json"
    source.write_text(json.dumps(report()))
    output = tmp_path / "public.json"
    output.write_text("stale")
    if problem == "missing":
        receipt.unlink()
    elif problem == "old-attempt":
        receipt.write_text("123 1\n")
    else:
        os.utime(source, ns=(1, 1))
    with pytest.raises((OSError, public_report.InvalidReport)):
        public_report.write_projection(source, output, receipt)
    assert not output.exists()


def test_projection_is_compatible_with_existing_safe_summary(tmp_path, monkeypatch):
    receipt = capture_receipt(tmp_path, monkeypatch)
    source = tmp_path / "raw.json"
    source.write_text(json.dumps(report()))
    output = tmp_path / "public.json"
    public_report.write_projection(source, output, receipt)
    child = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/test_area_summary.py"),
            "playwright",
            "--area",
            "main-e2e",
            "--report",
            str(output),
        ],
        capture_output=True,
        text=True,
    )
    assert child.returncode == 0
    assert "flaky: 1" in child.stdout
    assert "0.0 s" in child.stdout
    assert MARKER not in child.stdout + child.stderr
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


@pytest.mark.skipif(os.name == "nt", reason="CI capture requires Linux bash")
@pytest.mark.parametrize("exit_code", [0, 1, 7])
def test_command_capture_preserves_exit_teardown_and_isolates_channels(tmp_path, exit_code):
    runner = tmp_path / "runner"
    runner.mkdir()
    env = os.environ.copy()
    env["RUNNER_TEMP"] = str(runner)
    originals = {}
    channels = ["GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE"]
    for name in channels:
        target = tmp_path / name
        target.write_text("parent unchanged")
        originals[name] = target
        env[name] = str(target)
    child_script = (
        "import os,sys; from pathlib import Path; "
        f"print('::error::{MARKER}'); print('{MARKER}',file=sys.stderr); "
        f"[Path(os.environ[n]).write_text('{MARKER}') for n in {channels!r}]; "
        "\ntry:\n sys.exit(int(sys.argv[1]))\nfinally:\n print('fabricated teardown completed')\n"
    )
    child = subprocess.run(
        ["bash", str(CAPTURE), sys.executable, "-c", child_script, str(exit_code)],
        capture_output=True,
        text=True,
        env=env,
    )
    assert child.returncode == exit_code
    assert MARKER not in child.stdout + child.stderr
    private = next(runner.iterdir())
    assert "fabricated teardown completed" in (private / "console.log").read_text()
    assert stat.S_IMODE(private.stat().st_mode) == 0o700
    for name, original in originals.items():
        assert original.read_text() == "parent unchanged"
        assert (private / name).read_text() == MARKER


@pytest.mark.skipif(os.name == "nt", reason="CI capture runs on Linux")
def test_exec_keeps_the_fabricated_child_signal_status(tmp_path):
    env = {**os.environ, "RUNNER_TEMP": str(tmp_path)}
    child = subprocess.run(
        [
            "bash",
            str(CAPTURE),
            sys.executable,
            "-c",
            "import os,signal; os.kill(os.getpid(),signal.SIGTERM)",
        ],
        capture_output=True,
        env=env,
    )
    assert child.returncode == -signal.SIGTERM


@pytest.mark.skipif(os.name == "nt", reason="CI capture requires Linux bash")
def test_capture_removes_previous_raw_report_before_command(tmp_path):
    raw = tmp_path / "playwright-report/main-smoke.json"
    raw.parent.mkdir()
    raw.write_text(MARKER)
    env = {
        **os.environ,
        "RUNNER_TEMP": str(tmp_path),
        "BROWSER_RAW_REPORT": "playwright-report/main-smoke.json",
        "BROWSER_CAPTURE_RECEIPT": str(tmp_path / "capture.txt"),
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
    }
    child = subprocess.run(
        ["bash", str(CAPTURE), sys.executable, "-c", "pass"],
        cwd=tmp_path,
        capture_output=True,
        env=env,
    )
    assert child.returncode == 0
    assert not raw.exists()
    assert (tmp_path / "capture.txt").read_text() == "123 2\n"


def test_storybook_browser_commands_and_summaries_use_the_same_boundary():
    from github_yaml import load_github_yaml

    workflow = load_github_yaml(ROOT / ".github/workflows/storybook.yml")
    commands = []
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            command = step.get("run", "")
            if any(
                name in command
                for name in (
                    "npm run test:e2e:storybook",
                    "npm run test:stories",
                    "npm run test:layout",
                )
            ):
                commands.append(command)
                assert command.startswith("bash ../../scripts/private_browser_command.sh ")
            if step.get("name") == "Summarize Storybook tests":
                assert (
                    step["if"]
                    == "${{ always() && steps.browser-public-projection.outcome == 'success' }}"
                )
                assert "--report gui/web/playwright-public/stories.json" in command
    assert len(commands) == 4
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["deploy"]["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }


@pytest.mark.parametrize("workflow_name", ["test.yml", "storybook.yml"])
def test_job_environment_uses_only_documented_github_contexts(workflow_name):
    from github_yaml import load_github_yaml

    allowed = {"github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"}
    workflow = load_github_yaml(ROOT / ".github/workflows" / workflow_name)
    for job in workflow["jobs"].values():
        for value in job.get("env", {}).values():
            for expression in re.findall(r"\$\{\{(.*?)\}\}", str(value)):
                roots = set(re.findall(r"(?<![\w.])([A-Za-z_]\w*)\.", expression))
                assert roots <= allowed


@pytest.mark.parametrize(
    "workflow_name,job_id,expected",
    [
        (
            "test.yml",
            "frontend-e2e-suites",
            "${{ github.workspace }}/.browser-capture-${{ matrix.name }}.txt",
        ),
        ("storybook.yml", "build", "${{ github.workspace }}/.storybook-browser-capture.txt"),
    ],
)
def test_capture_receipt_has_one_absolute_path_for_all_working_directories(
    workflow_name, job_id, expected
):
    from github_yaml import load_github_yaml

    job = load_github_yaml(ROOT / ".github/workflows" / workflow_name)["jobs"][job_id]
    assert job["env"]["BROWSER_CAPTURE_RECEIPT"] == expected
    for step in job["steps"]:
        assert "BROWSER_CAPTURE_RECEIPT" not in step.get("env", {})
    initializer = next(
        s for s in job["steps"] if s.get("name") == "Initialize browser result publication"
    )
    assert '"$BROWSER_CAPTURE_RECEIPT"' in initializer["run"]
    projector = next(s for s in job["steps"] if s.get("id") == "browser-public-projection")
    assert '--capture-receipt "$BROWSER_CAPTURE_RECEIPT"' in projector["run"]


@pytest.mark.skipif(os.name == "nt", reason="CI capture requires Linux bash")
def test_workspace_receipt_connects_web_capture_and_root_projection(tmp_path):
    workspace = tmp_path / "workspace"
    web = workspace / "gui/web"
    web.mkdir(parents=True)
    runner = tmp_path / "runner"
    runner.mkdir()
    receipt = workspace / ".browser-capture-main-smoke.txt"
    env = {
        **os.environ,
        "RUNNER_TEMP": str(runner),
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
        "BROWSER_RAW_REPORT": "playwright-report/main-smoke.json",
        "BROWSER_CAPTURE_RECEIPT": str(receipt),
    }
    child_code = (
        "import sys; from pathlib import Path; "
        "p=Path('playwright-report/main-smoke.json'); p.parent.mkdir(); "
        "p.write_text(sys.argv[1])"
    )
    capture = subprocess.run(
        ["bash", str(CAPTURE), sys.executable, "-c", child_code, json.dumps(report())],
        cwd=web,
        env=env,
        capture_output=True,
        text=True,
    )
    assert capture.returncode == 0
    assert stat.S_IMODE(receipt.stat().st_mode) == 0o600
    projection = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--report",
            "gui/web/playwright-report/main-smoke.json",
            "--output",
            "gui/web/playwright-public/main-smoke.json",
            "--capture-receipt",
            str(receipt),
        ],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
    )
    assert projection.returncode == 0
    public = (web / "playwright-public/main-smoke.json").read_text()
    assert (
        MARKER
        not in public + capture.stdout + capture.stderr + projection.stdout + projection.stderr
    )
    assert json.loads(public)["suites"][0]["specs"][0]["tests"][0]["status"] == "flaky"
