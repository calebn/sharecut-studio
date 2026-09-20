"""Pre-push gates push on green make ci; stamp + SKIP_CI are documented contracts."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / ".githooks" / "pre-push"
ZERO = "0000000000000000000000000000000000000000"


def test_pre_push_hook_gates_on_make_ci() -> None:
    text = HOOK.read_text(encoding="utf-8")
    assert "make ci" in text
    assert "SKIP_CI" in text
    assert "git rev-parse --git-dir" in text
    assert "ci-stamp" in text
    assert "diff-index" in text
    assert ZERO in text or '"$zero"' in text
    assert "set -e" in text
    assert ".venv/bin" in text
    assert "gui/web/node_modules/.bin" in text
    assert "unset GIT_DIR" in text


def test_makefile_ci_stamps_head_atomically() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "rm -f" in text and "ci-stamp" in text
    assert "|| { rm -f" in text
    assert "ci-stamp.tmp.$$$$" in text
    assert "mv -f" in text
    assert "diff-index" in text


def test_makefile_ci_skips_stamp_when_dirty_without_failing() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    match = re.search(r"^ci:\n(?:\t.*\n)+", text, re.MULTILINE)
    assert match is not None
    recipe = match.group(0)
    assert "diff-index --quiet HEAD" in recipe
    assert "green, skipping ci-stamp" in recipe
    assert "next push will re-run make ci once the worktree is clean" in recipe
    assert "exit 0" in recipe
    assert "commit or stash first" not in recipe


def test_makefile_hooks_chmods_pre_push() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" in text


def test_install_sh_chmods_pre_push() -> None:
    text = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" in text
    assert "is-inside-work-tree" in text


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args],
        cwd=repo,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()


@pytest.fixture
def hook_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "README").write_text("x\n", encoding="utf-8")
    _git(repo, "add", "README")
    _git(repo, "commit", "-m", "init")
    return repo


def _run_hook(
    repo: Path,
    *,
    stdin: str,
    make_exit: int = 0,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    fake_bin = repo / "fakebin"
    fake_bin.mkdir(exist_ok=True)
    make_path = fake_bin / "make"
    make_path.write_text(
        f"#!/bin/sh\necho FAKE_MAKE $*\nexit {make_exit}\n",
        encoding="utf-8",
    )
    make_path.chmod(0o755)
    env = {
        **os.environ,
        **(extra_env or {}),
        "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
    }
    return subprocess.run(
        ["sh", str(HOOK)],
        cwd=repo,
        input=stdin,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def _push_line(repo: Path, local_sha: str | None = None) -> str:
    sha = local_sha or _git(repo, "rev-parse", "HEAD")
    return f"refs/heads/main {sha} refs/heads/main {ZERO}\n"


def test_pre_push_skip_ci_env(hook_repo: Path) -> None:
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo), extra_env={"SKIP_CI": "1"})
    assert result.returncode == 0
    assert "SKIP_CI=1" in result.stderr


def test_pre_push_delete_only_skips(hook_repo: Path) -> None:
    head = _git(hook_repo, "rev-parse", "HEAD")
    stdin = f"refs/heads/gone {ZERO} refs/heads/gone {head}\n"
    result = _run_hook(hook_repo, stdin=stdin)
    assert result.returncode == 0
    assert "FAKE_MAKE" not in result.stdout + result.stderr


def test_pre_push_stamp_skip(hook_repo: Path) -> None:
    head = _git(hook_repo, "rev-parse", "HEAD")
    git_dir = Path(_git(hook_repo, "rev-parse", "--git-dir"))
    if not git_dir.is_absolute():
        git_dir = hook_repo / git_dir
    (git_dir / "ci-stamp").write_text(head + "\n", encoding="utf-8")
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo))
    assert result.returncode == 0
    assert "ci-stamp matches HEAD" in result.stderr
    assert "FAKE_MAKE" not in result.stdout + result.stderr


def test_pre_push_red_make_aborts(hook_repo: Path) -> None:
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo), make_exit=1)
    assert result.returncode == 1
    assert "FAKE_MAKE" in result.stdout + result.stderr


def test_pre_push_green_make_allows(hook_repo: Path) -> None:
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo), make_exit=0)
    assert result.returncode == 0
    assert "FAKE_MAKE ci" in result.stdout + result.stderr


def test_pre_push_refuses_non_head_tip(hook_repo: Path) -> None:
    other = "1" * 40
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo, local_sha=other))
    assert result.returncode == 1
    assert "refusing tip" in result.stderr


def test_pre_push_refuses_dirty_worktree(hook_repo: Path) -> None:
    (hook_repo / "README").write_text("dirty\n", encoding="utf-8")
    result = _run_hook(hook_repo, stdin=_push_line(hook_repo))
    assert result.returncode == 1
    assert "dirty" in result.stderr
