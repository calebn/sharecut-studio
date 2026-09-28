"""Format-write belongs in lint-staged, not pre-commit (pre-commit fails after rewrite)."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
DOCS_SYNC = ROOT / "scripts" / "docs_sync.py"


def test_precommit_config_has_no_formatter_rewrite_hook() -> None:
    text = (ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    assert "biome-format" not in text
    assert "ruff-format" not in text


def test_docs_sync_hook_is_warn_only_and_always_runs() -> None:
    """ux-pack-sync used to block the commit; docs-sync only warns (CI is the gate)."""
    config = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8"))
    hooks = config["repos"][0]["hooks"]
    ids = [hook["id"] for hook in hooks]
    assert "ux-pack-sync" not in ids

    docs_sync = next(hook for hook in hooks if hook["id"] == "docs-sync")
    assert docs_sync["entry"] == "python3 scripts/docs_sync.py check --staged"
    assert docs_sync["always_run"] is True
    assert docs_sync["verbose"] is True


def _git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=env
    ).stdout


def _write(repo: Path, rel: str, text: str = "") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _run_check_staged(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(DOCS_SYNC), "check", "--staged"],
        cwd=repo,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def ux_pack_repo(tmp_path: Path) -> Path:
    """A one-rule contract standing in for the ux-pack row, in its own repo so `main` (the
    docs-sync `--staged` fallback base) stays fixed while `work` moves ahead of it."""
    contract = {
        "api_version": 1,
        "rules": [
            {
                "id": "ux-pack",
                "when": "UX onboarding pack",
                "update": "`ux/pages/`",
                "docs": ["ux/pages/"],
                "gate": {"include": ["docs/ui-philosophy.md"]},
            }
        ],
    }
    _git(tmp_path, "init", "-q", "-b", "main")
    _write(tmp_path, "contracts/docs-sync.json", json.dumps(contract))
    _write(tmp_path, "docs/ui-philosophy.md", "base\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "checkout", "-qb", "work")
    return tmp_path


def test_ui_philosophy_change_alone_is_reported_as_violated(ux_pack_repo: Path) -> None:
    _write(ux_pack_repo, "docs/ui-philosophy.md", "changed\n")
    _git(ux_pack_repo, "add", "docs/ui-philosophy.md")
    result = _run_check_staged(ux_pack_repo)
    assert result.returncode == 0  # warn only
    assert "VIOLATED  ux-pack" in result.stdout


def test_ux_page_committed_earlier_on_the_branch_satisfies_it(ux_pack_repo: Path) -> None:
    _write(ux_pack_repo, "ux/pages/brief.md", "brief\n")
    _git(ux_pack_repo, "add", "ux/pages/brief.md")
    _git(ux_pack_repo, "commit", "-qm", "docs: add ux page")
    _write(ux_pack_repo, "docs/ui-philosophy.md", "changed\n")
    _git(ux_pack_repo, "add", "docs/ui-philosophy.md")
    result = _run_check_staged(ux_pack_repo)
    assert result.returncode == 0
    assert "VIOLATED" not in result.stdout
    assert "satisfied ux-pack" in result.stdout
