"""Credential scanning stays enabled; the public tree carries no private markers or public IPs."""

from __future__ import annotations

import ipaddress
import os
import plistlib
import re
import subprocess
import time
import tomllib
from pathlib import Path

import pytest

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "secret-scan.yml"
GITLEAKS_CONFIG = ROOT / ".gitleaks.toml"
_PIN_MODULES = (
    "src/podcast_mcp/engines/models/whisper.py",
    "src/podcast_mcp/engines/models/word_aligner.py",
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
# A ``../<name>`` path in docs, scripts and config names a directory beside the checkout when no
# tracked path anywhere carries that name, so it points outside the public tree. Source code is
# excluded: tests and fixtures use ``../x`` as path-traversal input. The reported line never echoes
# the name, which may belong to a private repository. Write ``../<your-overlay>`` in examples.
_SIBLING_SCAN_SUFFIXES = (".md", ".mdc", ".yml", ".yaml", ".toml", ".json", ".txt", ".sh")
_SIBLING_SCAN_NAMES = frozenset({"Makefile"})
_SIBLING_PATH = re.compile(rb"(?<![\w./~-])(?:\.\./)+([A-Za-z0-9_@][A-Za-z0-9_@.-]*)")

# Apple Developer Team ID (10 uppercase alphanumerics). A bare 10-character token is far too common
# (hashes, keys, identifiers), so the check is keyed to context and to the files that carry
# distribution identity. Contexts: a key or flag naming the team (``team`` anywhere in the name:
# DEVELOPMENT_TEAM, APPLE_TEAM, teamID, ``--team-id``, fastlane ``team_id "X"``/``team:``), an
# optional chain of ``${VAR:-`` defaults, a ``Developer ID ...: Name (TEAM)`` signing identity, an
# app-group ``group.<TEAM>``, and the ``<TEAM>.<reverse-dns>`` form of appID / keychain identifiers.
# Placeholders (AAAAAAAAAA, ``${...}``, ``{{...}}`` templates, words such as TEAMID) never match the
# shape: one letter and one digit among exactly 10 uppercase alphanumerics, not glued to more.
# Every quantifier is bounded so a long single line cannot make a scan quadratic.
_TEAM_ID = rb"(?=[A-Z0-9]{0,9}[A-Z])(?=[A-Z0-9]{0,9}[0-9])[A-Z0-9]{10}(?![A-Za-z0-9])"
_TEAM_ID_ASSIGNMENT = re.compile(
    rb"(?i:team)[\w\"'-]{0,24}"
    rb"(?:</key>\s*<string>|:-|\s*[:=(]\s*|\s+)"
    rb"[\"']?(?:\$\{\w{1,40}:-){0,4}[\"']?(" + _TEAM_ID + rb")"
)
_TEAM_ID_SIGNING_IDENTITY = re.compile(
    rb"(?i:developer id (?:application|installer)|apple (?:development|distribution)"
    rb"|(?:iphone|mac) (?:developer|distribution)):[^\n()]{0,80}\((" + _TEAM_ID + rb")\)"
)
_TEAM_ID_APP_GROUP = re.compile(rb"(?<![A-Za-z0-9])group\.(" + _TEAM_ID + rb")")
_TEAM_ID_BUNDLE = re.compile(
    rb"(?<![A-Za-z0-9])(" + _TEAM_ID + rb")\.(?:com|org|net|io|co|dev|me|studio|science|ai)"
    rb"\.[a-z][a-z0-9.-]{0,100}"
)
_TEAM_ID_PATTERNS = (
    _TEAM_ID_ASSIGNMENT,
    _TEAM_ID_SIGNING_IDENTITY,
    _TEAM_ID_APP_GROUP,
    _TEAM_ID_BUNDLE,
)
_TEAM_ID_SCAN_ROOTS = frozenset({"config", "distribution", "scripts", ".github"})
_TEAM_ID_ROOT_FILE = "project.yml"
_TEAM_ID_SCAN_SUFFIXES = (
    ".yml",
    ".yaml",
    ".json",
    ".sh",
    ".py",
    ".toml",
    ".pbxproj",
    ".xcconfig",
    ".ps1",
    ".rb",
    ".swift",
    ".cfg",
    ".ini",
    ".mjs",
    ".js",
)
# ``ghcr.io/<owner>/`` anywhere in the tree names a container image published by that owner, so a
# default pointing at one would ship the owner's registry to every user. Placeholders (``<owner>``,
# ``${{ ... }}``, ``example`` or ``example-*``) do not match. A real upstream image is listed by
# owner (lowercase) with a reason.
_OWNER_IMAGE = re.compile(rb"ghcr\.io/([A-Za-z0-9][A-Za-z0-9._-]*)/", re.IGNORECASE)
_UPSTREAM_IMAGE_OWNERS: dict[str, str] = {}
_PLACEHOLDER_IMAGE_OWNER = re.compile(r"example(?:[-_.].*)?")
# Hosts the owner runs. In test sources they are generic fixtures that tie a test to the owner's
# deployment; use ``*.example.test``. Matching is case-insensitive on a host boundary (a longer
# name such as ``x<host>`` does not match). A file that must pin a production URL is listed per
# (file, host) with a reason; each entry must still match.
_OWNER_FIXTURE_HOSTS = ("sudo." + "science", "cdn.sharecut." + "studio")
_OWNER_HOST_FIXTURE_ALLOWLIST: dict[tuple[str, str], str] = {
    ("tests/test_asset_sources.py", "cdn.sharecut." + "studio"): (
        "pins the production bootstrap CDN base against the private distribution profile"
    ),
    ("tests/test_cli_bootstrap.py", "cdn.sharecut." + "studio"): (
        "asserts the exact production speaker-model download URL"
    ),
    ("tests/test_desktop_pack_scripts.py", "cdn.sharecut." + "studio"): (
        "asserts the desktop shell source never embeds the production CDN base"
    ),
    ("tests/test_ffmpeg_payload.py", "cdn.sharecut." + "studio"): (
        "asserts the owner CDN base is accepted for the FFmpeg payload and never embedded in its source"
    ),
    ("tests/test_owner_cdn.py", "cdn.sharecut." + "studio"): (
        "pins the single documented first-party CDN host and the files allowed to name it"
    ),
    ("tests/test_speaker_ecapa_onnx.py", "cdn.sharecut." + "studio"): (
        "asserts the exact production speaker-model URLs"
    ),
}
_TEST_DIRS = frozenset({"tests", "__tests__", "e2e"})
_TEST_DIR_SUFFIXES = (".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".sh")
_TEST_NAME_SUFFIXES = (".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs")
_RUST_TEST_MODULE = b"#[cfg(test)]"


def test_secret_scan_covers_changes_and_scheduled_history() -> None:
    data = load_github_yaml(WORKFLOW)
    triggers = data["on"]
    assert "pull_request" in triggers
    assert triggers["push"]["branches"] == ["develop", "main"]
    assert "branches" not in triggers["pull_request"]
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


def test_gitleaksignore_holds_only_exact_fingerprints() -> None:
    lines = (ROOT / ".gitleaksignore").read_text(encoding="utf-8").splitlines()
    entries = [ln for ln in lines if ln.strip() and not ln.startswith("#")]
    assert len(entries) == 14
    assert frozenset(entries) == frozenset(
        {
            "0c5d8a26d75ad65cf4485665431a5f4104715a56:tests/test_promote.py:generic-api-key:864",
            "2afe4ec4cc58829c05b223b7354debad6309848d:gui/web/src/stage/hosts/DeliverHostPeaks.test.tsx:generic-api-key:20",
            "2afe4ec4cc58829c05b223b7354debad6309848d:gui/web/src/stage/hosts/useEpisodePeaks.test.tsx:generic-api-key:7",
            "b9b714106ce3e0a42778584837fbf64dde587a51:gui/web/src/edit/clipBleedSession.test.ts:generic-api-key:41",
            "11dadef6150dda3e602070d55aa0ccc402de716f:proof/2149/clock-failure-detail/sha256.json:generic-api-key:2",
            "64bb6b727f4e2c59b49e5e00498541fc5cab0b2b:proof/2149/preinput-chronology/sha256.json:generic-api-key:2",
            "4e589b6071dbc85fb7ecf46ae8083dbe4f3cc6cb:tests/test_list_clips_recording.py:generic-api-key:79",
            "4e589b6071dbc85fb7ecf46ae8083dbe4f3cc6cb:tests/test_list_clips_recording.py:generic-api-key:80",
            "76e977546698cbbe5628c1c9279919610a31bf20:src/podcast_mcp/whisper_models.py:generic-api-key:105",
            "76e977546698cbbe5628c1c9279919610a31bf20:src/podcast_mcp/whisper_models.py:generic-api-key:109",
            "76e977546698cbbe5628c1c9279919610a31bf20:src/podcast_mcp/whisper_models.py:generic-api-key:110",
            "23c03edcc985ba980dc9e94ed085129f4d76b58c:src/podcast_mcp/whisper_models.py:generic-api-key:95",
            "23c03edcc985ba980dc9e94ed085129f4d76b58c:src/podcast_mcp/whisper_models.py:generic-api-key:152",
            "23c03edcc985ba980dc9e94ed085129f4d76b58c:src/podcast_mcp/whisper_models.py:generic-api-key:163",
        }
    )
    for entry in entries:
        assert re.fullmatch(r"[0-9a-f]{40}:[^:\s]+:generic-api-key:\d+", entry), entry


def test_gitleaks_config_extends_defaults_with_scoped_digest_allowlists() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))

    assert config["extend"] == {"useDefault": True}
    assert "allowlist" not in config
    assert "allowlists" not in config

    assert [r["id"] for r in config["rules"]] == ["generic-api-key"]
    rule = config["rules"][0]
    assert "regex" not in rule  # inherits the default detector

    assert len(rule["allowlists"]) == 2
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


