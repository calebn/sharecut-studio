import importlib.util
import json
import os
import re
import shlex
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


def test_all_fixed_npm_matrix_commands_preserve_argv_and_failure_inside_capture(tmp_path):
    from script_loader import load_script

    plan = load_script("ci_plan", register=True)
    commands = [
        job.command
        for job in [*plan.main_shards(), plan.smoke_job(), *plan.full_compat(), *plan.pr_compat()]
    ]
    binary = tmp_path / "bin"
    binary.mkdir()
    fake_npm = binary / "npm"
    fake_npm.write_text(
        f"#!{sys.executable}\n"
        "import json,os,sys\n"
        "with open(os.environ['ARGV_RECEIPT'], 'w') as stream: json.dump(sys.argv[1:],stream)\n"
        "sys.exit(7)\n"
    )
    fake_npm.chmod(0o700)
    receipt = tmp_path / "argv.json"
    env = {
        **os.environ,
        "PATH": f"{binary}{os.pathsep}{os.environ['PATH']}",
        "RUNNER_TEMP": str(tmp_path),
        "ARGV_RECEIPT": str(receipt),
    }
    env.pop("BROWSER_RAW_REPORT", None)
    for command in commands:
        assert re.fullmatch(r"[A-Za-z0-9_./:= -]+", command)
        args = shlex.split(command)
        assert args[:2] == ["npm", "run"]
        result = subprocess.run(
            [
                "bash",
                "--noprofile",
                "--norc",
                "-eo",
                "pipefail",
                "-c",
                f"bash {shlex.quote(str(CAPTURE))} {command}",
            ],
            env=env,
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 7
        assert json.loads(receipt.read_text()) == args[1:]
        assert result.stderr == ""


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


@pytest.mark.parametrize("runner_summary_set", [False, True])
def test_projection_is_compatible_with_existing_safe_summary(
    tmp_path, monkeypatch, runner_summary_set
):
    runner_summary = tmp_path / "runner-summary.md"
    runner_summary.write_text("Existing runner summary.\n", encoding="utf-8")
    if runner_summary_set:
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(runner_summary))
    else:
        monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    receipt = capture_receipt(tmp_path, monkeypatch)
    source = tmp_path / "raw.json"
    source.write_text(json.dumps(report()))
    output = tmp_path / "public.json"
    public_report.write_projection(source, output, receipt)
    summary = tmp_path / "summary.md"
    child = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/test_area_summary.py"),
            "playwright",
            "--area",
            "main-e2e",
            "--report",
            str(output),
            "--output",
            str(summary),
        ],
        capture_output=True,
        text=True,
    )
    assert child.returncode == 0
    content = summary.read_text(encoding="utf-8")
    assert content == (
        "### Test area summary\n\n"
        "| Area | Logical tests | Final statuses | Summed test duration |\n"
        "| --- | ---: | --- | --- |\n"
        "| Main e2e | 1 | flaky: 1 | summed Playwright attempt durations: 0.0 s |\n\n"
        "Global browser errors: 1.\n\n"
        "Summed test and retry durations can overlap when tests run in parallel. "
        "They are not job wall time. Missing report data is shown as unavailable.\n"
    )
    assert child.stdout == child.stderr == ""
    assert runner_summary.read_text(encoding="utf-8") == "Existing runner summary.\n"
    assert MARKER not in content + child.stdout + child.stderr
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


def phase_marker(phase, duration=5):
    return {"title": f"3940:{phase}", "duration": duration}


def phase_report():
    value = report()
    value["errors"] = []
    root = value["suites"][0]
    root["file"] = "root-pin.spec.ts"
    suite = root["suites"][0]
    suite["title"] = "real palette reconnect"
    suite["specs"][0]["title"] = "real reconnect keeps palette actions current while open"
    test = logical_test(value)
    test.update(projectName="", status="expected")
    test["results"] = [
        {
            "status": "passed",
            "retry": 0,
            "duration": 30,
            "errors": [],
            "stdout": [{"text": MARKER}],
            "attachments": [{"path": MARKER}],
            "steps": [phase_marker(n) for n in range(61, 67)],
        }
    ]
    return value


