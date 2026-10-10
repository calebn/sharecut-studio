from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = ROOT / ".github/workflows/test.yml"


def test_workflow_keeps_installs_checks_and_only_one_ffmpeg_cache_writer() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    assert set(jobs) == {
        "ffmpeg-sources",
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


def test_source_cache_never_stores_binaries():
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    for step in action["runs"]["steps"]:
        if step.get("uses", "").startswith("actions/cache/"):
            assert step["with"]["path"] == "${{ runner.temp }}/ffmpeg-sources"
            assert "restore-keys" not in step["with"]


def test_native_action_exports_absolute_paths_before_cwd_changes():
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    windows = next(
        step for step in action["runs"]["steps"] if step["name"] == "Build native Windows payload"
    )
    unix = next(
        step for step in action["runs"]["steps"] if step["name"] == "Build native Unix payload"
    )
    assert 'output="$(cygpath -am ' in windows["run"]
    assert "pathlib.Path(sys.argv[1]).absolute()" in unix["run"]
    for step in (windows, unix):
        assert step["run"].index("output=") < step["run"].index("--output")
        assert "PODCAST_MCP_FFMPEG=" in step["run"]


def test_windows_toolchain_cannot_shadow_downstream_cpython():
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    windows = next(
        step for step in action["runs"]["steps"] if step["name"] == "Build native Windows payload"
    )
    assert "PODCAST_FFMPEG_TOOLCHAIN_PATH=" in windows["run"]
    exported_paths = [line for line in windows["run"].splitlines() if '>> "$GITHUB_PATH"' in line]
    assert exported_paths == ['echo "$(cygpath -w "$output/bin")" >> "$GITHUB_PATH"']


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


def test_every_native_consumer_requires_same_run_original_sources():
    consumers = {}
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        workflow = load_github_yaml(path)
        for name, job in workflow.get("jobs", {}).items():
            calls = [
                s for s in job.get("steps", []) if s.get("uses") == "./.github/actions/setup-ffmpeg"
            ]
            if not calls:
                continue
            consumers.setdefault(path.name, []).append(name)
            producer = workflow["jobs"]["ffmpeg-sources"]
            assert producer["uses"] == "./.github/workflows/ffmpeg-sources.yml"
            assert "ffmpeg-sources" in job["needs"]
            for call in calls:
                assert (
                    call["with"]["source-artifact"]
                    == "${{ needs.ffmpeg-sources.outputs.artifact-name }}"
                )
    assert consumers == {
        "desktop.yml": ["project-commit-lock-windows", "ffmpeg-native-payload"],
        "registry-backup-windows.yml": ["native-registry-backup"],
        "test.yml": ["pytest", "pytest-python-floor", "frontend-e2e-suites"],
        "release-desktop-build.yml": ["prepare-extension-runtime", "bundle"],
    }
    test = load_github_yaml(WORKFLOW)["jobs"]
    desktop = load_github_yaml(ROOT / ".github/workflows/desktop.yml")["jobs"]
    assert "needs" not in test["frontend"]
    assert "needs" not in desktop["ffmpeg-resolver-windows"]


def test_source_producer_has_exact_coordinates_and_no_signing_secrets():
    workflow = load_github_yaml(ROOT / ".github/workflows/ffmpeg-sources.yml")
    assert set(workflow["on"]["workflow_call"]["secrets"]) == {"SOURCE_REPOSITORY_SSH_KEY"}
    job = workflow["jobs"]["acquire"]
    checkout = job["steps"][0]
    assert checkout["with"]["repository"] == "${{ inputs.source-repository }}"
    assert checkout["with"]["ref"] == "${{ inputs.source-sha }}"
    assert checkout["with"]["persist-credentials"] is False
    assert job["permissions"] == {"contents": "read"}
    run = next(s["run"] for s in job["steps"] if s.get("name") == "Acquire original pinned sources")
    assert "--acquire-sources --source-cache" in run
    upload = next(
        s for s in job["steps"] if s.get("uses", "").startswith("actions/upload-artifact@")
    )
    assert upload["with"]["if-no-files-found"] == "error"
    assert upload["with"]["retention-days"] == 1
    release = load_github_yaml(ROOT / ".github/workflows/release-desktop-build.yml")["jobs"]
    producer = release["ffmpeg-sources"]
    assert producer["needs"] == "verify-source"
    assert (
        producer["with"]["source-repository"]
        == "${{ needs.verify-source.outputs.source_repository }}"
    )
    assert producer["with"]["source-sha"] == "${{ needs.verify-source.outputs.source_sha }}"
    assert set(producer["secrets"]) == {"SOURCE_REPOSITORY_SSH_KEY"}
    assert "needs.ffmpeg-sources.result == 'success'" in release["bundle"]["if"]
    assert "inputs.extension_artifact_name == ''" in release["bundle"]["if"]


def test_native_action_consumes_artifact_without_cache_fallback():
    action = load_github_yaml(ROOT / ".github/actions/setup-ffmpeg/action.yml")
    assert action["inputs"]["source-artifact"]["required"] is True
    steps = action["runs"]["steps"]
    download = next(s for s in steps if s.get("uses", "").startswith("actions/download-artifact@"))
    assert download["with"] == {
        "name": "${{ inputs.source-artifact }}",
        "path": "${{ runner.temp }}/ffmpeg-sources",
    }
    assert all(not s.get("uses", "").startswith("actions/cache/") for s in steps)
    for name in ("Build native Windows payload", "Build native Unix payload"):
        run = next(s["run"] for s in steps if s.get("name") == name)
        assert "--source-archives" in run
        assert "--source-cache" not in run
        assert "PODCAST_FFMPEG_SOURCE_ARCHIVES=" in run