def test_gitleaks_document_certificates_allow_only_exact_public_fixture_values() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))
    allow = config["rules"][0]["allowlists"][1]
    assert allow["condition"] == "AND"
    assert allow["regexTarget"] == "line"
    paths = [
        f"tests/fixtures/document_delta/{name}.json"
        for name in ("small-move", "small-word", "small-regroup")
    ]
    assert len(allow["paths"]) == 3
    for path in paths:
        assert any(re.fullmatch(pattern, path) for pattern in allow["paths"])
        lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
        certificates = [line for line in lines if '"base_token"' in line]
        assert len(certificates) == 1
        assert any(re.search(pattern, certificates[0]) for pattern in allow["regexes"])
        api_line = certificates[0].replace('"base_token"', '"api_key"')
        assert not any(re.search(pattern, api_line) for pattern in allow["regexes"])
    for path in (
        "src/podcast_mcp/api.py",
        "tests/fixtures/document_delta/new.json",
        "tests/fixtures/document_delta/small-word.json.backup",
    ):
        assert not any(re.fullmatch(pattern, path) for pattern in allow["paths"])
    unknown = '"base_token": "' + "0123456789abcdef" * 4 + '",'
    assert not any(re.search(pattern, unknown) for pattern in allow["regexes"])


def test_every_model_pin_line_is_allowlisted_or_standalone() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))
    regexes = config["rules"][0]["allowlists"][0]["regexes"]
    standalone = re.compile(r'^\s*"[0-9a-f]{64}",?\s*$')

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