def reported_failure(value, phase, state):
    test = logical_test(value)
    test["status"] = "unexpected"
    attempt = test["results"][0]
    attempt.update(
        status="timedOut" if state == 3 else "failed",
        error={"message": MARKER},
        errors=[{"message": MARKER}],
    )
    steps = attempt["steps"]
    del steps[phase - 60 :]
    if state == 3:
        steps[-1]["duration"] = -1
    else:
        steps[-1]["error"] = {"message": MARKER}
    return steps


@pytest.mark.parametrize("phase", range(61, 67))
@pytest.mark.parametrize("state", [2, 3])
def test_palette_phase_projection_reports_each_throwing_or_unfinished_position(phase, state):
    value = phase_report()
    reported_failure(value, phase, state)
    assert public_report.palette_phase(value) == {"diagnostic_code": phase * 10 + state}


def test_palette_phase_reports_full_completion_only_for_passing_attempt():
    assert public_report.palette_phase(phase_report()) == {"diagnostic_code": 661}


@pytest.mark.parametrize(
    "problem",
    [
        "global-error",
        "wrong-case",
        "duplicate-case",
        "wrong-project",
        "duplicate-project",
        "missing-attempt",
        "retry",
        "extra-attempt",
        "bad-status",
        "interrupted",
        "unmarked-failure",
        "missing-marker",
        "unordered",
        "duplicate-marker",
        "extra-marker",
        "wrong-nesting",
        "subtitle",
        "bad-error",
        "bad-duration",
        "unfinished-pass",
        "unfinished-failure",
        "later-marker",
        "no-markers",
        "unknown-marker",
    ],
)
def test_palette_phase_refuses_incomplete_or_ambiguous_evidence(problem):
    value = phase_report()
    root = value["suites"][0]
    suite = root["suites"][0]
    case = suite["specs"][0]
    test = logical_test(value)
    attempt = test["results"][0]
    steps = attempt["steps"]
    match problem:
        case "global-error":
            value["errors"] = [{"message": MARKER}]
        case "wrong-case":
            root["file"] = MARKER
        case "duplicate-case":
            suite["specs"].append(case)
        case "wrong-project":
            test["projectName"] = MARKER
        case "duplicate-project":
            case["tests"].append(test)
        case "missing-attempt":
            test["results"].clear()
        case "retry":
            attempt["retry"] = 1
        case "extra-attempt":
            test["results"].append(attempt)
        case "bad-status" | "interrupted":
            attempt["status"] = MARKER if problem == "bad-status" else "interrupted"
        case "unmarked-failure":
            test["status"] = "unexpected"
            attempt.update(status="failed", error={"message": MARKER}, errors=[{"message": MARKER}])
        case "missing-marker":
            steps.pop()
        case "unordered":
            steps[0], steps[1] = steps[1], steps[0]
        case "duplicate-marker":
            steps[1] = steps[0]
        case "extra-marker":
            steps.append(phase_marker(67))
        case "wrong-nesting":
            steps[0]["steps"] = [phase_marker(62)]
        case "subtitle":
            steps[0]["subtitle"] = MARKER
        case "bad-error":
            reported_failure(value, 62, 2)
            steps[-1]["error"] = MARKER
        case "bad-duration":
            steps[0]["duration"] = -2
        case "unfinished-pass":
            steps[-1]["duration"] = -1
        case "unfinished-failure":
            reported_failure(value, 62, 3)
            attempt["status"] = "failed"
        case "later-marker":
            reported_failure(value, 62, 2)
            steps.append(phase_marker(63))
        case "no-markers":
            del attempt["steps"]
        case "unknown-marker":
            steps[-1]["title"] = MARKER
    with pytest.raises(public_report.InvalidReport):
        public_report.palette_phase(value)


