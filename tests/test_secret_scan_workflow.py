"""Credential scanning stays enabled; the public tree carries no private markers or public IPs."""

from __future__ import annotations

import ipaddress
import os
import re
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "secret-scan.yml"

# Well-known resolver / placeholder addresses used as client IPs in tests.
_PUBLIC_IPV4_ALLOWLIST = frozenset({"1.1.1.1", "9.9.9.9", "1.2.3.4"})
# Lockfile version tuples (a.b.c.d) look like IPv4 literals; they hold no infra.
_LOCKFILE_NAMES = frozenset(
    {"uv.lock", "package-lock.json", "Cargo.lock", "pnpm-lock.yaml", "yarn.lock"}
)
_IPV4_LITERAL = re.compile(rb"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")


def test_secret_scan_covers_changes_and_scheduled_history() -> None:
    data = load_github_yaml(WORKFLOW)
    triggers = data["on"]
    assert "pull_request" in triggers
    assert triggers["push"]["branches"] == ["main"]
    assert "workflow_dispatch" in triggers
    assert "schedule" in triggers
    assert data["permissions"] == {"contents": "read", "pull-requests": "read"}

    steps = data["jobs"]["gitleaks"]["steps"]
    checkout = steps[0]
    assert checkout["uses"] == "actions/checkout@v7"
    assert checkout["with"]["fetch-depth"] == 0
    assert checkout["with"]["persist-credentials"] is False
    scan = steps[1]
    assert scan["uses"].startswith("gitleaks/gitleaks-action@")
    assert not scan["uses"].endswith("@v3")
    assert scan["env"]["GITLEAKS_ENABLE_COMMENTS"] == "false"
    assert scan["env"]["GITLEAKS_ENABLE_UPLOAD_ARTIFACT"] == "false"


def test_gitleaks_has_no_committed_ignore_baseline() -> None:
    assert not (ROOT / ".gitleaksignore").exists()


def _public_ipv4_literals(relative: Path, content: bytes) -> list[str]:
    """Return global IPv4 literals in a text blob that are not allowlisted."""
    if relative.name in _LOCKFILE_NAMES or b"\0" in content[:8192]:
        return []
    found: list[str] = []
    for match in _IPV4_LITERAL.finditer(content):
        literal = match.group().decode()
        try:
            address = ipaddress.ip_address(literal)
        except ValueError:
            continue  # e.g. 999.1.1.1
        if address.is_global and literal not in _PUBLIC_IPV4_ALLOWLIST:
            found.append(literal)
    return sorted(set(found))


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
        ["git", "-C", str(root), "ls-files", "--stage", "-z"],
    ).split(b"\0")
    entries: list[tuple[bytes, bytes, bytes]] = []
    for raw_entry in tracked:
        if not raw_entry:
            continue
        metadata, raw_relative = raw_entry.split(b"\t", 1)
        mode, oid, _stage = metadata.split()
        entries.append((raw_relative, oid, mode))

    # Read the same immutable blobs Git would publish. Opening checkout paths
    # could follow a symlink or miss staged content after a local edit.
    blobs = subprocess.run(
        ["git", "-C", str(root), "cat-file", "--batch"],
        input=b"".join(oid + b"\n" for _, oid, mode in entries if mode != b"160000"),
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    offset = 0
    for raw_relative, oid, mode in entries:
        relative = Path(os.fsdecode(raw_relative))
        if relative == provider_root or provider_root in relative.parents:
            hits.append(f"{relative}: private provider source")
        # A gitlink points to a commit in another repository, which need not
        # exist in this repository's object store. Its tracked path still counts.
        if mode == b"160000":
            continue
        header_end = blobs.index(b"\n", offset)
        result_oid, object_type, raw_size = blobs[offset:header_end].split()
        assert result_oid == oid
        size = int(raw_size)
        content = blobs[header_end + 1 : header_end + 1 + size]
        offset = header_end + size + 2  # object bytes and trailing newline
        if object_type != b"blob":
            continue
        for literal in _public_ipv4_literals(relative, content):
            hits.append(f"{relative}: public IPv4 literal {literal}")
        content = content.lower()
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


def test_public_tree_scans_staged_bytes_after_checkout_changes(tmp_path: Path) -> None:
    marker_file = tmp_path / "tracked.txt"
    marker_file.write_text("contains " + "hound" + "stooth\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", "tracked.txt"], check=True)
    marker_file.write_text("redacted in checkout\n", encoding="utf-8")

    assert _public_tree_violations(tmp_path) == ["tracked.txt: " + "hound" + "stooth"]


def test_public_tree_ignores_unstaged_marker_and_missing_checkout(tmp_path: Path) -> None:
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("safe content\n", encoding="utf-8")
    _init_git_repo(tmp_path)
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", "tracked.txt"], check=True)
    tracked.write_text("hound" + "stooth\n", encoding="utf-8")
    assert _public_tree_violations(tmp_path) == []

    tracked.unlink()
    assert _public_tree_violations(tmp_path) == []


def test_public_tree_does_not_follow_tracked_symlinks(tmp_path: Path) -> None:
    target = tmp_path / "ignored.txt"
    target.write_text("contains " + "hound" + "stooth\n", encoding="utf-8")
    (tmp_path / "tracked-link").symlink_to(target.name)
    _init_git_repo(tmp_path)
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", "tracked-link"], check=True)

    assert _public_tree_violations(tmp_path) == []


def test_public_tree_checks_gitlink_paths_without_reading_submodule_commits(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    missing_commit = "1" * 40
    for path in ("vendor/external", "src/podcast_online"):
        subprocess.run(
            [
                "git",
                "-C",
                str(tmp_path),
                "update-index",
                "--add",
                "--cacheinfo",
                f"160000,{missing_commit},{path}",
            ],
            check=True,
        )

    assert _public_tree_violations(tmp_path) == ["src/podcast_online: private provider source"]


def test_public_tree_reports_tracked_public_ipv4_literal(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ip = "8.8." + "4.4"
    (tmp_path / "tracked.txt").write_text(f"relay at {ip}\n")
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == [f"tracked.txt: public IPv4 literal {ip}"]


def test_public_tree_allows_private_documentation_and_allowlisted_ipv4(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "tracked.txt").write_text(
        "127.0.0.1 10.0.0.5 192.168.1.10 172.16.0.1 203.0.113.7 198.51.100.2 "
        "0.0.0.0 1.1.1.1 999.1.1.1 v1.2.3.4.5\n"
    )
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == []


def test_public_tree_skips_lockfiles_and_binary_blobs_for_ipv4(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ip = "8.8." + "4.4"
    (tmp_path / "uv.lock").write_text('version = "' + "13.1." + '1.3"\n')
    (tmp_path / "blob.bin").write_bytes(b"\0" + ip.encode())
    subprocess.run(["git", "add", "uv.lock", "blob.bin"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == []


def test_public_ipv4_literals_deduplicates() -> None:
    ip = "8.8." + "4.4"
    assert _public_ipv4_literals(Path("a.md"), f"{ip} {ip}".encode()) == [ip]