def test_model_pin_modules_carry_no_inline_gitleaks_suppressions() -> None:
    # .gitleaks.toml is the one allowlist; inline `gitleaks:allow` would bypass its scope.
    for module in _PIN_MODULES:
        assert "gitleaks:allow" not in (ROOT / module).read_text(encoding="utf-8"), module


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


def _sibling_path_candidates(relative: Path, content: bytes) -> list[tuple[int, str]]:
    """Return (line, first segment) of each ``../<name>`` path in a docs, script or config blob."""
    if relative.suffix not in _SIBLING_SCAN_SUFFIXES and relative.name not in _SIBLING_SCAN_NAMES:
        return []
    found: list[tuple[int, str]] = []
    for match in _SIBLING_PATH.finditer(content):
        line = content.count(b"\n", 0, match.start()) + 1
        found.append((line, match.group(1).decode().rstrip(".-")))
    return found


def _is_team_id_surface(relative: Path) -> bool:
    """Distribution config, Tauri/iOS identity files, AASA, env files, scripts and workflows."""
    name = relative.name
    if name.startswith(("apple-app-site-association", ".env")) or name.endswith(".env"):
        return True
    if name == _TEAM_ID_ROOT_FILE and len(relative.parts) == 1:
        return True
    if relative.suffix in (".plist", ".entitlements"):
        return True
    if relative.parts[0] == "gui" and "src-tauri" in relative.parts:
        return name.endswith(_TEAM_ID_SCAN_SUFFIXES)
    return relative.parts[0] in _TEAM_ID_SCAN_ROOTS and name.endswith(_TEAM_ID_SCAN_SUFFIXES)


def _team_id_text(content: bytes) -> bytes:
    """Normalise binary-ish blobs to ASCII-searchable text.

    A binary plist is flattened to ``key = value`` lines, UTF-16 (BOM) is decoded, and stray NULs
    (BOM-less UTF-16, a leading NUL) are stripped, so none of them hides a Team ID.
    """
    if content.startswith(b"bplist00"):
        try:
            return _flatten_plist(plistlib.loads(content), "").encode()
        except Exception:  # malformed plist: fall back to raw bytes
            return content.replace(b"\0", b"")
    if content.startswith((b"\xff\xfe", b"\xfe\xff")):
        return content.decode("utf-16", errors="replace").encode()
    return content.replace(b"\0", b"")


def _flatten_plist(node: object, key: str) -> str:
    if isinstance(node, dict):
        return "".join(_flatten_plist(v, str(k)) for k, v in node.items())
    if isinstance(node, list):
        return "".join(_flatten_plist(v, key) for v in node)
    return f"{key} = {node}\n" if isinstance(node, str) else ""


