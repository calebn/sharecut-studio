"""Credential scanning stays enabled; the public tree carries no private markers or public IPs."""

from __future__ import annotations

import ipaddress
import os
import re
import subprocess
import tomllib
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "secret-scan.yml"
GITLEAKS_CONFIG = ROOT / ".gitleaks.toml"
_PIN_MODULES = (
    "src/podcast_mcp/whisper_models.py",
    "src/podcast_mcp/word_aligner_models.py",
)

# Well-known resolver / placeholder addresses used as client IPs in tests.
_PUBLIC_IPV4_ALLOWLIST = frozenset({"1.1.1.1", "9.9.9.9", "1.2.3.4"})
# Version tuples and compact path data (a.b.c.d) look like IPv4 literals; they hold no infra.
# Any ``*.lock`` (uv, Cargo, poetry, ...) is skipped by suffix; npm's lockfile is not a .lock.
_LOCKFILE_NAMES = frozenset({"package-lock.json"})
_IPV4_SKIP_SUFFIXES = (".lock", ".svg", ".map", ".min.js")
# Known server addresses, checked by exact substring on the blobs the generic scan skips
# (lockfiles, assets, binary) so skipped file types keep the coverage they had before.
_SERVER_IPV4_MARKERS = (
    ("138.68." + "214.23").encode(),
    ("216.40." + "34.41").encode(),
)
# Dotted quad not glued to a letter/digit or a longer dotted run (v1.2.3.4.5, SVG ``M8.5.2.1z``);
# underscore-joined names (RELAY_<ip>, <ip>_prod) and a sentence-final "." still match.
_IPV4_LITERAL = re.compile(rb"(?<![A-Za-z0-9])(?<!\d\.)(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9]|\.\d)")


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


def test_gitleaks_config_extends_defaults_with_one_scoped_pin_allowlist() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))

    assert config["extend"] == {"useDefault": True}
    assert "allowlist" not in config
    assert "allowlists" not in config

    assert [r["id"] for r in config["rules"]] == ["generic-api-key"]
    rule = config["rules"][0]
    assert "regex" not in rule  # inherits the default detector

    assert len(rule["allowlists"]) == 1
    allow = rule["allowlists"][0]
    assert allow["condition"] == "AND"
    assert allow["regexTarget"] == "line"
    assert [p for p in _PIN_MODULES if any(re.fullmatch(pat, p) for pat in allow["paths"])] == list(
        _PIN_MODULES
    )
    assert not any(re.fullmatch(pat, "src/podcast_mcp/other.py") for pat in allow["paths"])


def test_gitleaks_pin_allowlist_matches_pin_lines_only() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))
    regexes = config["rules"][0]["allowlists"][0]["regexes"]
    digest = "0123456789abcdef" * 4

    def allowed(line: str) -> bool:
        return any(re.search(pattern, line) for pattern in regexes)

    assert allowed(f'_EN_TOKENIZER_SHA256 = "{digest}"')
    assert allowed(f'            ("tokenizer.json", "{digest}"),')

    assert not allowed(f'API_TOKEN = "{digest}"')
    assert not allowed(f'api_key = "{digest}"')
    assert not allowed(f'("tokenizer.json", "{digest[:-1]}")')
    assert not allowed(f'_EN_TOKENIZER_SHA256 = "{digest.upper()}"')


def test_every_model_pin_line_is_allowlisted_or_standalone() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))
    regexes = config["rules"][0]["allowlists"][0]["regexes"]
    standalone = re.compile(r'^\s*"[0-9a-f]{64}",?\s*(#.*)?$')

    offenders: list[str] = []
    for module in _PIN_MODULES:
        for line in (ROOT / module).read_text(encoding="utf-8").splitlines():
            if not re.search(r"[0-9a-f]{64}", line):
                continue
            if any(re.search(pattern, line) for pattern in regexes):
                continue
            if standalone.match(line):
                continue
            offenders.append(f"{module}: {line}")

    assert offenders == []


def _skips_ipv4_scan(relative: Path, content: bytes) -> bool:
    """Lockfiles, generated assets and binary blobs are not scanned for IPv4 literals."""
    return (
        relative.name in _LOCKFILE_NAMES
        or relative.name.endswith(_IPV4_SKIP_SUFFIXES)
        or b"\0" in content  # binary: a NUL anywhere, not only in the first 8 KiB
    )


