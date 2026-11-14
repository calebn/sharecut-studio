"""Acceptance: nothing derived from a link token rests in the project or exports folder.

A review link and a record link are minted with fixed tokens and used through the
HTTP and WebSocket routes (a record join, a take upload, a review guest action).
Every file of the project folder (the SQLite files with their ``-wal``, ``-shm``
and ``-journal``), every file of the exports folder and every member of the
diagnostics bundle is then searched for the token text, its prefixes, suffixes,
words and middle substrings (UTF-8, UTF-16 and hex), and for SHA-256 and HMAC
digests of each of those. A second pass reads every SQLite cell and the
``iterdump`` text, because a raw byte search misses a value split across an
overflow page. ``-shm`` holds only the WAL index and is scanned for completeness,
not as coverage.

The scanner is proven before it is trusted: a pristine project holds no needle
(a hit there fails loudly), planted tokens and a planted deleted row are all
reported, and the registry file outside the scanned roots does hold the tokens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import os
import sqlite3
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import lookup_share
from podcast_mcp.services.collaboration.share_registry import get_share_registry
from podcast_mcp.services.record import RecordLandingService
from podcast_mcp.services.record.service import reset_record_runtime_for_tests
from podcast_mcp.services.support.diagnostics import DiagnosticsService
from podcast_mcp.services.support.doctor import DoctorReport
from podcast_mcp.util import host_platform
from podcast_mcp.util.wav import pcm_wav_header

SQLITE_MAGIC = b"SQLite format 3\x00"
MIN_TEXT = 4
MIN_MIDDLE = 6
MIN_DIGEST_TEXT = 8
HEX = set("0123456789abcdef")

REVIEW_TOKEN = "zephyr-nimbus-ocelot"
GUEST_TOKEN = "velvet-quokka-umbra"
PRODUCER_TOKEN = "marble-tundra-pelican"
FIXED_SLUGS = [REVIEW_TOKEN, GUEST_TOKEN, PRODUCER_TOKEN]
TOKENS = tuple(FIXED_SLUGS)

Needles = dict[str, bytes]


def _words(token: str) -> list[str]:
    return [w for w in token.split("-") if len(w) >= MIN_TEXT]


def _pieces(token: str) -> set[str]:
    """The token and every prefix, suffix and word of ``MIN_TEXT`` or more characters."""
    found = {token, token.replace("-", "")}
    for size in range(MIN_TEXT, len(token) + 1):
        found.add(token[:size])
        found.add(token[-size:])
    found.update(_words(token))
    return found


def _middles(token: str) -> set[str]:
    return {token[i:j] for i in range(len(token)) for j in range(i + MIN_MIDDLE, len(token) + 1)}


def _forms(digest: bytes) -> dict[str, bytes]:
    return {
        "hex": digest.hex().encode(),
        "HEX": digest.hex().upper().encode(),
        "raw": digest,
        "b64": base64.b64encode(digest),
        "b64-nopad": base64.b64encode(digest).rstrip(b"="),
        "urlsafe": base64.urlsafe_b64encode(digest),
        "urlsafe-nopad": base64.urlsafe_b64encode(digest).rstrip(b"="),
    }


def build_needles(tokens: tuple[str, ...], secret: bytes) -> Needles:
    needles: Needles = {}
    for token in tokens:
        for text in _pieces(token) | _middles(token):
            raw = text.encode("utf-8")
            needles[f"text:{text}"] = raw
            needles[f"utf16le:{text}"] = text.encode("utf-16-le")
            needles[f"utf16be:{text}"] = text.encode("utf-16-be")
            needles[f"hex-of:{text}"] = raw.hex().encode()
            needles[f"b64-of:{text}"] = base64.b64encode(raw).rstrip(b"=")
        for text in _pieces(token):
            raw = text.encode("utf-8")
            for name, digest in (
                ("sha256", hashlib.sha256(raw).digest()),
                ("hmac", hmac.new(secret, raw, hashlib.sha256).digest()),
            ):
                for form, value in _forms(digest).items():
                    assert len(value) >= MIN_DIGEST_TEXT
                    needles[f"{name}-{form}:{text}"] = value
    for form, value in _forms(secret).items():
        needles[f"secret-{form}"] = value
    return {label: value for label, value in needles.items() if value}


def hits_in_bytes(data: bytes, needles: Needles) -> set[str]:
    return {label for label, needle in needles.items() if needle in data}


def _sqlite_values(path: Path) -> Iterator[str | bytes]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.text_factory = bytes
    try:
        for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            for row in conn.execute(f'SELECT * FROM "{name.decode()}"'):
                for cell in row:
                    if isinstance(cell, (bytes, bytearray)):
                        yield bytes(cell)
                    elif cell is not None:
                        yield str(cell)
    finally:
        conn.close()


def _sqlite_dump(path: Path) -> str:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return "\n".join(conn.iterdump())
    finally:
        conn.close()


def sqlite_schema_names(path: Path) -> list[str]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        names: list[str] = []
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            names.append(table)
            names.extend(row[1] for row in conn.execute(f'PRAGMA table_info("{table}")'))
        return names
    finally:
        conn.close()


def _is_sqlite(path: Path) -> bool:
    with path.open("rb") as fh:
        return fh.read(len(SQLITE_MAGIC)) == SQLITE_MAGIC


def _members(root: Path) -> Iterator[tuple[str, bytes]]:
    """Every file under ``root`` as bytes, with each zip also unpacked."""
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        data = path.read_bytes()
        name = str(path.relative_to(root))
        yield name, data
        if zipfile.is_zipfile(io.BytesIO(data)):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for inner in zf.namelist():
                    yield f"{name}!{inner}", zf.read(inner)


def scan_root(root: Path, needles: Needles) -> dict[str, set[str]]:
    """Needles found per file: a raw byte pass, then every SQLite cell and an ``iterdump``."""
    found: dict[str, set[str]] = {}
    for name, data in _members(root):
        hit = hits_in_bytes(data, needles)
        if hit:
            found.setdefault(name, set()).update(hit)
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        if path.suffix in {".sqlite", ".db"} or (path.stat().st_size and _is_sqlite(path)):
            name = str(path.relative_to(root))
            dump = _sqlite_dump(path).encode("utf-8")
            hit = hits_in_bytes(dump, needles)
            for value in _sqlite_values(path):
                hit |= hits_in_bytes(value if isinstance(value, bytes) else value.encode(), needles)
            if hit:
                found.setdefault(name + " (cells)", set()).update(hit)
    return found


def describe(found: dict[str, set[str]]) -> str:
    return "; ".join(
        f"{name}: {len(hit)} needles, e.g. {sorted(hit)[:3]}" for name, hit in sorted(found.items())
    )


def token_named_columns(root: Path) -> list[str]:
    bad: list[str] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and _is_sqlite(p)):
        bad.extend(
            f"{path.relative_to(root)}:{name}"
            for name in sqlite_schema_names(path)
            if "token" in name.lower()
        )
    return bad


def _checkpoint(root: Path) -> None:
    for path in sorted(p for p in root.rglob("*") if p.is_file() and _is_sqlite(p)):
        conn = sqlite3.connect(path)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()


def test_every_window_of_the_fixed_tokens_holds_a_non_hex_character() -> None:
    for token in TOKENS:
        for i in range(len(token) - MIN_TEXT + 1):
            assert set(token[i : i + MIN_TEXT]) - HEX, (token, i)


def test_the_scanner_reports_every_planted_form(tmp_path: Path) -> None:
    secret = bytes(range(32))
    needles = build_needles(TOKENS, secret)
    planted = tmp_path / "planted"
    planted.mkdir()
    (planted / "all.bin").write_bytes(b"\n".join(needles.values()))
    found = scan_root(planted, needles)
    assert set().union(*found.values()) == set(needles)

    cells = tmp_path / "cells"
    cells.mkdir()
    conn = sqlite3.connect(cells / "x.db")
    conn.execute("CREATE TABLE t (v)")
    conn.execute("INSERT INTO t VALUES (?)", (f"see {GUEST_TOKEN} here",))
    conn.execute("INSERT INTO t VALUES (?)", (hashlib.sha256(GUEST_TOKEN.encode()).hexdigest(),))
    conn.commit()
    conn.close()
    cell_hits = scan_root(cells, needles)
    assert f"text:{GUEST_TOKEN}" in cell_hits["x.db (cells)"]
    assert f"sha256-hex:{GUEST_TOKEN}" in cell_hits["x.db (cells)"]


def test_the_scanner_finds_a_deleted_row_left_in_a_free_page(tmp_path: Path) -> None:
    needles = build_needles(TOKENS, bytes(range(32)))
    conn = sqlite3.connect(tmp_path / "gone.db")
    conn.execute("PRAGMA secure_delete = OFF")
    conn.execute("CREATE TABLE t (v)")
    conn.execute("INSERT INTO t VALUES (?)", (GUEST_TOKEN * 3,))
    conn.commit()
    conn.execute("DELETE FROM t")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    found = scan_root(tmp_path, needles)
    assert f"text:{GUEST_TOKEN}" in found["gone.db"]
    assert "gone.db (cells)" not in found


@dataclass
class Scene:
    client: TestClient
    project: Path
    ws: ProjectWorkspace
    workspace: Path
    exports: Path
    needles: Needles

    def host(self, method: str, path: str, **body: object):
        return self.client.request(method, path, json={"path": str(self.project), **body})

    def bundle(self, name: str) -> Path:
        out = self.exports / name
        report = DiagnosticsService().build_bundle(self.ws.project, out_dir=out, include_logs=True)
        assert Path(report.path).is_file()
        return out

    def scan(self) -> dict[str, set[str]]:
        found = scan_root(self.workspace, self.needles)
        for name, hit in scan_root(self.exports, self.needles).items():
            found[f"exports/{name}"] = hit
        return found


@pytest.fixture
def scene(
    minimal_project: Path,
    sample_wav: Path,
    tmp_path: Path,
    tmp_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Scene:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    queue = list(FIXED_SLUGS)

    def fixed_slug(_words: int) -> str:
        assert queue, "the test minted more links than it fixed tokens for"
        return queue.pop(0)

    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.share_registry.generate_slug", fixed_slug
    )
    reset_record_runtime_for_tests()
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)
    exports = host_platform.data_roots().exports
    exports.mkdir(parents=True)
    ws = ProjectWorkspace.open(minimal_project)
    with write_grant(WriteGrantKind.DISPATCHER):
        ReviewService(ws).publish(label="Mix")
    secret = get_share_registry().recording_key_secret()
    assert len(secret) == 32
    return Scene(
        client=TestClient(create_app(served_project=minimal_project)),
        project=minimal_project,
        ws=ws,
        workspace=tmp_workspace,
        exports=exports,
        needles=build_needles(TOKENS, secret),
    )


def _join(sock, *, seq: int = 1) -> None:
    sock.send_json({"type": "Record", "command_type": "Join", "payload": {}, "client_seq": seq})


def _until(sock, predicate: Callable[[dict], bool], *, n: int = 30) -> dict:
    for _ in range(n):
        msg = sock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message not received")


def _use_the_links(scene: Scene, *, between: Callable[[], None]) -> None:
    """Mint both links and use them: a review guest action, a record join and a take upload."""
    review = scene.host("POST", "/api/shares", role="editor").json()["share"]
    room = scene.host("POST", "/api/shares/record").json()["room"]
    assert {review["token"], room["guest"]["token"], room["producer"]["token"]} == set(TOKENS)
    registry_tokens = set(get_share_registry().known_tokens())
    assert set(TOKENS) <= registry_tokens

    pcm = bytes(i % 256 for i in range(64))
    wav = pcm_wav_header(len(pcm)) + pcm
    with scene.client.websocket_connect(f"/api/review/{review['token']}/daw/ws") as viewer:
        viewer.receive_json()
        comment = scene.client.post(
            f"/api/review/{review['token']}/comments",
            json={"body": "nice", "author": "g", "timeline_start": 0.1},
        )
        assert comment.status_code == 200, comment.text
        with scene.client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as guest:
            _join(guest)
            echo = _until(guest, lambda m: m.get("type") == "Echo")
            _until(guest, lambda m: m.get("type") == "Snapshot")
            guest.send_json(
                {
                    "type": "Record",
                    "command_type": "Consent",
                    "payload": {"accepted": True},
                    "client_seq": 2,
                }
            )
            _until(
                guest,
                lambda m: any(
                    p.get("role") == "guest" and p.get("consented") is True
                    for p in (m.get("snapshot") or {}).get("participants") or []
                ),
            )
            assert (
                scene.host(
                    "POST", "/api/record/command", command_type="Start", payload={}
                ).status_code
                == 200
            )
            assert (
                scene.host(
                    "POST", "/api/record/command", command_type="Stop", payload={}
                ).status_code
                == 200
            )
            upload = scene.client.post(
                f"/api/rec/{room['guest']['token']}/upload",
                params={
                    "take_index": 0,
                    "segment_index": 0,
                    "part_seq": 0,
                    "sha256": hashlib.sha256(pcm).hexdigest(),
                    "file_sha256": hashlib.sha256(wav).hexdigest(),
                    "final": True,
                    "expected_parts": 1,
                },
                headers={
                    "X-Record-Participant": echo["participant_id"],
                    "X-Record-Lease": echo["lease"],
                },
                content=pcm,
            )
            assert upload.status_code == 200, upload.text
            with write_grant(WriteGrantKind.DISPATCHER):
                landed = RecordLandingService(scene.ws).land()
            assert landed, "the take was not saved to the project"
            between()
    scene.host("POST", f"/api/shares/{review['token']}/revoke")


def test_the_registry_outside_the_scanned_roots_holds_every_token(scene: Scene) -> None:
    _use_the_links(scene, between=lambda: None)
    registry = Path(os.environ["PODCAST_SHARE_REGISTRY"])
    assert scene.workspace not in registry.parents
    assert scene.exports not in registry.parents
    found = scan_root(
        registry.parent, {k: v for k, v in scene.needles.items() if k.startswith("text:")}
    )
    held = set().union(*(hit for name, hit in found.items() if registry.name in name))
    assert {f"text:{token}" for token in TOKENS} <= held


def test_a_used_project_and_its_exports_hold_nothing_derived_from_a_link(scene: Scene) -> None:
    pristine = scene.scan()
    assert pristine == {}, f"fixture contains needle: {describe(pristine)}"
    scene.bundle("pristine")
    empty = scene.scan()
    assert empty == {}, f"an empty bundle contains a needle: {describe(empty)}"

    seen_while_open: dict[str, set[str]] = {}

    def while_open() -> None:
        scene.bundle("open")
        seen_while_open.update(scene.scan())

    _use_the_links(scene, between=while_open)
    seen_closed = scene.scan()
    scene.bundle("closed")
    reset_record_runtime_for_tests()
    _checkpoint(scene.workspace)
    seen_checkpointed = scene.scan()

    share_id = lookup_share(GUEST_TOKEN, kind="record")["id"]
    reached = scan_root(scene.workspace, {"share-id": share_id.encode()})
    assert reached, "the scanned folder holds no trace of the record join it should have scanned"

    assert seen_while_open == {}, f"while sockets were open: {describe(seen_while_open)}"
    assert seen_closed == {}, f"after the sockets closed: {describe(seen_closed)}"
    assert seen_checkpointed == {}, f"after a WAL checkpoint: {describe(seen_checkpointed)}"
    assert token_named_columns(scene.workspace) == []