def _team_id_lines(relative: Path, content: bytes) -> list[int]:
    """Return line numbers holding a real-looking Team ID in a named or ``<TEAM>.<bundle>`` form."""
    if not _is_team_id_surface(relative):
        return []
    content = _team_id_text(content)
    lines: set[int] = set()
    for pattern in _TEAM_ID_PATTERNS:
        for match in pattern.finditer(content):
            lines.add(content.count(b"\n", 0, match.start(1)) + 1)
    return sorted(lines)


def _owner_image_lines(content: bytes) -> list[int]:
    upstream = {owner.lower() for owner in _UPSTREAM_IMAGE_OWNERS}
    lines: list[int] = []
    for match in _OWNER_IMAGE.finditer(content):
        owner = match.group(1).decode().lower()
        if _PLACEHOLDER_IMAGE_OWNER.fullmatch(owner) or owner in upstream:
            continue
        lines.append(content.count(b"\n", 0, match.start()) + 1)
    return lines


def _owner_host_pattern(host: str) -> re.Pattern[bytes]:
    return re.compile(
        rb"(?<![A-Za-z0-9-])" + re.escape(host.encode()) + rb"(?![A-Za-z0-9-])", re.IGNORECASE
    )


def _is_test_source(relative: Path, content: bytes) -> tuple[bool, int]:
    """Return (is a test source, byte offset where the test part starts)."""
    name = relative.name
    in_test_dir = any(part in _TEST_DIRS for part in relative.parts[:-1])
    by_name = name.endswith(_TEST_NAME_SUFFIXES) and (
        name.startswith("test_") or ".test." in name or ".spec." in name
    )
    if in_test_dir and name.endswith(_TEST_DIR_SUFFIXES):
        return True, 0
    if relative.suffix == ".rs":  # unit tests live in a trailing #[cfg(test)] module
        start = content.find(_RUST_TEST_MODULE)
        return start >= 0, max(start, 0)
    return by_name, 0


def _owner_host_hits(content: bytes, start: int = 0) -> list[tuple[str, int]]:
    return [
        (host, match.start())
        for host in _OWNER_FIXTURE_HOSTS
        for match in _owner_host_pattern(host).finditer(content, start)
    ]


def _owner_host_fixture_lines(relative: Path, content: bytes) -> list[int]:
    is_test_source, start = _is_test_source(relative, content)
    if not is_test_source:
        return []
    posix = relative.as_posix()
    return sorted(
        {
            content.count(b"\n", 0, offset) + 1
            for host, offset in _owner_host_hits(content, start)
            if (posix, host) not in _OWNER_HOST_FIXTURE_ALLOWLIST
        }
    )


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
    tracked_names = {
        part for raw_relative, _, _ in entries for part in Path(os.fsdecode(raw_relative)).parts
    }
    sibling_candidates: list[tuple[Path, int, str]] = []
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
        for line, name in _sibling_path_candidates(relative, content):
            sibling_candidates.append((relative, line, name))
        for literal in _public_ipv4_literals(relative, content):
            hits.append(f"{relative}: public IPv4 literal {literal}")
        for line in _team_id_lines(relative, content):
            hits.append(f"{relative}:{line}: Apple Team ID outside a placeholder")
        for line in _owner_image_lines(content):
            hits.append(f"{relative}:{line}: owner container-image reference")
        for line in _owner_host_fixture_lines(relative, content):
            hits.append(f"{relative}:{line}: owner host used as a test fixture")
        markers: tuple[bytes, ...] = forbidden
        if _skips_ipv4_scan(relative, content):
            markers = (*forbidden, *_SERVER_IPV4_MARKERS)
        content = content.lower()
        for marker in markers:
            if marker.lower() in content:
                hits.append(f"{relative}: {marker.decode()}")

    for relative, line, name in sibling_candidates:
        if name not in tracked_names:
            hits.append(f"{relative}:{line}: sibling-repo path outside the public tree")
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


def test_public_tree_reports_ipv4_just_outside_the_172_private_block(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ip = "172.32." + "0.1"
    (tmp_path / "tracked.txt").write_text(f"172.31.255.1 {ip}\n")
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True)
    assert _public_tree_violations(tmp_path) == [f"tracked.txt: public IPv4 literal {ip}"]


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


_SIBLING_VIOLATION = "docs/guide.md:1: sibling-repo path outside the public tree"


def _tracked_repo(root: Path, files: dict[str, str]) -> None:
    _init_git_repo(root)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", "--", *files], check=True)


def test_public_tree_reports_sibling_repo_path_in_docs_and_scripts(tmp_path: Path) -> None:
    profile = "PODCAST_DISTRIBUTION_PROFILE=../acme-overlay/config/distribution.production.json"
    _tracked_repo(
        tmp_path,
        {
            "docs/guide.md": profile + " \\\n  make build\n",
            "scripts/run.sh": "cd ../acme-overlay && ./go\n",
            "Makefile": "build:\n\tcp ../../acme-overlay/x .\n",
        },
    )

    assert sorted(_public_tree_violations(tmp_path)) == [
        "Makefile:2: sibling-repo path outside the public tree",
        _SIBLING_VIOLATION,
        "scripts/run.sh:1: sibling-repo path outside the public tree",
    ]


