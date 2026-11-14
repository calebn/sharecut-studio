"""Host GUI /api/shares list, create, revoke."""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import zipfile
from collections.abc import Iterator
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi.testclient import TestClient
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

from podcast_mcp.gui import bind
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share as share_module
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.review_shares import list_room_shares
from podcast_mcp.services.collaboration.share import ShareService, present_share
from podcast_mcp.services.collaboration.share_registry import get_share_registry
from podcast_mcp.services.record.service import reset_record_runtime_for_tests
from podcast_mcp.services.support.diagnostics import DiagnosticsService
from podcast_mcp.services.support.doctor import DoctorReport
from podcast_mcp.util import host_platform


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_present_share_adds_host_fields() -> None:
    row = present_share(
        {
            "token": "cool-name-slug",
            "capabilities": ["play", "view", "mcp"],
            "revoked": False,
            "project_workspace": "/host/secret/episode",
            "created_at": datetime.now(UTC).isoformat(),
        },
        public_base_url="https://share.example",
        version_label="Guest v1",
    )
    assert row["url"] == "https://share.example/r/cool-name-slug"
    assert row["docs_role"] == "viewer"
    assert row["guest_mode"] == "view"
    assert row["mcp_url"] == "https://share.example/mcp/cool-name-slug/mcp"
    assert row["review_version_label"] == "Guest v1"
    assert row["usable"] is True
    assert row["invite_closed"] is None
    assert "project_workspace" not in row


