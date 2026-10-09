from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = ROOT / ".github/workflows/test.yml"


def test_workflow_keeps_installs_checks_and_only_one_ffmpeg_cache_writer() -> None:
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