def test_public_tree_sibling_violation_names_the_location_not_the_sibling(tmp_path: Path) -> None:
    _tracked_repo(tmp_path, {"docs/guide.md": "run ../acme-overlay/bin/tool\n"})

    assert _public_tree_violations(tmp_path) == [_SIBLING_VIOLATION]


def test_public_tree_allows_in_tree_relative_links_and_placeholders(tmp_path: Path) -> None:
    _tracked_repo(
        tmp_path,
        {
            "docs/guide.md": (
                "[script](../scripts/run.sh) [web](../gui/web/README.md) "
                "profile ../<your-overlay>/dist.json parent ../.. "
                "nested a/../b and ./../c and https://example.test/../d\n"
            ),
            "scripts/run.sh": "echo hi\n",
            "gui/web/README.md": "web\n",
        },
    )

    assert _public_tree_violations(tmp_path) == []


def test_public_tree_sibling_scan_skips_source_code_traversal_fixtures(tmp_path: Path) -> None:
    _tracked_repo(
        tmp_path,
        {
            "tests/test_paths.py": 'BAD = "../acme-overlay/x"\n',
            "gui/web/src/a.test.ts": 'const bad = "../acme-overlay/x"\n',
        },
    )

    assert _public_tree_violations(tmp_path) == []


def test_public_tree_has_no_sibling_repo_paths() -> None:
    hits = [hit for hit in _public_tree_violations(ROOT) if "sibling-repo path" in hit]
    assert not hits, "sibling-repo paths remain:\n" + "\n".join(hits)


# A seeded Team ID: the real shape (10 uppercase alphanumerics, mixed), never a real team.
_SEEDED_TEAM = "Q7" + "ZK3M9" + "PX2"
_TEAM_VIOLATION = "{path}:{line}: Apple Team ID outside a placeholder"
_GHCR = "ghcr" + ".io/"
_IMAGE_VIOLATION = "{path}:{line}: owner container-image reference"
_HOST_VIOLATION = "{path}:{line}: owner host used as a test fixture"
_OWNER = "sudo." + "science"
_CDN = "cdn.sharecut." + "studio"


def _team_lines(path: str, text: str, team: str = _SEEDED_TEAM) -> list[int]:
    return _team_id_lines(Path(path), text.format(team=team).encode())


def test_public_tree_reports_apple_team_id_in_each_distribution_surface(tmp_path: Path) -> None:
    _tracked_repo(
        tmp_path,
        {
            "config/distribution.prod.json": f'{{"appleTeamId": "{_SEEDED_TEAM}"}}\n',
            "gui/desktop/src-tauri/tauri.conf.json": f'{{"developmentTeam": "{_SEEDED_TEAM}"}}\n',
            "gui/desktop/src-tauri/Info.plist": (
                f"<dict>\n<key>TeamIdentifier</key>\n<string>{_SEEDED_TEAM}</string>\n</dict>\n"
            ),
            "docs-site/.well-known/apple-app-site-association": (
                f'{{"applinks": {{"details": [{{"appIDs": ["{_SEEDED_TEAM}.com.acme.app"]}}]}}}}\n'
            ),
            "scripts/build.sh": f"export DEVELOPMENT_TEAM={_SEEDED_TEAM}\n",
            ".github/workflows/ship.yml": f"env:\n  APPLE_TEAM_ID: {_SEEDED_TEAM}\n",
        },
    )

    violations = sorted(_public_tree_violations(tmp_path))
    assert violations == sorted(
        [
            _TEAM_VIOLATION.format(path=".github/workflows/ship.yml", line=2),
            _TEAM_VIOLATION.format(path="config/distribution.prod.json", line=1),
            _TEAM_VIOLATION.format(path="docs-site/.well-known/apple-app-site-association", line=1),
            _TEAM_VIOLATION.format(path="gui/desktop/src-tauri/Info.plist", line=3),
            _TEAM_VIOLATION.format(path="gui/desktop/src-tauri/tauri.conf.json", line=1),
            _TEAM_VIOLATION.format(path="scripts/build.sh", line=1),
        ]
    )
    assert not any(_SEEDED_TEAM in violation for violation in violations)


@pytest.mark.parametrize("root", sorted(_TEAM_ID_SCAN_ROOTS))
def test_team_id_scan_covers_each_root(root: str) -> None:
    assert _team_lines(f"{root}/x.yml", "DEVELOPMENT_TEAM: {team}\n") == [1]


