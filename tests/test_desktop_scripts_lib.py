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