@pytest.mark.parametrize(
    "problem",
    [
        None,
        "malformed",
        "stale",
        "wrong-receipt",
        "missing",
        "duplicate-errors",
        "duplicate-steps",
        "NaN",
        "Infinity",
        "-Infinity",
        "missing-attempt-error",
        "missing-attempt-errors",
        "empty-attempt-errors",
        "malformed-attempt-error",
        "malformed-attempt-errors",
        "timeout-without-error",
        "empty-marker-error",
        "unrecognized-marker-error",
    ],
)
def test_palette_phase_cli_exports_only_numeric_output_and_keeps_default_bytes(
    tmp_path, monkeypatch, problem
):
    receipt = capture_receipt(tmp_path, monkeypatch)
    source = tmp_path / "private.json"
    value = phase_report()
    reported_failure(value, 65, 2)
    source.write_text(json.dumps(value))
    output = tmp_path / "phase.json"
    output.write_text(MARKER)
    channel = tmp_path / "github-output"
    summary = tmp_path / "github-summary"
    summary.write_text("Existing runner summary.\n")
    monkeypatch.setenv("GITHUB_OUTPUT", str(channel))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    common = [
        sys.executable,
        str(SCRIPT),
        "--report",
        str(source),
        "--capture-receipt",
        str(receipt),
    ]
    if problem == "malformed":
        source.write_text(MARKER)
    elif problem == "stale":
        os.utime(source, ns=(1, 1))
    elif problem == "wrong-receipt":
        receipt.write_text("123 1\n")
    elif problem == "missing":
        source.unlink()
    elif problem == "duplicate-errors":
        source.write_text('{"errors": [{"message": "' + MARKER + '"}], ' + source.read_text()[1:])
    elif problem == "duplicate-steps":
        source.write_text(source.read_text().replace('"steps":', '"steps": [], "steps":', 1))
    elif problem in ("NaN", "Infinity", "-Infinity"):
        source.write_text('{"ignored": {"invalid": ' + problem + "}, " + source.read_text()[1:])
    elif problem is not None:
        attempt = logical_test(value)["results"][0]
        match problem:
            case "missing-attempt-error":
                del attempt["error"]
            case "missing-attempt-errors":
                del attempt["errors"]
            case "empty-attempt-errors":
                attempt["errors"] = []
            case "malformed-attempt-error":
                attempt["error"] = {"message": [MARKER]}
            case "malformed-attempt-errors":
                attempt["errors"] = [{"message": MARKER}, {"message": [MARKER]}]
            case "timeout-without-error":
                attempt.update(status="timedOut", errors=[])
                del attempt["error"]
            case "empty-marker-error":
                attempt["steps"][-1]["error"] = {}
            case "unrecognized-marker-error":
                attempt["steps"][-1]["error"] = {"irrelevant": MARKER}
        source.write_text(json.dumps(value))

    child = subprocess.run(
        [*common, "--output", str(output), "--palette-phase"], capture_output=True, text=True
    )
    assert child.returncode == 0
    assert child.stdout == child.stderr == ""
    assert summary.read_text() == "Existing runner summary.\n"
    if problem is not None:
        assert channel.read_bytes() == b"diagnostic_code=0\n"
        assert not output.exists()
        if problem not in ("duplicate-errors", "duplicate-steps", "NaN", "Infinity", "-Infinity"):
            return
    else:
        assert channel.read_bytes() == b"diagnostic_code=652\n"
        assert output.read_bytes() == b'{\n  "diagnostic_code": 652\n}\n'
        assert stat.S_IMODE(output.stat().st_mode) == 0o600

    saved_channel = channel.read_bytes()
    public = tmp_path / "public.json"
    default = subprocess.run([*common, "--output", str(public)], capture_output=True, text=True)
    assert default.returncode == 0
    before = phase_report()
    reported_failure(before, 65, 2)
    del logical_test(before)["results"][0]["steps"]
    assert public.read_text() == json.dumps(public_report.project(before), indent=2) + "\n"
    assert MARKER not in public.read_text() + default.stdout + default.stderr
    assert channel.read_bytes() == saved_channel
    assert summary.read_text() == "Existing runner summary.\n"