@pytest.mark.parametrize("suffix", _TEAM_ID_SCAN_SUFFIXES)
def test_team_id_scan_covers_each_suffix_in_a_root_and_in_src_tauri(suffix: str) -> None:
    text = "x\nDEVELOPMENT_TEAM = {team}\n"
    assert _team_lines(f"scripts/sign{suffix}", text) == [2]
    assert _team_lines(f"gui/desktop/src-tauri/gen/sign{suffix}", text) == [2]


@pytest.mark.parametrize(
    "path",
    [
        "ios/Info.plist",
        "deploy/x.entitlements",
        "docs-site/apple-app-site-association",
        "docs-site/apple-app-site-association.json",
        ".env",
        "deploy/.env.production",
        "scripts/prod.env",
        "project.yml",
    ],
)
def test_team_id_scan_covers_identity_files_outside_the_roots(path: str) -> None:
    assert _team_lines(path, "DEVELOPMENT_TEAM={team}\n") == [1]


@pytest.mark.parametrize(
    "path",
    ["docs/notes.md", "tests/test_x.py", "deploy/run.sh", "gui/web/project.yml", "scripts/a.txt"],
)
def test_team_id_scan_skips_other_files(path: str) -> None:
    assert _team_lines(path, "DEVELOPMENT_TEAM={team}\n") == []


@pytest.mark.parametrize(
    "text",
    [
        '{{"appleTeamId": "{team}"}}',
        "APPLE_DEVELOPMENT_TEAM={team}",
        'export T="${{APPLE_DEVELOPMENT_TEAM:-{team}}}"',
        'export DEV_TEAM="${{A:-${{B:-{team}}}}}"',
        "APPLE_TEAM={team}",
        "DEV_TEAM={team}",
        "xcodebuild --team-id {team}",
        'team_id("{team}")',
        'team_id "{team}"',
        "team_id '{team}'",
        "team: {team}",
        'team: "{team}"',
        '"signingIdentity": "Developer ID Application: Acme Inc ({team})"',
        'id = "Apple Distribution: Acme Inc ({team})"',
        "com.apple.security.application-groups: group.{team}.shared",
        "{team}.com.acme.app",
        "keychain-access-groups: {team}.org.acme.keys",
    ],
)
def test_team_id_forms_are_reported(text: str) -> None:
    assert _team_lines("scripts/x.sh", text + "\n") == [1]


def test_team_id_cross_line_value_reports_the_value_line() -> None:
    assert _team_lines("scripts/x.yml", "TEAM_ID:\n  {team}\n") == [2]


@pytest.mark.parametrize(
    "text",
    [
        "APP_ID=GH1234ABCD",
        '{{"app_id": "AB12CD34EF"}}',
        'appId: "GH1234ABCD"',
        "ABCDEFGH12.app.tar",
        "ABCDEFGH12.app",
        "tmp/ABCDEFGH12.txt",
        "DEVELOPMENT_TEAM=AAAAAAAAAA",
        "DEVELOPMENT_TEAM=TEAMID",
        "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
        "DEVELOPMENT_TEAM={{apple.development-team}}",
        "export DEV_TEAM=${{T:-AAAAAAAAAA}}",
        "Developer ID Application: Acme Inc (TEAMID)",
        "group.TEAMID.shared",
        "DEVELOPMENT_TEAM=q7zk3m9px2",
    ],
)
def test_team_id_non_matches(text: str) -> None:
    assert _team_lines("scripts/x.sh", text + "\n") == []


@pytest.mark.parametrize(
    ("value", "reported"),
    [
        ("Q7ZK3M9PX2", True),
        ("1234567890", False),  # digits only: the letter lookahead
        ("ABCDEFGHIJ", False),  # letters only: the digit lookahead
        ("Q7ZK3M9PX", False),  # 9 characters
        ("Q7ZK3M9PX21", False),  # 11 characters: the trailing boundary
        ("Q7ZK3M9PXz", False),  # trailing lowercase letter: the trailing boundary
        ("1111111111", False),
    ],
)
def test_team_id_shape_needs_ten_characters_with_a_letter_and_a_digit(
    value: str, reported: bool
) -> None:
    assert _team_lines("scripts/x.sh", "DEVELOPMENT_TEAM={team}\n", value) == (
        [1] if reported else []
    )
    assert _team_lines("scripts/x.sh", "{team}.com.acme.app\n", value) == ([1] if reported else [])


def test_team_id_bundle_form_needs_a_leading_boundary() -> None:
    assert _team_lines("scripts/x.sh", "x{team}.com.acme.app\n") == []


def test_team_id_scan_is_linear_on_long_lines() -> None:
    lines = [
        b"teamID" * 20000,
        b"team " * 20000,
        b"TEAM_ID=${A:-" * 5000,
        b"Developer ID Application: " * 5000,
        b"group." * 20000,
        b"A1" * 60000,
        b"team=" + b"A" * 120000,
    ]
    for line in lines:
        started = time.perf_counter()
        assert _team_id_lines(Path("scripts/x.sh"), line) == []
        assert time.perf_counter() - started < 2.0, line[:12]


