"""Local hooks do not gate public pushes on the full CI suite."""

import os
import shutil
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pre_push_ci_gate_is_not_installed() -> None:
    assert not (ROOT / ".githooks" / "pre-push").exists()


def test_hooks_target_installs_only_pre_commit() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit" in text
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" not in text


def test_installer_installs_only_pre_commit() -> None:
    text = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit" in text
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" not in text


def test_make_ci_is_an_unstamped_local_mirror() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "ci:\n\t@$(MAKE) --no-print-directory ci-body" in text
    assert "ci-stamp" not in text


def _git(cwd: Path, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def _stub_bin(tmp_path: Path) -> tuple[Path, Path]:
    """Fake `uv` / `npm` that only log their argv."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    for tool in ("uv", "npm"):
        stub = bin_dir / tool
        stub.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\n', encoding="utf-8")
        stub.chmod(0o755)
    return bin_dir, log


def _repo_with_worktree(tmp_path: Path) -> tuple[Path, Path]:
    main = tmp_path / "main"
    (main / "scripts").mkdir(parents=True)
    (main / ".githooks").mkdir()
    (main / "gui" / "web").mkdir(parents=True)
    shutil.copy(ROOT / "scripts" / "worktree-setup.sh", main / "scripts" / "worktree-setup.sh")
    shutil.copy(ROOT / ".githooks" / "pre-commit", main / ".githooks" / "pre-commit")
    (main / "gui" / "web" / "package-lock.json").write_text("{}", encoding="utf-8")
    _git(tmp_path, "init", "-q", "-b", "main", str(main))
    _git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".")
    _git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init")
    _git(main, "config", "extensions.worktreeConfig", "true")
    wt = tmp_path / "wt"
    _git(main, "worktree", "add", "-q", str(wt))
    # Simulate a tool that pinned the worktree to the main checkout's hooks.
    _git(wt, "config", "--worktree", "core.hooksPath", str(main / ".githooks"))
    return main, wt


def _run_setup(wt: Path, bin_dir: Path) -> None:
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
    subprocess.run(["sh", "scripts/worktree-setup.sh"], cwd=wt, env=env, check=True)


def test_worktree_setup_provisions_and_uses_own_hooks(tmp_path: Path) -> None:
    _main, wt = _repo_with_worktree(tmp_path)
    bin_dir, log = _stub_bin(tmp_path)

    _run_setup(wt, bin_dir)

    assert _git(wt, "config", "--get", "core.hooksPath") == ".githooks"
    calls = log.read_text(encoding="utf-8").splitlines()
    assert "uv sync --quiet --extra dev --extra gui --extra relay" in calls
    assert any(c.startswith("npm ci") for c in calls)
    dev = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "optional-dependencies"
    ]["dev"]
    assert any(requirement.startswith("pre-commit>=") for requirement in dev)


def test_worktree_setup_skips_npm_ci_when_node_modules_current(tmp_path: Path) -> None:
    _main, wt = _repo_with_worktree(tmp_path)
    bin_dir, log = _stub_bin(tmp_path)
    stamp = wt / "gui" / "web" / "node_modules" / ".package-lock.json"
    stamp.parent.mkdir(parents=True)
    stamp.write_text("{}", encoding="utf-8")
    lock = wt / "gui" / "web" / "package-lock.json"
    os.utime(lock, (1_000_000, 1_000_000))

    _run_setup(wt, bin_dir)

    calls = log.read_text(encoding="utf-8").splitlines()
    assert not any(c.startswith("npm") for c in calls)


def test_pre_commit_self_provisions_and_falls_back_to_uvx() -> None:
    text = (ROOT / ".githooks" / "pre-commit").read_text(encoding="utf-8")
    assert "sh scripts/worktree-setup.sh" in text
    assert "uvx pre-commit run --hook-stage pre-commit" in text
    assert "exit 1" not in text
    make = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "worktree-setup:\n\tsh scripts/worktree-setup.sh" in make
