"""Credential scanning stays enabled with full history and minimal permissions."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "secret-scan.yml"


def _load_workflow() -> dict:
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data


def test_secret_scan_covers_changes_and_scheduled_history() -> None:
    data = _load_workflow()
    triggers = data["on"]
    assert "pull_request" in triggers
    assert triggers["push"]["branches"] == ["main"]
    assert "workflow_dispatch" in triggers
    assert "schedule" in triggers
    assert data["permissions"] == {"contents": "read", "pull-requests": "read"}

    steps = data["jobs"]["gitleaks"]["steps"]
    checkout = steps[0]
    assert checkout["uses"] == "actions/checkout@v6"
    assert checkout["with"]["fetch-depth"] == 0
    assert checkout["with"]["persist-credentials"] is False
    scan = steps[1]
    assert scan["uses"].startswith("gitleaks/gitleaks-action@")
    assert not scan["uses"].endswith("@v3")
    assert scan["env"]["GITLEAKS_ENABLE_COMMENTS"] == "false"
    assert scan["env"]["GITLEAKS_ENABLE_UPLOAD_ARTIFACT"] == "false"


def test_gitleaks_has_no_committed_ignore_baseline() -> None:
    assert not (ROOT / ".gitleaksignore").exists()


def _public_tree_violations(root: Path) -> list[str]:
    forbidden = (
        ("hound" + "stooth").encode(),
        ("digitalocean" + "spaces.com").encode(),
        ("138.68." + "214.23").encode(),
        ("216.40." + "34.41").encode(),
    )
    provider_root = Path("src/podcast_online")
    hits: list[str] = []
    tracked = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "-z"],
    ).split(b"\0")
    for raw_relative in tracked:
        if not raw_relative:
            continue
        relative = Path(os.fsdecode(raw_relative))
        if relative == provider_root or provider_root in relative.parents:
            hits.append(f"{relative}: private provider source")
        path = root / relative
        if not path.is_file():
            continue
        content = path.read_bytes().lower()
        for marker in forbidden:
            if marker.lower() in content:
                hits.append(f"{relative}: {marker.decode()}")

    return hits


def test_public_tree_has_no_private_provider_markers() -> None:
    hits = _public_tree_violations(ROOT)
    assert not hits, "private provider markers remain:\n" + "\n".join(hits)


def _init_git_repo(root: Path) -> None:
    subprocess.run(
        ["git", "-C", str(root), "init", "--quiet", "--initial-branch=main"],
        check=True,
    )


def test_public_tree_ignores_untracked_provider_cache(tmp_path: Path) -> None:
    cache = tmp_path / "src" / "podcast_online" / "__pycache__" / "dummy.pyc"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"ignored cache")
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text("src/podcast_online/\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", ".gitignore"], check=True)

    assert _public_tree_violations(tmp_path) == []


def test_public_tree_reports_tracked_provider_source(tmp_path: Path) -> None:
    source = tmp_path / "src" / "podcast_online" / "provider.py"
    source.parent.mkdir(parents=True)
    source.write_text("provider = True\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    subprocess.run(
        ["git", "-C", str(tmp_path), "add", "--", "src/podcast_online/provider.py"], check=True
    )

    assert _public_tree_violations(tmp_path) == [
        "src/podcast_online/provider.py: private provider source"
    ]


def test_public_tree_reports_tracked_forbidden_marker(tmp_path: Path) -> None:
    marker_file = tmp_path / "tracked.txt"
    marker_file.write_text("contains " + "hound" + "stooth\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", "tracked.txt"], check=True)

    assert _public_tree_violations(tmp_path) == ["tracked.txt: " + "hound" + "stooth"]