def test_team_id_scan_reads_nul_padded_utf16_and_binary_plists() -> None:
    xml = f"<plist><dict><key>TeamIdentifier</key><string>{_SEEDED_TEAM}</string></dict></plist>\n"
    path = Path("ios/Info.plist")
    assert _team_id_lines(path, xml.encode("utf-16")) == [1]  # BOM
    assert _team_id_lines(path, xml.encode("utf-16-le")) == [1]  # no BOM, NUL-padded
    assert _team_id_lines(path, b"\0" + xml.encode()) == [1]
    binary = plistlib.dumps({"TeamIdentifier": _SEEDED_TEAM}, fmt=plistlib.FMT_BINARY)
    assert b"\0" in binary
    assert _team_id_lines(path, binary) == [1]
    nested = plistlib.dumps(
        {"a": {"TeamIdentifier": [_SEEDED_TEAM]}, "n": 1}, fmt=plistlib.FMT_BINARY
    )
    assert _team_id_lines(path, nested) == [1]
    assert _team_id_lines(path, b"bplist00\0garbage") == []
    assert _team_id_lines(path, plistlib.dumps({"TeamIdentifier": "AAAAAAAAAA"})) == []


def test_public_tree_allows_team_id_placeholders_and_unrelated_ten_char_tokens(
    tmp_path: Path,
) -> None:
    _tracked_repo(
        tmp_path,
        {
            "scripts/sim.sh": 'export APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-AAAAAAAAAA}"\n',
            "scripts/doc.sh": "APPLE_TEAM_ID=TEAMID\nDEVELOPMENT_TEAM={{apple.development-team}}\n",
            ".github/workflows/ship.yml": (
                "env:\n  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n  KEY: ABCDEFGHJK\n"
            ),
            "scripts/other.py": f'DIGEST = "{_SEEDED_TEAM}"\nname = "{_SEEDED_TEAM}.txt"\n',
            "gui/desktop/src-tauri/tauri.conf.json": '{"identifier": "com.example.app"}\n',
            # Same shape outside the scanned distribution surfaces: not a Team ID context.
            "docs/notes.md": f"APPLE_TEAM_ID={_SEEDED_TEAM}\n",
            "tests/test_x.py": f'TEAM = "{_SEEDED_TEAM}"\nteamID = "{_SEEDED_TEAM}"\n',
        },
    )

    assert _public_tree_violations(tmp_path) == []


def test_public_tree_reports_owner_container_image_default(tmp_path: Path) -> None:
    _tracked_repo(
        tmp_path,
        {
            "scripts/run.sh": f'IMAGE="${{IMAGE:-{_GHCR}acme-owner/studio:latest}}"\n',
            "deploy/compose.yml": f"services:\n  a:\n    image: {_GHCR.upper()}Acme-Owner/relay\n",
            ".github/workflows/x.yml": f"env:\n  IMAGE: {_GHCR}${{{{ github.repository }}}}\n",
            "docs/pull.md": f"docker pull {_GHCR}<owner>/studio and {_GHCR}example/x\n",
            "docs/other.md": f"{_GHCR}example-org/x {_GHCR}example_org/x {_GHCR}EXAMPLE/x\n",
        },
    )

    assert sorted(_public_tree_violations(tmp_path)) == [
        _IMAGE_VIOLATION.format(path="deploy/compose.yml", line=3),
        _IMAGE_VIOLATION.format(path="scripts/run.sh", line=1),
    ]


@pytest.mark.parametrize("owner", ["examplecorp", "example2", "examples", "myexample", "evilcorp"])
def test_container_image_example_exemption_is_the_placeholder_only(owner: str) -> None:
    assert _owner_image_lines(f"{_GHCR}{owner}/x\n".encode()) == [1]


def test_public_tree_allows_container_image_owner_listed_with_a_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert all(reason.strip() for reason in _UPSTREAM_IMAGE_OWNERS.values())
    _tracked_repo(tmp_path, {"scripts/run.sh": f"docker pull {_GHCR}upstream-org/tool:1\n"})
    assert _public_tree_violations(tmp_path) == [
        _IMAGE_VIOLATION.format(path="scripts/run.sh", line=1)
    ]

    # Keys are compared lowercase, so a mixed-case key still matches.
    monkeypatch.setitem(_UPSTREAM_IMAGE_OWNERS, "Upstream-Org", "upstream project's own image")
    assert _public_tree_violations(tmp_path) == []