def _public_ipv4_literals(relative: Path, content: bytes) -> list[str]:
    """Return global IPv4 literals in a text blob that are not allowlisted."""
    if _skips_ipv4_scan(relative, content):
        return []
    found: list[str] = []
    for match in _IPV4_LITERAL.finditer(content):
        literal = match.group().decode()
        # ipaddress rejects zero-padded octets; canonicalise so padded forms (008 for 8) are caught.
        canonical = ".".join(str(int(octet)) for octet in literal.split("."))
        try:
            address = ipaddress.ip_address(canonical)
        except ValueError:
            continue  # e.g. 999.1.1.1
        if address.is_global and canonical not in _PUBLIC_IPV4_ALLOWLIST:
            found.append(literal)
    return sorted(set(found))


def _public_tree_violations(root: Path) -> list[str]:
    # Public IPv4 literals are caught by _public_ipv4_literals; skipped blobs get _SERVER_IPV4_MARKERS.
    forbidden = (
        ("hound" + "stooth").encode(),
        ("digitalocean" + "spaces.com").encode(),
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
        markers: tuple[bytes, ...] = forbidden
        if _skips_ipv4_scan(relative, content):
            markers = (*forbidden, *_SERVER_IPV4_MARKERS)
        content = content.lower()
        for marker in markers:
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
    ip = "8.8." + "4.4"
    # v{ip} proves the leading boundary, {ip}.5 the trailing one, 1.{ip} the dotted-run
    # lookbehind, and M8.5.2.1z compact SVG path data; each would fail if its guard broke.
    (tmp_path / "tracked.txt").write_text(
        "127.0.0.1 10.0.0.5 192.168.1.10 172.16.0.1 203.0.113.7 198.51.100.2 "
        f"0.0.0.0 1.1.1.1 9.9.9.9 1.2.3.4 999.1.1.1 v{ip} {ip}.5 1.{ip} M8.5.2.1z\n"
    )
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == []


def test_public_tree_skips_lockfiles_assets_and_binary_blobs_for_ipv4(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ip = "8.8." + "4.4"
    skipped = (
        "uv.lock",
        "poetry.lock",
        "package-lock.json",
        "icons.svg",
        "app.js.map",
        "vendor.min.js",
    )
    for name in skipped:
        (tmp_path / name).write_text(f"version {ip}\n")
    # The first NUL sits past 8 KiB; the blob is still binary.
    (tmp_path / "late.bin").write_bytes(ip.encode() + b"x" * 9000 + b"\0")
    subprocess.run(["git", "add", *skipped, "late.bin"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == []


def test_public_ipv4_literals_matches_sentence_final_padded_and_underscore_joined() -> None:
    ip = "8.8." + "4.4"
    padded = "008.008." + "004.004"
    assert _public_ipv4_literals(Path("a.md"), f"The relay lives at {ip}.".encode()) == [ip]
    assert _public_ipv4_literals(Path("a.md"), f"relay {padded}\n".encode()) == [padded]
    assert _public_ipv4_literals(Path("a.env"), f"RELAY_{ip}\n".encode()) == [ip]
    assert _public_ipv4_literals(Path("a.env"), f"{ip}_prod\n".encode()) == [ip]


def test_public_ipv4_literals_deduplicates() -> None:
    ip = "8.8." + "4.4"
    assert _public_ipv4_literals(Path("a.md"), f"{ip} {ip}".encode()) == [ip]


def test_public_tree_flags_known_server_ipv4_in_skipped_blobs(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    server = "138.68." + "214.23"
    (tmp_path / "icons.svg").write_text(f"<svg>{server}</svg>\n")
    (tmp_path / "uv.lock").write_text(f'url = "{server}"\n')
    (tmp_path / "blob.bin").write_bytes(server.encode() + b"\0")
    subprocess.run(["git", "add", "icons.svg", "uv.lock", "blob.bin"], cwd=tmp_path, check=True)
    assert sorted(_public_tree_violations(tmp_path)) == [
        f"blob.bin: {server}",
        f"icons.svg: {server}",
        f"uv.lock: {server}",
    ]


def test_public_tree_reports_known_server_ipv4_once_in_text(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    server = "216.40." + "34.41"
    (tmp_path / "notes.md").write_text(f"relay {server}\n")
    subprocess.run(["git", "add", "notes.md"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == [f"notes.md: public IPv4 literal {server}"]
