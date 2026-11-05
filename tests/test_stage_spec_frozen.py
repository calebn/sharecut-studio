"""scripts/check_stage_spec_frozen.py: the stage design specs change only with owner approval."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
guard = load_script("check_stage_spec_frozen")


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    (tmp_path / "docs/design/stages").mkdir(parents=True)
    (tmp_path / "docs/design/stages/spec.md").write_text("a\n")
    (tmp_path / "README.md").write_text("a\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "checkout", "-qb", "work")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _commit(repo: Path, path: str, message: str) -> None:
    (repo / path).write_text("b\n")
    _git(repo, "commit", "-qam", message)


def test_other_docs_pass(repo):
    _commit(repo, "README.md", "docs: readme")
    assert guard.violations("main...HEAD") == []


def test_stage_spec_edit_fails(repo):
    _commit(repo, "docs/design/stages/spec.md", "docs: match the code")
    assert guard.violations("main...HEAD") == ["docs/design/stages/spec.md"]


def test_owner_trailer_allows_the_edit(repo):
    _commit(
        repo,
        "docs/design/stages/spec.md",
        "docs: spec change\n\nStage-Spec-Approved: Caleb 11-05 project chat",
    )
    assert guard.violations("main...HEAD") == []


def test_empty_trailer_does_not_count(repo):
    _commit(repo, "docs/design/stages/spec.md", "docs: x\n\nStage-Spec-Approved:")
    assert guard.violations("main...HEAD") != []


def test_this_change_leaves_the_stage_specs_alone():
    try:
        subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--verify", "-q", "origin/main"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        pytest.skip("no origin/main to compare against")
    cwd = Path.cwd()
    try:
        os.chdir(ROOT)
        assert guard.violations("origin/main...HEAD") == []
    finally:
        os.chdir(cwd)
