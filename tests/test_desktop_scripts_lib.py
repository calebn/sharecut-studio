"""scripts/desktop/lib.sh: the one shell preamble every desktop script shares."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP_DIR = ROOT / "scripts" / "desktop"
LIB = DESKTOP_DIR / "lib.sh"
SOURCE_LINE = 'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"'
SCRIPTS = sorted(path for path in DESKTOP_DIR.glob("*.sh") if path != LIB)


def _bash(script: str, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", "-c", script],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def test_desktop_scripts_exist() -> None:
    assert len(SCRIPTS) == 10


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_every_desktop_script_sources_lib_and_keeps_none_of_its_duplicates(script: Path) -> None:
    text = script.read_text(encoding="utf-8")
    assert text.count(SOURCE_LINE) == 1
    code = [line for line in text.splitlines() if line and not line.lstrip().startswith("#")]
    assert code[0] == SOURCE_LINE
    assert "set -euo pipefail" not in text
    assert "cleanup()" not in text
    assert 'ROOT="$(cd "$(dirname "$0")' not in text
    assert 'CALLER_DIR="$PWD"' not in text
    assert "pwd -P" not in text
    assert "$ROOT/config/distribution.dev.json" not in text
    done = subprocess.run(
        ["/bin/bash", "-n", str(script)], check=False, capture_output=True, text=True
    )
    assert done.returncode == 0, done.stderr


def test_lib_parses_and_sets_strict_mode_and_root() -> None:
    done = _bash(f'source "{LIB}"; echo "$ROOT"; [[ $- == *e* && $- == *u* ]] && echo strict')
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == [str(ROOT), "strict"]


def test_on_exit_runs_in_registration_order_and_keeps_the_exit_status() -> None:
    done = _bash(
        f'source "{LIB}"; on_exit "echo first"; on_exit "false"; on_exit "echo last"; exit 7'
    )
    assert done.returncode == 7
    assert done.stdout.split() == ["first", "last"]


def test_on_exit_sees_variables_set_after_registration() -> None:
    done = _bash(f'source "{LIB}"; on_exit \'echo "$later"\'; later=value')
    assert done.returncode == 0
    assert done.stdout.strip() == "value"


def _stub_xcrun(tmp_path: Path, *, fail_first: int) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    counter = tmp_path / "count"
    counter.write_text("0")
    stub = bin_dir / "xcrun"
    stub.write_text(
        "#!/bin/bash\n"
        f'n=$(($(cat "{counter}") + 1)); echo "$n" > "{counter}"\n'
        'echo "stapler said $2"\n'
        f'[[ "$2" == staple && "$n" -le {fail_first} ]] && exit 1\n'
        "exit 0\n",
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "STAPLE_RETRY_DELAY": "0"}


def test_staple_with_retries_retries_then_succeeds_without_touching_stdout(tmp_path: Path) -> None:
    env = _stub_xcrun(tmp_path, fail_first=1)
    done = _bash(f'source "{LIB}"; staple_with_retries /some/app', env=env)
    assert done.returncode == 0, done.stderr
    assert done.stdout == ""
    assert "stapling attempt 1/8 failed" in done.stderr


def test_staple_with_retries_gives_up_after_the_attempt_budget(tmp_path: Path) -> None:
    env = _stub_xcrun(tmp_path, fail_first=99) | {"STAPLE_ATTEMPTS": "2"}
    done = _bash(f'source "{LIB}"; staple_with_retries /some/app; echo unreachable', env=env)
    assert done.returncode == 1
    assert "could not staple a notarization ticket to /some/app after 2 attempts" in done.stderr
    assert "unreachable" not in done.stdout


@pytest.mark.parametrize(
    ("machine", "arch"), [("arm64", "aarch64"), ("x86_64", "x64"), ("riscv64", "riscv64")]
)
def test_desktop_arch_maps_uname_to_tauri_names(tmp_path: Path, machine: str, arch: str) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uname = bin_dir / "uname"
    uname.write_text(f"#!/bin/bash\necho {machine}\n", encoding="utf-8")
    uname.chmod(0o755)
    done = _bash(f'source "{LIB}"; desktop_arch', env={"PATH": f"{bin_dir}:/usr/bin:/bin"})
    assert done.stdout.strip() == arch


def _resolve(
    tmp_path: Path, *args: str, profile: str | None, then_cd: str | None = None
) -> subprocess.CompletedProcess[str]:
    caller = tmp_path / "caller"
    caller.mkdir(exist_ok=True)
    env = {"PATH": "/usr/bin:/bin"}
    if profile is not None:
        env["PODCAST_DISTRIBUTION_PROFILE"] = profile
    move = f'cd "{then_cd}"; ' if then_cd else ""
    return _bash(
        f'cd "{caller}"; source "{LIB}"; {move}'
        f'on_exit "echo trap-ran"; P="$(resolve_distribution_profile {" ".join(args)})"; echo "$P"',
        env=env,
    )


@pytest.mark.parametrize("profile", [None, ""])
def test_resolve_distribution_profile_defaults_when_unset_or_empty(
    tmp_path: Path, profile: str | None
) -> None:
    done = _resolve(tmp_path, profile=profile)
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == [str(ROOT / "config" / "distribution.dev.json"), "trap-ran"]


@pytest.mark.parametrize("prefix", ["", "./", "../caller/"])
def test_resolve_distribution_profile_joins_relative_paths_onto_the_callers_directory(
    tmp_path: Path, prefix: str
) -> None:
    caller = (tmp_path / "caller").resolve()
    (caller / "profiles").mkdir(parents=True)
    done = _resolve(tmp_path, profile=f"{prefix}profiles/d.json", then_cd="/")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split()[0] == str(caller / "profiles" / "d.json")


def test_resolve_distribution_profile_makes_the_directory_physical_but_keeps_the_basename(
    tmp_path: Path,
) -> None:
    real = (tmp_path / "real").resolve()
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    (real / "target.json").write_text("{}", encoding="utf-8")
    (real / "d.json").symlink_to(real / "target.json")
    done = _resolve(tmp_path, profile=str(tmp_path / "link" / "d.json"))
    assert done.returncode == 0, done.stderr
    assert done.stdout.split()[0] == str(real / "d.json")


def test_resolve_distribution_profile_keeps_going_past_a_missing_directory_without_the_flag(
    tmp_path: Path,
) -> None:
    done = _resolve(tmp_path, profile=str(tmp_path / "nodir" / "d.json"))
    assert done.returncode == 0
    assert "cd:" in done.stderr
    assert done.stdout.split()[0] == "/d.json"


def test_resolve_distribution_profile_must_exist_accepts_an_existing_file(
    tmp_path: Path,
) -> None:
    profile = (tmp_path / "caller").resolve() / "d.json"
    profile.parent.mkdir()
    profile.write_text("{}", encoding="utf-8")
    done = _resolve(tmp_path, "--must-exist", profile="d.json")
    assert done.returncode == 0, done.stderr
    assert done.stdout.split()[0] == str(profile)


def test_resolve_distribution_profile_must_exist_ignores_an_unset_profile(tmp_path: Path) -> None:
    done = _resolve(tmp_path, "--must-exist", profile=None)
    assert done.returncode == 0, done.stderr
    assert done.stdout.split()[0] == str(ROOT / "config" / "distribution.dev.json")


@pytest.mark.parametrize("profile", ["missing.json", "nodir/missing.json"])
def test_resolve_distribution_profile_must_exist_fails_before_the_path_is_made_physical(
    tmp_path: Path, profile: str
) -> None:
    caller = (tmp_path / "caller").resolve()
    done = _resolve(tmp_path, "--must-exist", profile=profile)
    assert done.returncode == 1
    assert done.stdout.split() == ["trap-ran"]
    assert done.stderr.strip() == f"error: distribution profile not found: {caller}/{profile}"


def test_resolve_distribution_profile_rejects_an_unknown_option(tmp_path: Path) -> None:
    done = _resolve(tmp_path, "--bogus", profile=None)
    assert done.returncode == 2
    assert "unknown option: --bogus" in done.stderr
