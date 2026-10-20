from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = ROOT / ".github/workflows/test.yml"
LOCKED_INSTALL = "./.github/actions/install-locked-python"


def test_workflow_keeps_installs_checks_and_pinned_prebuilt_consumers() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    assert set(jobs) == {
        "changes",
        "pytest",
        "pytest-python-floor",
        "frontend",
        "frontend-suite",
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
        install = next(step for step in steps if step.get("uses") == LOCKED_INSTALL)
        assert "if" not in install and not install.get("continue-on-error")
        extras = {"pytest": "dev gui relay prosody", "pytest-python-floor": "dev gui"}.get(
            name, "gui"
        )
        assert install["with"] == {"extras": extras}
    frontend_python = next(
        step
        for step in jobs["frontend-suite"]["steps"]
        if step.get("uses", "").startswith("actions/setup-python@")
    )
    assert "cache" not in frontend_python["with"]
    pytest_steps = jobs["pytest"]["steps"]
    test = next(step for step in pytest_steps if step.get("name") == "Run tests with coverage gate")
    assert test["if"] == "steps.plan.outputs.pytest == 'full'"
    assert not test.get("continue-on-error")
    assert (
        test["run"]
        == 'set -o pipefail\npytest -n auto -m "not e2e_slow and not e2e_real" --durations=100 --durations-min=0.1 --junitxml=test-results/pytest.xml | tee test-results/pytest.log\ncoverage report --fail-under=95\n'
    )
    reports = next(step for step in pytest_steps if step.get("name") == "Upload pytest reports")
    assert reports["if"] == "always()"
    assert reports["uses"] == "actions/upload-artifact@v7"
    assert reports["with"] == {
        "name": "pytest-reports",
        "path": "test-results/",
        "retention-days": 7,
    }
    browser_steps = jobs["frontend-e2e-suites"]["steps"]
    browser = next(step for step in browser_steps if "playwright install" in step.get("run", ""))
    assert browser["run"] == "npm ci\nnpx playwright install --with-deps ${{ matrix.browser }}\n"
    assert "if" not in browser and not browser.get("continue-on-error")
    matrix = jobs["frontend-e2e-suites"]["strategy"]["matrix"]
    assert matrix == "${{ fromJSON(needs.changes.outputs.e2e-matrix) }}"


def test_release_wheel_rebuilds_when_a_contract_changes() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/release-wheel.yml")
    for event in ("pull_request", "push"):
        assert "contracts/**" in workflow["on"][event]["paths"]


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
    assert job["needs"] == ["changes", "ffmpeg-native-payload"]
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


def test_python_jobs_install_the_versions_uv_lock_pins() -> None:
    """A new upstream release must not change what a required check tests (#1384)."""
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        for name, job in load_github_yaml(path).get("jobs", {}).items():
            for step in job.get("steps", []):
                run = step.get("run", "")
                assert "pip install -e" not in run, f"{path.name}:{name} installs unlocked"
    action = load_github_yaml(ROOT / ".github/actions/install-locked-python/action.yml")
    (step,) = action["runs"]["steps"]
    assert step["shell"] == "bash"
    assert "uv export --locked --no-emit-project" in step["run"]
    assert "pip install -r" in step["run"]
    assert "pip install --no-deps -e ." in step["run"]
