import hashlib
import json
import os
import subprocess
import sys
import venv
from pathlib import Path

import pytest

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
    bootstrap, cache, install = action["runs"]["steps"]
    assert bootstrap["shell"] == install["shell"] == "bash"
    assert "python -m pip install --upgrade pip uv" in bootstrap["run"]
    assert cache["uses"] == "actions/cache@v6"
    assert cache["with"] == {
        "path": "${{ steps.installer.outputs.cache-dir }}",
        "key": "uv-${{ runner.os }}-${{ runner.arch }}-py${{ steps.installer.outputs.python-version }}-uv${{ steps.installer.outputs.uv-version }}-${{ hashFiles('uv.lock', 'pyproject.toml') }}-${{ steps.installer.outputs.extras-key }}",
        "restore-keys": "uv-${{ runner.os }}-${{ runner.arch }}-py${{ steps.installer.outputs.python-version }}-uv${{ steps.installer.outputs.uv-version }}-${{ hashFiles('uv.lock', 'pyproject.toml') }}-",
    }
    assert bootstrap["env"] == {"EXTRAS": "${{ inputs.extras }}"}
    assert all(
        "if" not in step and not step.get("continue-on-error")
        for step in (bootstrap, cache, install)
    )
    assert install["env"] == {
        "EXTRAS": "${{ inputs.extras }}",
        "PYTHON_EXE": "${{ steps.installer.outputs.python-exe }}",
    }
    assert "uv export --locked --no-emit-project" in install["run"]
    assert 'uv pip install --python "$PYTHON_EXE" --compile-bytecode -r' in install["run"]
    assert "python -m pip install --no-deps -e ." in install["run"]


