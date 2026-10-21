import hashlib
import json
import os
import shutil
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
    frontend_steps = jobs["frontend-suite"]["steps"]
    frontend_install = next(step for step in frontend_steps if step.get("uses") == LOCKED_INSTALL)
    assert frontend_install["with"] == {"environment": "frontend-exporters"}
    assert "if" not in frontend_install and not frontend_install.get("continue-on-error")
    assert (
        sum(
            step.get("uses") == LOCKED_INSTALL and "environment" in step.get("with", {})
            for job in jobs.values()
            for step in job.get("steps", [])
        )
        == 1
    )
    exporters = next(
        step for step in frontend_steps if "export_project_types.py" in step.get("run", "")
    )
    assert exporters["run"].splitlines() == [
        "python3 scripts/export_capabilities_copy.py --check",
        "python3 scripts/export_timeline_zoom.py --check",
        "python3 scripts/export_limit_contracts.py --check",
        "python3 scripts/export_project_types.py --check",
    ]
    assert next(
        i for i, step in enumerate(frontend_steps) if step.get("run") == "npm ci"
    ) < frontend_steps.index(exporters)
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
    assert browser["run"].splitlines() == [
        "printf 'TMPDIR: %s\\n' \"$TMPDIR\"",
        'df -hT /tmp "$TMPDIR"',
        "python - <<'PY'",
        "import os",
        "from pathlib import Path",
        "",
        "from podcast_mcp.util.registry_privacy import registry_privacy",
        "",
        'with registry_privacy(Path(os.environ["TMPDIR"]), (), create=False) as verify:',
        "    verify()",
        "PY",
        "npm ci",
        "npx playwright install --with-deps ${{ matrix.browser }}",
    ]
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
    assert action["inputs"]["environment"]["default"] == "project"
    assert action["inputs"]["extras"]["default"] == ""
    assert bootstrap["env"] == {
        "EXTRAS": "${{ inputs.extras }}",
        "ENVIRONMENT": "${{ inputs.environment }}",
    }
    assert all(
        "if" not in step and not step.get("continue-on-error")
        for step in (bootstrap, cache, install)
    )
    assert install["env"] == {
        "EXTRAS": "${{ inputs.extras }}",
        "ENVIRONMENT": "${{ inputs.environment }}",
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
        "    if os.environ.get('FAIL_AT') in ('export', 'stale-lock'):\n"
        "        sys.exit(72)\n"
        "    Path(args[args.index('-o') + 1]).write_text('controlled==1.0\\n')\n"
        "elif args[:2] == ['pip', 'install']:\n"
        "    assert Path(args[args.index('-r') + 1]).read_text() == 'controlled==1.0\\n'\n"
        "    if os.environ.get('FAIL_AT') == 'install':\n"
        "        sys.exit(73)\n"
        "elif args[:2] == ['pip', 'check']:\n"
        "    if os.environ.get('FAIL_AT') == 'check':\n"
        "        sys.exit(74)\n",
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
    env: dict[str, str], output: Path, extras: str, environment: str | None = None
) -> subprocess.CompletedProcess[str]:
    action = load_github_yaml(ROOT / ".github/actions/install-locked-python/action.yml")
    bootstrap, _, install = action["runs"]["steps"]
    env = {
        **env,
        "ENVIRONMENT": action["inputs"]["environment"]["default"]
        if environment is None
        else environment,
    }
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