def test_public_tree_reports_owner_host_fixture_in_test_sources(tmp_path: Path) -> None:
    _tracked_repo(
        tmp_path,
        {
            "tests/test_a.py": f'ORIGIN = "https://{_OWNER}"\n',
            "gui/desktop/src-tauri/src/share_url.rs": (
                f'fn real() {{ let _ = "{_OWNER}"; }}\n#[cfg(test)]\nmod tests {{\n'
                f'    assert!(!ok("https://{_OWNER}/r/t"));\n}}\n'
            ),
            "gui/web/src/a.test.ts": f'const base = "https://{_CDN}/assets";\n',
            "tests/test_share_page.py": 'ORIGIN = "https://share.example.test"\n',
            "README.md": f"[privacy](https://{_OWNER}/privacy.html)\n",
        },
    )

    assert sorted(_public_tree_violations(tmp_path)) == [
        _HOST_VIOLATION.format(path="gui/desktop/src-tauri/src/share_url.rs", line=4),
        _HOST_VIOLATION.format(path="gui/web/src/a.test.ts", line=1),
        _HOST_VIOLATION.format(path="tests/test_a.py", line=1),
    ]


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_a.py",
        "tests/helpers.py",
        "tests/fixtures/share.json",
        "tests/fixtures/share.js",
        "tests/run.sh",
        "tests/a.mjs",
        "tests/a.ts",
        "tests/a.tsx",
        "tests/a.jsx",
        "tests/a.rs",
        "crates/x/tests/a.rs",
        "gui/web/src/__tests__/a.js",
        "gui/web/e2e/a.ts",
        "gui/web/src/a.test.ts",
        "gui/web/src/a.test.js",
        "gui/web/src/a.spec.ts",
        "gui/web/src/a.spec.mjs",
        "pkg/test_a.py",
    ],
)
def test_owner_host_is_reported_in_each_test_source_shape(path: str) -> None:
    assert _owner_host_fixture_lines(Path(path), f"x\n{_OWNER}\n".encode()) == [2]
    assert _owner_host_fixture_lines(Path(path), f"x\n{_CDN}\n".encode()) == [2]


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "docs/a.md",
        "src/podcast_mcp/a.py",
        "src/a.rs",
        "gui/web/src/a.ts",
        "gui/web/src/a.json",
        "tests/README.md",
        "tests/a.txt",
        "scripts/test.sh",
    ],
)
def test_owner_host_is_ignored_outside_test_sources(path: str) -> None:
    assert _owner_host_fixture_lines(Path(path), f"{_OWNER}\n".encode()) == []


def test_owner_host_match_is_case_insensitive_and_on_a_host_boundary() -> None:
    path = Path("tests/test_a.py")

    def lines(text: str) -> list[int]:
        return _owner_host_fixture_lines(path, text.encode())

    assert lines(f"https://{_OWNER.upper()}/x") == [1]
    assert lines(f"https://www.{_OWNER}/x") == [1]
    assert lines(f"{_OWNER}.example.test") == [1]
    assert lines(f"x{_OWNER}") == []
    assert lines(f"a-{_OWNER}") == []
    assert lines(f"{_OWNER}s") == []
    assert lines(f"{_OWNER}-x") == []


def test_owner_host_in_rust_counts_only_in_the_test_module() -> None:
    path = Path("gui/desktop/src-tauri/src/a.rs")
    prod = f'const A: &str = "{_OWNER}";\n'
    assert _owner_host_fixture_lines(path, prod.encode()) == []
    tail = f'#[cfg(test)]\nmod tests {{ const B: &str = "{_OWNER}"; }}\n'
    assert _owner_host_fixture_lines(path, (prod + tail).encode()) == [3]


def test_owner_host_allowlist_exempts_one_host_in_one_file() -> None:
    path = Path("tests/test_asset_sources.py")
    key = (path.as_posix(), _CDN)
    assert key in _OWNER_HOST_FIXTURE_ALLOWLIST
    assert _owner_host_fixture_lines(path, f"{_CDN}\n".encode()) == []
    assert _owner_host_fixture_lines(path, f"{_OWNER}\n".encode()) == [1]
    assert _owner_host_fixture_lines(Path("tests/test_other.py"), f"{_CDN}\n".encode()) == [1]


def test_owner_host_fixture_allowlist_entries_carry_reasons_and_still_match() -> None:
    assert _OWNER_HOST_FIXTURE_ALLOWLIST
    for (relative, host), reason in _OWNER_HOST_FIXTURE_ALLOWLIST.items():
        assert reason.strip(), relative
        assert host in _OWNER_FIXTURE_HOSTS, relative
        content = (ROOT / relative).read_bytes()
        assert _owner_host_pattern(host).search(content), f"{relative}: stale allowlist entry"


def test_public_tree_has_no_team_id_owner_image_or_owner_host_fixture() -> None:
    markers = ("Apple Team ID", "owner container-image", "owner host used")
    hits = [hit for hit in _public_tree_violations(ROOT) if any(m in hit for m in markers)]
    assert not hits, "boundary markers remain:\n" + "\n".join(hits)
