from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = ROOT / ".github/workflows/test.yml"


def test_workflow_keeps_installs_checks_and_pinned_prebuilt_consumers() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    assert set(jobs) == {
        "pytest",
        "pytest-python-floor",
        "frontend",
        "frontend-e2e-suites",
        "frontend-e2e",
    }
    for name in ("pytest", "pytest-python-floor", "frontend-e2e-suites"):
        steps = jobs[name]["steps"]
        ffmpeg = next(
            step for step in steps if step.get("uses") == "./.github/actions/setup-ffmpeg"
        )
        assert "if" not in ffmpeg and not ffmpeg.get("continue-on-error")
        python = next(
            step for step in steps if step.get("uses", "").startswith("actions/setup-python@")
        )
        assert python["with"]["cache"] == "pip"
        assert python["with"]["cache-dependency-path"].splitlines() == ["pyproject.toml", "uv.lock"]
        install = next(step for step in steps if "pip install -e" in step.get("run", ""))
        assert "if" not in install and not install.get("continue-on-error")
        extras = {"pytest": "dev,gui,relay,prosody", "pytest-python-floor": "dev,gui"}.get(
            name, "gui"
        )
        assert (
            install["run"] == f'python -m pip install --upgrade pip\npip install -e ".[{extras}]"\n'
        )
    frontend_python = next(
        step
        for step in jobs["frontend"]["steps"]
        if step.get("uses", "").startswith("actions/setup-python@")
    )
    assert "cache" not in frontend_python["with"]
    pytest_steps = jobs["pytest"]["steps"]
    test = next(step for step in pytest_steps if "coverage report" in step.get("run", ""))
    assert "if" not in test and not test.get("continue-on-error")
    assert (
        test["run"]
        == 'pytest -n auto -m "not e2e_slow and not e2e_real"\ncoverage report --fail-under=95\n'
    )
    browser_steps = jobs["frontend-e2e-suites"]["steps"]
    browser = next(step for step in browser_steps if "playwright install" in step.get("run", ""))
    assert browser["run"] == "npm ci\nnpx playwright install --with-deps chromium webkit\n"
    assert "if" not in browser and not browser.get("continue-on-error")


def test_release_wheel_rebuilds_when_ffmpeg_contract_changes() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/release-wheel.yml")
    for event in ("pull_request", "push"):
        assert "contracts/ffmpeg-build.json" in workflow["on"][event]["paths"]


def test_windows_action_executes_standard_python_identity_check():
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    step = next(
        step
        for step in action["runs"]["steps"]
        if step["name"] == "Verify downstream standard CPython"
    )
    assert step["shell"] == "pwsh"
    assert "Path(sys.executable).resolve().is_relative_to" in step["run"]
    assert "pythonLocation" in step["run"]


def test_windows_native_payload_repeats_sidecar_verification():
    workflow = load_github_yaml(ROOT / ".github/workflows/desktop.yml")
    steps = workflow["jobs"]["ffmpeg-native-payload"]["steps"]
    step = next(
        step
        for step in steps
        if step.get("name") == "Repeat payload verification through the sidecar builder"
    )
    assert step["shell"] == "pwsh"
    assert 'sidecar["ensure_ffmpeg_payload"](runtime, "x86_64-pc-windows-msvc")' in step["run"]
    assert "for _ in range(2):" in step["run"]
    assert 'assert os.environ["PATH"] == original_path' in step["run"]
    assert "pythonLocation" in step["run"]


def test_every_native_consumer_uses_catalog_importer_without_compilation():
    consumers = {}
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        workflow = load_github_yaml(path)
        for name, job in workflow.get("jobs", {}).items():
            calls = [
                step
                for step in job.get("steps", [])
                if step.get("uses") == "./.github/actions/setup-ffmpeg"
            ]
            if calls:
                consumers.setdefault(path.name, []).append(name)
                for call in calls:
                    assert set(call.get("with", {})) <= {"output"}
        assert "ffmpeg-sources" not in workflow.get("jobs", {})
        assert "scripts/build_ffmpeg.py" not in path.read_text()
        assert "PODCAST_FFMPEG_TOOLCHAIN_PATH" not in path.read_text()
    assert consumers == {
        "desktop.yml": ["project-commit-lock-windows", "ffmpeg-native-payload"],
        "registry-backup-windows.yml": ["native-registry-backup"],
        "test.yml": ["pytest", "pytest-python-floor", "frontend-e2e-suites"],
        "release-desktop-build.yml": ["prepare-extension-runtime", "bundle"],
    }
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    steps = action["runs"]["steps"]
    acquire = steps[0]
    assert (
        acquire["run"]
        == 'python scripts/ffmpeg_payload.py --output "${PAYLOAD_OUTPUT:-$RUNNER_TEMP/sharecut-ffmpeg}" --github-env'
    )
    assert acquire["shell"] == "bash"
    assert len(steps) == 2
    assert not any(step.get("uses") for step in steps)


def test_linux_newer_host_verifies_transferred_payload_without_download():
    job = load_github_yaml(ROOT / ".github/workflows/desktop.yml")["jobs"][
        "ffmpeg-linux-newer-host"
    ]
    assert job["runs-on"] == "ubuntu-24.04"
    assert job["needs"] == "ffmpeg-native-payload"
    download = next(
        step
        for step in job["steps"]
        if step.get("uses", "").startswith("actions/download-artifact@")
    )
    assert download["with"]["name"] == "ffmpeg-native-ubuntu-22.04"
    proof = next(
        step
        for step in job["steps"]
        if step.get("name") == "Execute Ubuntu 22.04 payload on Ubuntu 24.04"
    )
    assert 'python scripts/ffmpeg_payload.py --output "$PAYLOAD" --verify-only' in proof["run"]
    assert all(step.get("uses") != "./.github/actions/setup-ffmpeg" for step in job["steps"])