def test_palette_phase_scope_keeps_browser_failure_and_upload_authoritative():
    from github_yaml import load_github_yaml

    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    job = workflow["jobs"]["frontend-e2e-suites"]
    steps = job["steps"]
    browser = next(s for s in steps if s.get("name") == "Playwright ${{ matrix.name }}")
    assert browser["run"] == "bash ../../scripts/private_browser_command.sh ${{ matrix.command }}"
    assert not browser.get("continue-on-error")
    projected = next(i for i, s in enumerate(steps) if s.get("id") == "browser-public-projection")
    producer, consumer = steps[projected + 1 : projected + 3]
    assert producer["id"] == "palette-phase"
    assert producer["continue-on-error"] is True
    assert producer["if"] == consumer["if"]
    assert " ".join(producer["if"].split()) == (
        "${{ !cancelled() && steps.browser-public-projection.outcome == 'success' "
        "&& github.event_name == 'pull_request' && github.base_ref == 'develop' "
        "&& github.event.pull_request.number == 3940 "
        "&& github.event.pull_request.head.repo.full_name == github.repository "
        "&& github.head_ref == 'fix/palette-live-context-3608' "
        "&& github.event.pull_request.draft == false && matrix.name == 'main-smoke' }}"
    )
    assert " ".join(consumer["name"].split()) == (
        "Palette smoke code ${{ steps.palette-phase.outcome == 'success' "
        "&& steps.palette-phase.outputs.diagnostic_code || '0' }}"
    )
    assert consumer["run"] == "true"
    assert '--output "${TMPDIR:?}/palette-phase.json"' in producer["run"]
    assert producer["run"].startswith("python3 scripts/browser_public_report.py --palette-phase ")
    assert '--capture-receipt "$BROWSER_CAPTURE_RECEIPT"' in producer["run"]
    uploads = [s["with"]["path"] for s in steps if "upload-artifact" in s.get("uses", "")]
    assert uploads == ["gui/web/playwright-public/${{ matrix.name }}.json"]
    aggregate = workflow["jobs"]["frontend-e2e"]["steps"][0]
    script = aggregate["run"]
    outcome = subprocess.run(
        ["bash", "-c", script],
        env={**os.environ, "PLAN": "success", "GUI": "true", "SUITES": "failure"},
        capture_output=True,
    )
    assert outcome.returncode == 1


@pytest.mark.parametrize(
    "outcome,code,expected",
    [
        ("success", "652", "652"),
        ("success", "0", "0"),
        ("success", "", "0"),
        ("failure", "652", "0"),
        ("skipped", "", "0"),
    ],
)
def test_palette_metadata_requires_successful_producer(outcome, code, expected):
    from github_yaml import load_github_yaml

    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    name = next(
        step["name"]
        for step in workflow["jobs"]["frontend-e2e-suites"]["steps"]
        if step.get("name", "").startswith("Palette smoke code ")
    )
    expression = re.fullmatch(r"Palette smoke code \$\{\{(.*?)\}\}", name, flags=re.S)
    assert expression
    positive, fallback = re.split(r"\s+\|\|\s+", expression[1].strip())
    assert fallback == "'0'"
    values = {
        "steps.palette-phase.outcome == 'success'": outcome == "success",
        "steps.palette-phase.outputs.diagnostic_code": code,
    }
    predicates = [values[part] for part in re.split(r"\s+&&\s+", positive)]
    assert (str(predicates[-1]) if all(predicates) else "0") == expected
