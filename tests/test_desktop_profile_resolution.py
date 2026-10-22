import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "scripts" / "desktop"
DEV_PROFILE = ROOT / "config" / "distribution.dev.json"
BUILD_SCRIPTS = ["build_desktop.sh", "build_linux_appimage.sh"]


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _run_build_script(
    tmp_path: Path, script_name: str, cwd: Path, profile: str | None
) -> tuple[subprocess.CompletedProcess[str], list[str], list[str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    python_log = tmp_path / "python.log"
    npm_log = tmp_path / "npm.log"
    _write_executable(
        bin_dir / "python3",
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CALL_LOG"\n',
    )
    _write_executable(bin_dir / "cargo", "#!/usr/bin/env bash\nexit 0\n")
    _write_executable(bin_dir / "uname", "#!/usr/bin/env bash\necho Linux\n")
    _write_executable(bin_dir / "xdg-mime", "#!/usr/bin/env bash\nexit 0\n")
    _write_executable(
        bin_dir / "npm",
        "#!/usr/bin/env bash\n"
        'printf \'%s\\n\' "${PODCAST_DISTRIBUTION_PROFILE-unset}" >> "$NPM_LOG"\n'
        'if [[ "$*" == *appimage* ]]; then\n'
        '  mkdir -p "$CARGO_TARGET_DIR/release/bundle/appimage"\n'
        '  touch "$CARGO_TARGET_DIR/release/bundle/appimage/test.AppImage"\n'
        "fi\n"
        "exit 0\n",
    )
    env = {
        key: value for key, value in os.environ.items() if key != "PODCAST_DISTRIBUTION_PROFILE"
    } | {
        "CALL_LOG": str(python_log),
        "NPM_LOG": str(npm_log),
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "CARGO_TARGET_DIR": str(tmp_path / "target"),
        "SHARECUT_SIDECAR_OUT": str(tmp_path / "sidecar"),
        "SKIP_APPIMAGE_SMOKE": "1",
        "SHARECUT_SKIP_UPDATER_ARTIFACTS": "1",
    }
    if profile is not None:
        env["PODCAST_DISTRIBUTION_PROFILE"] = profile
    completed = subprocess.run(
        ["bash", str(DESKTOP / script_name)],
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    python_calls = (
        python_log.read_text(encoding="utf-8").splitlines() if python_log.exists() else []
    )
    npm_values = npm_log.read_text(encoding="utf-8").splitlines() if npm_log.exists() else []
    return completed, python_calls, npm_values


def _profile_arg(python_calls: list[str]) -> str:
    generator = next(call for call in python_calls if "generate_distribution_config.py" in call)
    return generator.split("--profile ", 1)[1].split(" --output", 1)[0]


@pytest.mark.parametrize("script_name", BUILD_SCRIPTS)
def test_build_scripts_default_to_the_dev_profile_when_unset(
    tmp_path: Path, script_name: str
) -> None:
    caller = tmp_path / "caller"
    caller.mkdir()

    completed, python_calls, npm_values = _run_build_script(tmp_path, script_name, caller, None)

    assert completed.returncode == 0, completed.stderr
    assert _profile_arg(python_calls) == str(DEV_PROFILE)
    assert set(npm_values) == {str(DEV_PROFILE)}


@pytest.mark.parametrize("script_name", BUILD_SCRIPTS)
def test_build_scripts_treat_an_empty_profile_as_unset(tmp_path: Path, script_name: str) -> None:
    caller = tmp_path / "caller"
    caller.mkdir()

    completed, python_calls, _ = _run_build_script(tmp_path, script_name, caller, "")

    assert completed.returncode == 0, completed.stderr
    assert _profile_arg(python_calls) == str(DEV_PROFILE)


@pytest.mark.parametrize("script_name", BUILD_SCRIPTS)
@pytest.mark.parametrize("prefix", ["", "./", "../caller/"])
def test_build_scripts_resolve_a_relative_profile_from_the_callers_directory(
    tmp_path: Path, script_name: str, prefix: str
) -> None:
    caller = (tmp_path / "caller").resolve()
    profile = caller / "profiles" / "distribution.json"
    profile.parent.mkdir(parents=True)
    profile.write_text("{}\n", encoding="utf-8")

    completed, python_calls, npm_values = _run_build_script(
        tmp_path, script_name, caller, f"{prefix}profiles/distribution.json"
    )

    assert completed.returncode == 0, completed.stderr
    assert _profile_arg(python_calls) == str(profile)
    assert set(npm_values) == {str(profile)}


@pytest.mark.parametrize("script_name", BUILD_SCRIPTS)
def test_build_scripts_resolve_symlinked_profile_directories_to_the_physical_path(
    tmp_path: Path, script_name: str
) -> None:
    real = (tmp_path / "real").resolve()
    real.mkdir()
    (real / "distribution.json").write_text("{}\n", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(real)

    completed, python_calls, npm_values = _run_build_script(
        tmp_path, script_name, tmp_path, str(link / "distribution.json")
    )

    assert completed.returncode == 0, completed.stderr
    assert _profile_arg(python_calls) == str(real / "distribution.json")
    assert set(npm_values) == {str(real / "distribution.json")}


@pytest.mark.parametrize("script_name", BUILD_SCRIPTS)
def test_build_scripts_keep_going_past_a_missing_profile_directory(
    tmp_path: Path, script_name: str
) -> None:
    completed, python_calls, _ = _run_build_script(
        tmp_path, script_name, tmp_path, str(tmp_path / "no-such-dir" / "distribution.json")
    )

    assert "cd:" in completed.stderr
    assert _profile_arg(python_calls) == "/distribution.json"


def _run_docker_wrapper(
    tmp_path: Path, cwd: Path, profile: str | None
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker_log = tmp_path / "docker.log"
    _write_executable(
        bin_dir / "docker",
        "#!/usr/bin/env bash\n"
        'if [[ "$1 $2" == "image inspect" ]]; then echo amd64; exit 0; fi\n'
        'printf \'%s\\n\' "$@" >> "$DOCKER_LOG"\n',
    )
    _write_executable(bin_dir / "uname", "#!/usr/bin/env bash\necho x86_64\n")
    _write_executable(
        bin_dir / "curl",
        "#!/usr/bin/env bash\n"
        "out=''\n"
        "while (( $# )); do\n"
        '  if [[ "$1" == -o ]]; then out="$2"; shift 2; else shift; fi\n'
        "done\n"
        'printf fixture > "$out"\n',
    )
    _write_executable(bin_dir / "shasum", "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n")
    env = {
        key: value for key, value in os.environ.items() if key != "PODCAST_DISTRIBUTION_PROFILE"
    } | {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "TMPDIR": str(tmp_path / "tmp"),
        "DOCKER_LOG": str(docker_log),
    }
    if profile is not None:
        env["PODCAST_DISTRIBUTION_PROFILE"] = profile
    completed = subprocess.run(
        ["bash", str(DESKTOP / "build_linux_appimage_docker.sh")],
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    arguments = docker_log.read_text(encoding="utf-8").splitlines() if docker_log.exists() else []
    return completed, arguments


def _profile_env_args(arguments: list[str]) -> list[str]:
    return [arg for arg in arguments if arg.startswith("PODCAST_DISTRIBUTION_PROFILE=")]


def _profile_mounts(arguments: list[str]) -> list[str]:
    return [arg for arg in arguments if ":/run/sharecut/" in arg]


def test_docker_wrapper_mounts_a_relative_external_profile_from_the_callers_directory(
    tmp_path: Path,
) -> None:
    caller = (tmp_path / "caller").resolve()
    profile = caller / "private" / "distribution.json"
    profile.parent.mkdir(parents=True)
    profile.write_text("{}\n", encoding="utf-8")

    completed, arguments = _run_docker_wrapper(tmp_path, caller, "./private/distribution.json")

    assert completed.returncode == 0, completed.stderr
    assert _profile_env_args(arguments) == [
        "PODCAST_DISTRIBUTION_PROFILE=/run/sharecut/distribution.json"
    ]
    assert _profile_mounts(arguments) == [f"{profile}:/run/sharecut/distribution.json:ro"]


def test_docker_wrapper_maps_a_profile_inside_the_repo_without_a_mount(tmp_path: Path) -> None:
    completed, arguments = _run_docker_wrapper(tmp_path, ROOT, "config/distribution.dev.json")

    assert completed.returncode == 0, completed.stderr
    assert _profile_env_args(arguments) == [
        "PODCAST_DISTRIBUTION_PROFILE=/src/config/distribution.dev.json"
    ]
    assert _profile_mounts(arguments) == []


@pytest.mark.parametrize("profile", [None, ""])
def test_docker_wrapper_passes_no_profile_when_unset_or_empty(
    tmp_path: Path, profile: str | None
) -> None:
    completed, arguments = _run_docker_wrapper(tmp_path, ROOT, profile)

    assert completed.returncode == 0, completed.stderr
    assert _profile_env_args(arguments) == []
    assert _profile_mounts(arguments) == []


@pytest.mark.parametrize("missing", ["missing.json", "no-such-dir/missing.json"])
def test_docker_wrapper_refuses_a_missing_profile_before_running_docker(
    tmp_path: Path, missing: str
) -> None:
    caller = (tmp_path / "caller").resolve()
    caller.mkdir()

    completed, arguments = _run_docker_wrapper(tmp_path, caller, missing)

    assert completed.returncode == 1
    assert completed.stderr.strip() == f"error: distribution profile not found: {caller}/{missing}"
    assert arguments == []