def test_host_shares_http_list_create_revoke(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    path = str(minimal_project)
    client = TestClient(create_app(served_project=Path(minimal_project)))

    empty = client.get("/api/shares", params={"path": path})
    assert empty.status_code == 200
    body = empty.json()
    assert body["shares"] == []
    assert body["public_origin"]
    assert "active_version_id" not in body
    assert "versions" not in body

    created = client.post(
        "/api/shares",
        json={"path": path, "role": "commenter"},
    )
    assert created.status_code == 200
    share = created.json()["share"]
    assert share["docs_role"] == "commenter"
    assert share["usable"] is True
    assert share["invite_closed"] is None
    assert "/r/" in share["url"]
    assert share["mcp_url"] is None
    assert share["review_version_label"] == "Share mix"
    assert "project_workspace" not in share
    token = share["token"]

    listed = client.get("/api/shares", params={"path": path})
    assert listed.status_code == 200
    rows = listed.json()["shares"]
    assert len(rows) == 1
    assert rows[0]["token"] == token
    assert rows[0]["review_version_label"] == "Share mix"
    assert "active_version_id" not in listed.json()
    assert "project_workspace" not in rows[0]

    mcp = client.post(
        "/api/shares",
        json={"path": path, "role": "editor", "with_mcp": True},
    )
    assert mcp.status_code == 200
    mcp_share = mcp.json()["share"]
    assert mcp_share["docs_role"] == "editor"
    assert mcp_share["mcp_url"].endswith(f"/mcp/{mcp_share['token']}/mcp")

    bad_role = client.post("/api/shares", json={"path": path, "role": "owner"})
    assert bad_role.status_code == 422

    missing = client.post(
        "/api/shares/not-a-real-token/revoke",
        json={"path": path},
    )
    assert missing.status_code == 404

    revoked = client.post(f"/api/shares/{token}/revoke", json={"path": path})
    assert revoked.status_code == 200
    assert revoked.json() == {"revoked": True, "token": token}
    after = client.get("/api/shares", params={"path": path})
    assert token not in {r["token"] for r in after.json()["shares"]}
    revoked_row = next(r for r in ShareService(ws).list() if r["id"] == share["id"])
    assert revoked_row["revoked"] is True
    assert "token" not in revoked_row

    assert ShareService(ws).list()


def test_create_for_host_auto_publishes(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    assert ReviewService(ws).list_versions() == []
    row = ShareService(ws).create_for_host(
        role="viewer",
        public_base_url="http://gui.test",
    )
    assert row["docs_role"] == "viewer"
    assert row["url"].startswith("http://gui.test/r/")
    assert row["review_version_label"] == "Share mix"
    assert "project_workspace" not in row
    assert ReviewService(ws).list_versions()


def test_create_for_host_refuses_a_stale_premix(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
            fader_db=-3.0,
        )
    ]
    save_project(proj, minimal_project)
    ws = _seed_premix(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="Refresh"):
        ShareService(ws).create_for_host(role="viewer", public_base_url="http://gui.test")
    assert ReviewService(ws).list_versions() == []

    client = TestClient(create_app(served_project=Path(minimal_project)))
    res = client.post("/api/shares", json={"path": str(minimal_project), "role": "viewer"})
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "stale_mix"
    assert "Refresh" in res.text


def test_create_for_host_uses_latest_created_mix(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Later mix")
    second = ReviewService(ws).publish(label="Earlier mix")
    for ver in ws.project.review.versions:
        if ver.id == first["id"]:
            ver.created_at = "2026-09-02T00:00:00+00:00"
        elif ver.id == second["id"]:
            ver.created_at = "2026-09-01T00:00:00+00:00"
    ws.project.review.active_version_id = None
    ws.save()
    row = ShareService(ws).create_for_host(public_base_url="http://gui.test")
    assert row["review_version_id"] == first["id"]
    assert row["review_version_label"] == "Later mix"


def test_create_for_host_uses_explicit_version(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    chosen = ReviewService(ws).publish(label="Chosen")
    ReviewService(ws).publish(label="Other")
    row = ShareService(ws).create_for_host(
        review_version_id=chosen["id"],
        public_base_url="http://gui.test",
    )
    assert row["review_version_id"] == chosen["id"]
    assert row["review_version_label"] == "Chosen"


def test_host_shares_unknown_version(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    _seed_premix(minimal_project, sample_wav)
    path = str(minimal_project)
    client = TestClient(create_app(served_project=Path(minimal_project)))
    res = client.post(
        "/api/shares",
        json={"path": path, "role": "commenter", "review_version_id": "missing-mix"},
    )
    assert res.status_code == 400


def test_host_shares_create_without_premix(minimal_project, tmp_workspace, monkeypatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    path = str(minimal_project)
    client = TestClient(create_app(served_project=Path(minimal_project)))
    res = client.post("/api/shares", json={"path": path, "role": "commenter"})
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "no_mix"
    detail = res.json()["detail"]
    assert "no mix yet" in detail
    assert "Refresh" in detail
    assert "pipeline" not in detail
    ws = ProjectWorkspace.open(minimal_project)
    assert ReviewService(ws).list_versions() == []


def test_host_shares_absent_without_online(monkeypatch):
    monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    client = TestClient(create_app())
    res = client.get("/api/shares", params={"path": "/tmp/nope.json"})
    assert res.status_code == 404


def test_host_shares_binding_prefix():
    from podcast_mcp.gui.middleware_host_binding import path_requires_host_binding

    assert path_requires_host_binding("/api/shares")
    assert path_requires_host_binding("/api/shares/tok/revoke")
    assert path_requires_host_binding("/api/record/command")
    assert not path_requires_host_binding("/api/review/tok/project")


def _files_holding(root: Path, needle: str) -> list[str]:
    return sorted(
        str(path.relative_to(root))
        for path in root.rglob("*")
        if path.is_file() and needle.encode() in path.read_bytes()
    )


def test_share_token_never_lands_in_the_workspace(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import json

    from podcast_mcp.services.collaboration.review_shares import shares_path

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    workspace = ws.project.workspace_path()
    path = str(minimal_project)
    client = TestClient(create_app(served_project=Path(minimal_project)))
    created = client.post("/api/shares", json={"path": path, "role": "editor"}).json()["share"]
    token = created["token"]

    assert _files_holding(workspace, token) == []
    listed = client.get("/api/shares", params={"path": path}).json()["shares"]
    assert [row["url"].rsplit("/", 1)[-1] for row in listed] == [token]
    guest = client.get(f"/api/review/{token}/project")
    assert guest.status_code == 200
    assert guest.json()["capabilities"] == created["capabilities"]
    comment = client.post(
        f"/api/review/{token}/comments",
        json={"body": "nice", "author": "g", "timeline_start": 0.1},
    )
    assert comment.status_code == 200
    assert _files_holding(workspace, token) == []

    sidecar = shares_path(ws.project)
    rows = json.loads(sidecar.read_text(encoding="utf-8"))
    rows[0]["token"] = "stale-old-token"
    sidecar.write_text(json.dumps(rows), encoding="utf-8")
    assert [row["token"] for row in ShareService(ws).list()] == [token]
    assert client.get("/api/review/stale-old-token/project").status_code == 404
    assert client.post(f"/api/shares/{token}/revoke", json={"path": path}).status_code == 200
    assert _files_holding(workspace, "stale-old-token") == []
    assert _files_holding(workspace, token) == []


# Link tokens in raw logs and the diagnostics bundle (#3877)

MIN_PREFIX = 6
CAPTURED_LOGGERS = ("uvicorn.access", "uvicorn.error", "podcast_mcp")


def leaks(text: str, tokens: set[str]) -> list[str]:
    """The tokens of which ``text`` holds the whole or a prefix of ``MIN_PREFIX`` or more."""
    decoded = text + quote(text, safe="") + quote(text, safe="").replace("%2F", "/")
    return sorted(t for t in tokens if t[:MIN_PREFIX] in decoded)


@dataclass
class Served:
    base: str
    port: int
    project: Path
    ws: ProjectWorkspace
    sidecar_log: Path

    def http(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return httpx.request(method, f"{self.base}{path}", timeout=20, **kwargs)

    def host_post(self, path: str, **body: Any) -> httpx.Response:
        return self.http("POST", path, json={"path": str(self.project), **body})

    def socket(self, path: str) -> list[str]:
        """Open a guest WebSocket, wait for the server to answer or close, and return its frames."""
        frames: list[str] = []
        try:
            with connect(f"ws://127.0.0.1:{self.port}{path}", open_timeout=10) as sock:
                sock.send(
                    '{"type":"Record","command_type":"Join","payload":'
                    '{"display_name":"Ava"},"client_seq":1}'
                )
                frames.append(str(sock.recv(timeout=10)))
        except (WebSocketException, TimeoutError, OSError) as exc:
            frames.append(type(exc).__name__)
        return frames


@pytest.fixture
def served(
    minimal_project: Path, sample_wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Served]:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(tmp_path / "share_identity.sqlite"))
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_path / "share_registry.sqlite"))
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    reset_record_runtime_for_tests()
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)

    sock = bind.exclusive_listen_socket("127.0.0.1", 0)
    server = bind.build_gui_server(
        create_app(served_project=minimal_project), sock, log_level="info", access_log=True
    )
    log_dir = host_platform.data_roots().log_dirs[0]
    log_dir.mkdir(parents=True)
    sidecar_log = log_dir / "sidecar.log"
    handler = logging.FileHandler(sidecar_log, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    loggers = [logging.getLogger(name) for name in CAPTURED_LOGGERS]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addHandler(handler)
    logging.getLogger("podcast_mcp").setLevel(logging.INFO)
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    while not server.started:
        thread.join(0.02)
    try:
        port = sock.getsockname()[1]
        yield Served(
            f"http://127.0.0.1:{port}",
            port,
            minimal_project,
            ProjectWorkspace.open(minimal_project),
            sidecar_log,
        )
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()
        for logger, level in zip(loggers, levels, strict=True):
            logger.removeHandler(handler)
            logger.setLevel(level)
        handler.close()


def _drive_every_link_flow(served: Served, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Run each flow that puts a token in a path or a log line; return label to token."""
    tokens: dict[str, str] = {}

    parked = served.host_post("/api/shares", role="commenter").json()["share"]["token"]
    tokens["parked"] = parked
    assert served.host_post(f"/api/shares/{parked}/revoke", restorable=True).status_code == 200
    assert served.host_post(f"/api/shares/{parked}/restore").status_code == 200
    assert served.host_post(f"/api/shares/{parked}/revoke").status_code == 200
    assert served.host_post("/api/shares/not-a-real-token-here/revoke").status_code == 404

    review = served.host_post("/api/shares", role="editor").json()["share"]["token"]
    tokens["review"] = review
    assert served.http("GET", f"/api/review/{review}/features").status_code == 200
    served.socket(f"/api/review/{review}/daw/ws?name=Ava&client_id=viewer-1")
    encoded_next = quote(f"/r/{review}", safe="")
    served.http("GET", f"/auth/login/github?next={encoded_next}", follow_redirects=False)

    room = served.host_post("/api/shares/record").json()["room"]
    tokens["record_guest"] = room["guest"]["token"]
    tokens["record_producer"] = room["producer"]["token"]
    served.socket(f"/api/rec/{room['guest']['token']}/ws?name=Ava&client_id=guest-7")
    served.socket(f"/api/rec/{parked}/ws?name=Refused")
    served.http("GET", f"/api/rec/{room['guest']['token']}/bootstrap")
    assert (
        served.host_post(f"/api/shares/record/{room['guest']['token']}/replace").status_code == 409
    )

    def refuse(*_args: object, **_kwargs: object) -> bool:
        raise OSError("disk gone")

    monkeypatch.setattr(share_module, "drop_share", refuse)
    ShareService(served.ws)._rollback_room(room["session_id"])
    return tokens


def _every_known_token() -> set[str]:
    """The tokens in the registry file, read without the product code under test."""
    with closing(sqlite3.connect(get_share_registry().db_path)) as db:
        return {
            row[0]
            for table in ("active_shares", "cooldown_shares", "pending_revokes")
            for row in db.execute(f"SELECT token FROM {table}")
        }


def test_the_raw_log_and_the_bundle_hold_no_link_token(
    served: Served, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    driven = _drive_every_link_flow(served, monkeypatch)
    tokens = _every_known_token() | set(driven.values())
    assert len(tokens) >= 4

    deadline = time.monotonic() + 10
    while "guest presence rejected type" not in served.sidecar_log.read_text(encoding="utf-8"):
        assert time.monotonic() < deadline, "the guest frame was never handled"
        threading.Event().wait(0.05)
    raw = served.sidecar_log.read_text(encoding="utf-8")
    assert "<share-token>" in raw
    assert "failed to roll back record share" in raw
    assert "guest presence rejected type share=" in raw
    assert "viewer-1" not in raw
    assert "name=Ava" not in raw
    assert leaks(raw, tokens) == []

    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.run_doctor_checks", lambda _p=None: DoctorReport()
    )
    report = DiagnosticsService().build_bundle(None, out_dir=tmp_path / "out", include_logs=True)
    with zipfile.ZipFile(report.path) as zf:
        members = {name: zf.read(name).decode("utf-8", errors="replace") for name in zf.namelist()}
    assert "sidecar.log" in members
    assert {name: leaks(body, tokens) for name, body in members.items()} == {
        name: [] for name in members
    }


def test_the_scan_sees_a_token_that_a_logger_bypassing_the_filter_wrote(
    served: Served, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    driven = _drive_every_link_flow(served, monkeypatch)
    token = driven["review"]
    with served.sidecar_log.open("a", encoding="utf-8") as raw:
        raw.write(f"planted: GET /api/review/{token}/features?name=Ava\n")

    assert leaks(served.sidecar_log.read_text(encoding="utf-8"), {token}) == [token]
    assert leaks(served.sidecar_log.read_text(encoding="utf-8"), {"unrelated-token-value"}) == []


def test_the_bundle_masks_a_token_wherever_a_log_line_puts_it(
    served: Served, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    driven = _drive_every_link_flow(served, monkeypatch)
    token = driven["review"]
    with served.sidecar_log.open("a", encoding="utf-8") as raw:
        raw.write(f"failed to revoke record token {token}\n")
        raw.write(f"KeyError: 'share not found: {token}'\n")
        raw.write(f"cut off {token[:8]}\n")
        raw.write(f"GET /auth/login/github?next=%2Fr%2F{token}\n")
        raw.write(f"encoded {quote(token[:3], safe='')}{token[3:]}\n")
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.run_doctor_checks", lambda _p=None: DoctorReport()
    )

    report = DiagnosticsService().build_bundle(None, out_dir=tmp_path / "out", include_logs=True)

    with zipfile.ZipFile(report.path) as zf:
        bundled = zf.read("sidecar.log").decode("utf-8")
    assert "failed to revoke record token <redacted>" in bundled
    assert leaks(bundled, {token}) == []


def test_a_share_that_is_not_found_is_reported_without_its_token(
    served: Served, monkeypatch: pytest.MonkeyPatch
) -> None:
    gone = "gone-quokka-umbra"
    service = ShareService(served.ws)

    with pytest.raises(KeyError) as revoked:
        service.revoke(gone)
    with pytest.raises(KeyError) as restored:
        service.restore(gone)
    refused = served.host_post(f"/api/shares/{gone}/revoke")

    for text in (str(revoked.value), str(restored.value), refused.text):
        assert gone not in text
        assert "share not found" in text


def test_share_id_of_names_a_share_by_its_id_and_refuses_one_without() -> None:
    from podcast_mcp.services.collaboration.share_capabilities import share_author, share_id_of

    assert share_id_of({"id": "a1b2c3d4e5f6", "token": "velvet-quokka-umbra"}) == "a1b2c3d4e5f6"
    assert share_author({"id": "a1b2c3d4e5f6"}) == "share:a1b2c3d4e5f6"
    with pytest.raises(KeyError):
        share_id_of({"token": "velvet-quokka-umbra"})


def test_a_failed_room_revoke_and_a_failed_touch_name_the_share_id(
    served: Served, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    room = served.host_post("/api/shares/record").json()["room"]
    token = room["guest"]["token"]
    service = ShareService(served.ws)
    ids = {row["id"] for row in list_room_shares(served.ws.project, room["session_id"])}
    caplog.set_level(logging.DEBUG, logger="podcast_mcp.services.collaboration.share")

    def fail(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk gone")

    monkeypatch.setattr(service, "revoke", fail)
    with pytest.raises(KeyError):
        service._revoke_room_tokens(room["session_id"])
    monkeypatch.setattr(share_module, "touch_share_last_used_for_workspace", fail)
    share_module.lookup_share(token)

    assert any(f"failed to revoke record share {i}" in caplog.text for i in ids)
    assert any(f"share last_used touch failed for {i}" in caplog.text for i in ids)
    assert token not in caplog.text


def test_the_share_page_fallback_logs_without_the_token(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from podcast_mcp.services.collaboration.share_page import (
        render_record_spa_html,
        render_share_spa_html,
    )

    caplog.set_level(logging.DEBUG, logger="podcast_mcp.services.collaboration.share_page")

    render_share_spa_html(
        "velvet-quokka-umbra", index_html="<head></head>", public_origin="http://x"
    )
    render_record_spa_html(
        "velvet-quokka-umbra", index_html="<head></head>", public_origin="http://x"
    )

    assert "SPA meta fallback" in caplog.text
    assert "velvet" not in caplog.text