@pytest.mark.parametrize("extras", ["", " \t\n"])
def test_locked_exporter_recipe_selects_only_the_group_and_checks_the_captured_interpreter(
    locked_recipe_environment: tuple[dict[str, str], Path, Path], extras: str
) -> None:
    env, log, output = locked_recipe_environment
    result = _execute_locked_recipe(env, output, extras, "frontend-exporters")
    assert result.returncode == 0, result.stderr
    commands = [json.loads(line) for line in log.read_text().splitlines()]
    requirements = str(Path(env["RUNNER_TEMP"]) / "locked-requirements.txt")
    assert commands[2:] == [
        {
            "tool": "uv",
            "args": [
                "export",
                "--locked",
                "--only-group",
                "frontend-exporters",
                "--no-hashes",
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
        {"tool": "uv", "args": ["pip", "check", "--python", env["CONTROL_PYTHON"]]},
    ]
    exporter_key = dict(line.split("=", 1) for line in output.read_text().splitlines())[
        "extras-key"
    ]
    output.unlink()
    assert _execute_locked_recipe(env, output, "frontend-exporters").returncode == 0
    project_key = dict(line.split("=", 1) for line in output.read_text().splitlines())["extras-key"]
    assert exporter_key != project_key
    assert exporter_key == hashlib.sha256(b"\0frontend-exporters").hexdigest()


@pytest.mark.parametrize(
    ("environment", "extras", "message"),
    [
        ("unknown", "", "Unknown Python environment"),
        ("", "gui", "Unknown Python environment"),
        ("frontend-exporters", "gui", "does not accept extras"),
        ("frontend-exporters", " dev\n gui ", "does not accept extras"),
    ],
)
def test_locked_recipe_rejects_invalid_selection_before_bootstrap(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
    environment: str,
    extras: str,
    message: str,
) -> None:
    env, log, output = locked_recipe_environment
    result = _execute_locked_recipe(env, output, extras, environment)
    assert result.returncode != 0
    assert message in result.stderr
    assert not log.exists()
    assert not output.exists()


@pytest.mark.parametrize("environment", ["project", "frontend-exporters"])
@pytest.mark.parametrize(
    ("failure", "code", "commands"),
    [("stale-lock", 72, 3), ("export", 72, 3), ("install", 73, 4)],
)
def test_locked_recipe_failure_stops_with_warm_package_content_and_old_requirements(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
    environment: str,
    failure: str,
    code: int,
    commands: int,
) -> None:
    env, log, output = locked_recipe_environment
    extras = "gui" if environment == "project" else ""
    assert _execute_locked_recipe(env, output, extras, environment).returncode == 0
    Path(env["CONTROL_CACHE_DIR"]).mkdir()
    log.write_text("")
    output.unlink()
    result = _execute_locked_recipe({**env, "FAIL_AT": failure}, output, extras, environment)
    assert result.returncode == code, result.stderr
    assert len(log.read_text().splitlines()) == commands


def test_locked_exporter_recipe_stops_on_dependency_check_failure(
    locked_recipe_environment: tuple[dict[str, str], Path, Path],
) -> None:
    env, log, output = locked_recipe_environment
    result = _execute_locked_recipe({**env, "FAIL_AT": "check"}, output, "", "frontend-exporters")
    assert result.returncode == 74, result.stderr
    commands = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(commands) == 5
    assert commands[-1]["args"] == ["pip", "check", "--python", env["CONTROL_PYTHON"]]
    assert not any(command["tool"] == "pip" and "-e" in command["args"] for command in commands)


@pytest.mark.parametrize(
    ("workflow", "job_name"),
    [("test.yml", "pytest"), ("test.yml", "frontend-e2e-suites"), ("extras-import.yml", "extras")],
)
def test_ci_jobs_use_runner_owned_temporary_storage(
    workflow: str, job_name: str, tmp_path: Path
) -> None:
    job = load_github_yaml(ROOT / ".github/workflows" / workflow)["jobs"][job_name]
    step = job["steps"][0]
    assert step["name"] == "Use runner temporary storage"
    assert not job.get("env", {}).get("TMPDIR")
    assert not any("TMPDIR" in step.get("env", {}) for step in job["steps"])
    assert "if" not in step and not step.get("continue-on-error")
    runner_temp = tmp_path / "runner temp"
    runner_temp.mkdir()
    controls = tmp_path / "controls"
    controls.mkdir()
    mktemp = controls / "mktemp"
    mktemp.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'printf "%s\\n" "$@" > "$MKTEMP_LOG"\n'
        'test "$#" -eq 2\n'
        'test "$1" = "-d"\n'
        'test "$2" = "/var/tmp/sharecut-ci.XXXXXX"\n'
        'exec "$REAL_MKTEMP" -d "$PRIVATE_TEMP_PARENT/sharecut-ci.XXXXXX"\n'
    )
    mktemp.chmod(0o755)
    real_mktemp = shutil.which("mktemp")
    assert real_mktemp is not None
    mktemp_log = tmp_path / "mktemp-args"
    github_env = tmp_path / "github-env"
    subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step["run"]],
        env={
            **os.environ,
            "PATH": str(controls) + os.pathsep + os.environ["PATH"],
            "RUNNER_TEMP": str(runner_temp),
            "GITHUB_ENV": str(github_env),
            "MKTEMP_LOG": str(mktemp_log),
            "REAL_MKTEMP": real_mktemp,
            "PRIVATE_TEMP_PARENT": str(runner_temp),
        },
        check=True,
        capture_output=True,
        text=True,
    )
    exported = dict(line.split("=", 1) for line in github_env.read_text().splitlines())
    assert mktemp_log.read_text().splitlines() == ["-d", "/var/tmp/sharecut-ci.XXXXXX"]
    assert set(exported) == {"TMPDIR"}
    private_temp = Path(exported["TMPDIR"])
    assert private_temp.parent == runner_temp
    assert private_temp.name.startswith("sharecut-ci.")
    assert private_temp.stat().st_mode & 0o777 == 0o700
    assert private_temp.stat().st_uid == os.geteuid()
    env = {**os.environ, **exported}
    python = subprocess.run(
        [sys.executable, "-c", "import tempfile; print(tempfile.gettempdir())"],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    node = subprocess.run(
        ["node", "-e", "console.log(require('node:os').tmpdir())"],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    assert Path(python.stdout.strip()).resolve() == private_temp.resolve()
    assert Path(node.stdout.strip()).resolve() == private_temp.resolve()


def test_only_the_three_quota_affected_jobs_select_runner_temporary_storage() -> None:
    selected = {
        (workflow, name)
        for workflow in ("test.yml", "extras-import.yml")
        for name, job in load_github_yaml(ROOT / ".github/workflows" / workflow)["jobs"].items()
        if any(step.get("name") == "Use runner temporary storage" for step in job["steps"])
    }
    assert selected == {
        ("test.yml", "pytest"),
        ("test.yml", "frontend-e2e-suites"),
        ("extras-import.yml", "extras"),
    }


@pytest.mark.parametrize(
    ("workflow", "job_name", "step_name"),
    [
        ("test.yml", "pytest", "Record pytest run context"),
        ("test.yml", "frontend-e2e-suites", "Install frontend deps and browser engines"),
        ("extras-import.yml", "extras", "Import each extra in a clean venv"),
    ],
)
def test_quota_affected_jobs_record_temporary_paths_and_filesystem_capacity(
    workflow: str, job_name: str, step_name: str
) -> None:
    job = load_github_yaml(ROOT / ".github/workflows" / workflow)["jobs"][job_name]
    step = next(step for step in job["steps"] if step.get("name") == step_name)
    assert "printf 'TMPDIR: %s\\n' \"$TMPDIR\"" in step["run"]
    assert 'df -hT /tmp "$TMPDIR"' in step["run"]
    assert "if" not in step and not step.get("continue-on-error")


@pytest.mark.parametrize(
    ("workflow", "job_name", "step_name"),
    [
        ("test.yml", "pytest", "Record pytest run context"),
        ("test.yml", "frontend-e2e-suites", "Install frontend deps and browser engines"),
        ("extras-import.yml", "extras", "Import each extra in a clean venv"),
    ],
)
def test_ci_temporary_storage_preflight_validates_without_changing_permissions(
    workflow: str, job_name: str, step_name: str, tmp_path: Path
) -> None:
    job = load_github_yaml(ROOT / ".github/workflows" / workflow)["jobs"][job_name]
    step = next(step for step in job["steps"] if step.get("name") == step_name)
    code = step["run"].split("<<'PY'\n", 1)[1].split("\nPY", 1)[0]
    assert 'with registry_privacy(Path(os.environ["TMPDIR"]), (), create=False) as verify:' in code
    command = "uv run --no-sync python" if job_name == "extras" else "python"
    start = step["run"].index(command + " - <<'PY'")
    end = step["run"].index("\nPY", start) + len("\nPY")
    preflight = step["run"][start:end]
    if job_name == "pytest":
        workload = next(s for s in job["steps"] if s.get("name") == "Run tests with coverage gate")
        assert job["steps"].index(step) < job["steps"].index(workload)
    else:
        workload_command = "uv run --no-sync pytest" if job_name == "extras" else "npm ci"
        assert end < step["run"].index(workload_command)
    private_temp = tmp_path / "private temp"
    private_temp.mkdir(mode=0o700)
    sentinel = tmp_path / "workload-started"
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_bytes((ROOT / "pyproject.toml").read_bytes())
    for mode, accepted in [(0o700, True), (0o755, False)]:
        private_temp.chmod(mode)
        permissions = {
            path: (path.stat().st_uid, path.stat().st_mode)
            for path in (private_temp, *private_temp.parents)
        }
        before = list(private_temp.iterdir())
        checked = subprocess.run(
            [sys.executable, "-c", code],
            env={**os.environ, "TMPDIR": str(private_temp)},
            text=True,
            capture_output=True,
            check=False,
        )
        assert (checked.returncode == 0) == accepted, checked.stderr
        assert private_temp.stat().st_mode & 0o777 == mode
        assert list(private_temp.iterdir()) == before
        sentinel.unlink(missing_ok=True)
        result = subprocess.run(
            [
                "bash",
                "--noprofile",
                "--norc",
                "-e",
                "-o",
                "pipefail",
                "-c",
                preflight + '\nprintf reached > "$PREFLIGHT_SENTINEL"',
            ],
            env={
                **os.environ,
                "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
                "TMPDIR": str(private_temp),
                "PREFLIGHT_SENTINEL": str(sentinel),
                "UV_PROJECT_ENVIRONMENT": sys.prefix,
            },
            cwd=project,
            text=True,
            capture_output=True,
            check=False,
        )
        assert (result.returncode == 0) == accepted, result.stderr
        assert sentinel.exists() == accepted
        assert not (project / ".venv").exists()
        assert {
            path: (path.stat().st_uid, path.stat().st_mode) for path in permissions
        } == permissions
        if not accepted:
            assert "RegistryPrivacyError" in result.stderr
