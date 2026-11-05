"""scripts/branches.py: the one source of truth for the base and release branch names."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
branches = load_script("branches", register=True)
CONFIG = json.loads((ROOT / "config" / "branches.json").read_text(encoding="utf-8"))
BASE = CONFIG["base"]
RELEASE = CONFIG["release"]
REQUIRED_JOBS = tuple(CONFIG["required_jobs"])


def test_checked_in_config_names_base_release_and_required_jobs(monkeypatch) -> None:
    monkeypatch.delenv("SHARECUT_BASE_BRANCH", raising=False)
    assert set(CONFIG) == {"base", "release", "required_jobs"}
    assert {"pytest", "frontend", "frontend-e2e", "gitleaks-history"} <= set(REQUIRED_JOBS)
    assert branches.base() == BASE
    assert branches.release() == RELEASE
    assert branches.required_jobs() == REQUIRED_JOBS


def test_env_overrides_only_the_base(monkeypatch) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "trunk")
    assert branches.base() == "trunk"
    assert branches.release() == RELEASE


def test_empty_env_falls_back_to_the_config(monkeypatch) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "")
    assert branches.base() == BASE


def test_load_reads_the_given_file(tmp_path) -> None:
    path = tmp_path / "branches.json"
    path.write_text('{"base": "a", "release": "b", "required_jobs": ["x", "y"]}')
    assert branches.load(path) == branches.Branches("a", "b", ("x", "y"))


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("base", f"{BASE}\n"),
        ("release", f"{RELEASE}\n"),
        ("required-jobs", "".join(f"{job}\n" for job in REQUIRED_JOBS)),
    ],
)
def test_cli_prints_the_value(command: str, expected: str, monkeypatch) -> None:
    monkeypatch.delenv("SHARECUT_BASE_BRANCH", raising=False)
    out = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "branches.py"), command],
        check=True,
        capture_output=True,
        text=True,
    )
    assert out.stdout == expected


def test_cli_rejects_an_unknown_command() -> None:
    out = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "branches.py"), "nope"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert out.returncode == 2


def test_docs_sync_default_base_follows_the_config(monkeypatch) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "trunk")
    assert load_script("docs_sync", register=True).DEFAULT_BASE == "origin/trunk"