@pytest.fixture
def locked_recipe_environment(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    environment = tmp_path / "runner python"
    venv.EnvBuilder(with_pip=False).create(environment)
    scripts = environment / ("Scripts" if os.name == "nt" else "bin")
    python = scripts / ("python.exe" if os.name == "nt" else "python")
    controls = tmp_path / "controls"
    controls.mkdir()
    metadata = controls / "uv-1.2.3.dist-info"
    metadata.mkdir()
    (metadata / "METADATA").write_text("Name: uv\nVersion: 1.2.3\n", encoding="utf-8")
    (controls / "pip.py").write_text(
        "import json, os, sys\n"
        "with open(os.environ['RECIPE_LOG'], 'a') as log:\n"
        "    log.write(json.dumps({'tool': 'pip', 'args': sys.argv[1:], "
        "'python': sys.executable}) + '\\n')\n"
        "if os.environ.get('FAIL_AT') == 'bootstrap' and '--upgrade' in sys.argv:\n"
        "    sys.exit(71)\n",
        encoding="utf-8",
    )
    uv_control = controls / "uv.py"
    uv_control.write_text(
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "with open(os.environ['RECIPE_LOG'], 'a') as log:\n"
        "    log.write(json.dumps({'tool': 'uv', 'args': args}) + '\\n')\n"
        "if args == ['cache', 'dir']:\n"
        "    print(os.environ['CONTROL_CACHE_DIR'])\n"
        "elif args[0] == 'export':\n"
        "    if os.environ.get('FAIL_AT') == 'export':\n"
        "        sys.exit(72)\n"
        "    Path(args[args.index('-o') + 1]).write_text('controlled==1.0\\n')\n"
        "elif args[:2] == ['pip', 'install']:\n"
        "    assert Path(args[args.index('-r') + 1]).read_text() == 'controlled==1.0\\n'\n"
        "    if os.environ.get('FAIL_AT') == 'install':\n"
        "        sys.exit(73)\n",
        encoding="utf-8",
    )
    uv = scripts / "uv"
    uv.write_text('#!/usr/bin/env bash\nexec "$CONTROL_PYTHON" "$CONTROL_UV_SCRIPT" "$@"\n')
    uv.chmod(0o755)
    log = tmp_path / "commands.jsonl"
    output = tmp_path / "github-output"
    env = {
        **os.environ,
        "PATH": str(scripts) + os.pathsep + os.environ["PATH"],
        "VIRTUAL_ENV": str(environment),
        "PYTHONPATH": str(controls),
        "CONTROL_PYTHON": str(python),
        "CONTROL_UV_SCRIPT": str(uv_control),
        "CONTROL_CACHE_DIR": str(tmp_path / "package cache"),
        "RECIPE_LOG": str(log),
        "GITHUB_OUTPUT": str(output),
        "RUNNER_TEMP": str(tmp_path),
        "FAIL_AT": "",
    }
    return env, log, output


def _execute_locked_recipe(
    env: dict[str, str], output: Path, extras: str
) -> subprocess.CompletedProcess[str]:
    bootstrap, _, install = load_github_yaml(
        ROOT / ".github/actions/install-locked-python/action.yml"
    )["runs"]["steps"]
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", bootstrap["run"]],
        env={**env, "EXTRAS": extras},
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        return result
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", install["run"]],
        env={**env, "EXTRAS": extras, "PYTHON_EXE": values["python-exe"]},
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.parametrize(
    "extras", ["gui", "dev gui", "gui dev", "dev gui relay", "dev gui relay prosody"]
)
def test_locked_recipe_targets_the_caller_interpreter_and_every_extra(
    locked_recipe_environment: tuple[dict[str, str], Path, Path], extras: str
) -> None:
    env, log, output = locked_recipe_environment
    result = _execute_locked_recipe(env, output, extras)
    assert result.returncode == 0, result.stderr
    commands = [json.loads(line) for line in log.read_text().splitlines()]
    requirements = str(Path(env["RUNNER_TEMP"]) / "locked-requirements.txt")
    flags = [flag for extra in extras.split() for flag in ("--extra", extra)]
    assert commands == [
        {
            "tool": "pip",
            "args": ["install", "--upgrade", "pip", "uv"],
            "python": env["CONTROL_PYTHON"],
        },
        {"tool": "uv", "args": ["cache", "dir"]},
        {
            "tool": "uv",
            "args": [
                "export",
                "--locked",
                "--no-emit-project",
                "--no-hashes",
                *flags,
                "-o",
                requirements,
            ],
        },
        {
            "tool": "uv",
            "args": [
                "pip",
                "install",
                "--python",
                env["CONTROL_PYTHON"],
                "--compile-bytecode",
                "-r",
                requirements,
            ],
        },
        {
            "tool": "pip",
            "args": ["install", "--no-deps", "-e", "."],
            "python": env["CONTROL_PYTHON"],
        },
    ]
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert values == {
        "python-exe": env["CONTROL_PYTHON"],
        "python-version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "uv-version": "1.2.3",
        "extras-key": hashlib.sha256("\n".join(sorted(set(extras.split()))).encode()).hexdigest(),
        "cache-dir": env["CONTROL_CACHE_DIR"],
    }


def test_locked_recipe_cache_identity_distinguishes_complete_extras_sets(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
) -> None:
    env, _, output = locked_recipe_environment
    keys = []
    for extras in ("gui dev", "dev gui", "gui", "dev gui relay prosody"):
        output.unlink(missing_ok=True)
        result = _execute_locked_recipe(env, output, extras)
        assert result.returncode == 0, result.stderr
        values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        keys.append(values["extras-key"])
    assert keys[0] == keys[1]
    assert len({keys[0], keys[2], keys[3]}) == 3


@pytest.mark.parametrize(
    ("failure", "code", "commands"), [("bootstrap", 71, 1), ("export", 72, 3), ("install", 73, 4)]
)
def test_locked_recipe_stops_after_a_failed_bootstrap_export_or_install(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
    failure: str,
    code: int,
    commands: int,
) -> None:
    env, log, output = locked_recipe_environment
    result = _execute_locked_recipe({**env, "FAIL_AT": failure}, output, "gui dev")
    assert result.returncode == code, result.stderr
    assert len(log.read_text().splitlines()) == commands


def test_locked_recipe_retains_a_native_windows_cache_path(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
) -> None:
    env, _, output = locked_recipe_environment
    cache_dir = r"D:\a\package cache\uv"
    result = _execute_locked_recipe({**env, "CONTROL_CACHE_DIR": cache_dir}, output, "gui")
    assert result.returncode == 0, result.stderr
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert values["cache-dir"] == cache_dir
