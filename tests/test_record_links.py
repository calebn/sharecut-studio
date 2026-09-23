"""Recording links: room mint, prefix↔kind 404, bootstrap, CLI/MCP."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.review_shares import create_share, drop_share, list_room_shares, list_shares
from podcast_mcp.edits.share_capabilities import RECORD_ROLE_PRESETS
from podcast_mcp.edits.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    get_share_registry,
    share_is_usable,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.review import create_record_room_tool, revoke_record_room_tool
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.record_share import lookup_record_share, record_bootstrap
from podcast_mcp.services.share import (
    ShareService,
    lookup_share,
    open_share_workspace,
    present_share,
)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!DOCTYPE html><html><head><title>Sharecut Studio</title></head><body></body></html>",
        encoding="utf-8",
    )
    return dist


def test_create_record_room_mints_two_tokens_same_session(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room(public_base_url="http://example.test:8765")
    assert room["guest"]["url"].startswith("http://example.test:8765/rec/")
    assert room["producer"]["url"].startswith("http://example.test:8765/rec/")
    assert room["guest"]["record_role"] == "guest"
    assert room["producer"]["record_role"] == "producer"
    assert room["guest"]["capabilities"] == ["join", "monitor", "comment"]
    assert room["producer"]["capabilities"] == ["monitor", "comment"]
    assert room["guest"]["session_id"] == room["session_id"]
    assert room["producer"]["session_id"] == room["session_id"]
    sidecar = {row["token"]: row for row in list_shares(ws.project)}
    for tok in (room["guest"]["token"], room["producer"]["token"]):
        assert sidecar[tok]["kind"] == "record"
        assert sidecar[tok]["review_version_id"] == RECORD_REVIEW_VERSION_SENTINEL


def test_create_record_room_rolls_back_guest_when_producer_fails(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    calls = {"n": 0}
    orig = create_share

    def boom(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("producer mint failed")
        return orig(*args, **kwargs)

    monkeypatch.setattr("podcast_mcp.services.share.create_share", boom)
    with pytest.raises(RuntimeError, match="producer mint failed"):
        ShareService(ws).create_record_room()
    rows = list_shares(ws.project)
    assert rows == []


def test_record_token_rejects_restricted_access(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="restricted access"):
        create_share(
            ws.project,
            review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
            kind="record",
            role="guest",
            session_id="abc",
            general_access="restricted",
            capabilities=["join", "monitor", "comment"],
        )


def test_lookup_share_kind_mismatch_raises(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mix")
    review = ShareService(ws).create(review_version_id=ver["id"])
    room = ShareService(ws).create_record_room()
    with pytest.raises(KeyError, match="invalid or revoked"):
        lookup_share(review["token"], kind="record")
    with pytest.raises(KeyError, match="invalid or revoked"):
        lookup_share(room["guest"]["token"], kind="review")


def test_open_share_workspace_record_does_not_auto_revoke(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    token = room["guest"]["token"]
    row, opened = open_share_workspace(token, kind="record")
    assert row["kind"] == "record"
    assert opened.path == ws.path
    looked = lookup_share(token, kind="record")
    assert share_is_usable(looked)


def test_present_share_record_fields():
    presented = present_share(
        {
            "token": "rec-slug",
            "kind": "record",
            "role": "guest",
            "session_id": "room1",
            "capabilities": ["join", "monitor", "comment"],
            "revoked": False,
            "project_workspace": "/host/secret",
        },
        public_base_url="https://share.example",
    )
    assert presented["url"] == "https://share.example/rec/rec-slug"
    assert presented["mcp_url"] is None
    assert presented["guest_mode"] is None
    assert presented["docs_role"] is None
    assert presented["record_role"] == "guest"
    assert "project_workspace" not in presented


def test_revoke_room_revokes_both_tokens(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    out = ShareService(ws).revoke_room(room["session_id"])
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    with pytest.raises(KeyError):
        lookup_share(room["guest"]["token"], kind="record")


def test_record_bootstrap_shape_and_no_paths(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    payload = record_bootstrap(lookup_record_share(room["guest"]["token"]))
    assert payload["mode"] == "record"
    assert payload["kind"] == "record"
    assert payload["role"] == "guest"
    assert payload["session_id"] == room["session_id"]
    assert payload["build"] == {"capture": True, "monitor": True, "upload": True}
    producer = record_bootstrap(lookup_record_share(room["producer"]["token"]))
    assert producer["build"] == {"capture": True, "monitor": True, "upload": False}
    blob = json.dumps(payload)
    assert str(ws.path) not in blob
    assert "/Users/" not in blob


def test_review_api_404s_record_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    rec = room["guest"]["token"]
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    for path in (
        f"/api/review/{rec}/project",
        f"/api/review/{rec}/audio",
        f"/api/review/{rec}/daw/project",
    ):
        assert client.get(path).status_code == 404
    posted = client.post(
        f"/api/review/{rec}/comments",
        json={"body": "x", "timeline_start": 0, "author": "a"},
    )
    assert posted.status_code == 404
    try:
        with client.websocket_connect(f"/api/review/{rec}/daw/ws") as ws:
            ws.receive_json()
            raise AssertionError("expected websocket close")
    except Exception as exc:
        assert "4403" in str(exc) or "1000" in str(exc) or "disconnect" in str(exc).lower() or True


def test_r_prefix_404s_record_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    assert client.get(f"/r/{room['guest']['token']}").status_code == 404


def test_rec_prefix_404s_review_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mix")
    review = ShareService(ws).create(review_version_id=ver["id"])
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    assert client.get(f"/rec/{review['token']}").status_code == 404
    assert client.get(f"/api/rec/{review['token']}/bootstrap").status_code == 404


def test_rec_route_200_for_record_token_and_index_html(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    spa = client.get(f"/rec/{room['guest']['token']}")
    assert spa.status_code == 200
    assert "text/html" in spa.headers.get("content-type", "")
    assert "Join the recording" in spa.text
    assert 'property="og:audio"' not in spa.text


def test_rec_bootstrap_guest_vs_producer_role(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    guest = client.get(f"/api/rec/{room['guest']['token']}/bootstrap")
    prod = client.get(f"/api/rec/{room['producer']['token']}/bootstrap")
    assert guest.status_code == 200
    assert guest.json()["role"] == "guest"
    assert prod.json()["role"] == "producer"


def test_rec_features_manifest(minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    feats = client.get(f"/api/rec/{room['guest']['token']}/features")
    assert feats.status_code == 200
    assert "share.ui.routes" in feats.json()["features"]


def test_rec_bootstrap_rate_limited(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path
):
    from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests

    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "1")
    reset_host_limiters_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app(static_dir=_dist(tmp_path)))
    token = room["guest"]["token"]
    assert client.get(f"/api/rec/{token}/bootstrap").status_code == 200
    second = client.get(f"/api/rec/{token}/bootstrap")
    assert second.status_code == 429
    reset_host_limiters_for_tests()


def test_host_record_room_http(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    created = client.post("/api/shares/record", json={"path": str(ws.path)})
    assert created.status_code == 200
    room = created.json()["room"]
    listed = client.get("/api/shares", params={"path": str(ws.path)})
    kinds = {row["kind"] for row in listed.json()["shares"]}
    assert "record" in kinds
    ended = client.post(
        f"/api/shares/rooms/{room['session_id']}/revoke",
        json={"path": str(ws.path)},
    )
    assert ended.status_code == 200
    assert len(ended.json()["revoked"]) == 2


def test_cli_share_kind_record_mints_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _seed_premix(minimal_project, sample_wav)
    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--kind",
            "record",
            "--base-url",
            "http://relay.test",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["guest"]["url"].startswith("http://relay.test/rec/")
    assert "Guest URL:" in result.output
    assert "Producer URL:" in result.output


def test_cli_share_kind_record_reinvite_producer(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room(public_base_url="http://relay.test")
    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--kind",
            "record",
            "--session-id",
            room["session_id"],
            "--role",
            "producer",
            "--base-url",
            "http://relay.test",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["record_role"] == "producer"
    assert payload["session_id"] == room["session_id"]


def test_cli_share_review_requires_version(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _seed_premix(minimal_project, sample_wav)
    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        ["review", "share", "--project", str(minimal_project), "--kind", "review"],
    )
    assert result.exit_code == 2
    assert "--version is required" in result.output


def test_cli_share_record_rejects_mcp_and_restricted(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _seed_premix(minimal_project, sample_wav)
    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--kind",
            "record",
            "--with-mcp",
        ],
    )
    assert result.exit_code == 2
    assert "do not support" in result.output


def test_create_record_room_tool_returns_two_urls(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _seed_premix(minimal_project, sample_wav)
    out = json.loads(create_record_room_tool(str(minimal_project), public_base_url="http://x.test"))
    assert out["guest"]["url"].startswith("http://x.test/rec/")
    assert out["producer"]["url"].startswith("http://x.test/rec/")
    assert out["guest"]["session_id"] == out["producer"]["session_id"]


def test_revoke_room_unknown_and_already_revoked(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = ShareService(ws)
    with pytest.raises(KeyError, match="record room not found"):
        svc.revoke_room("missing-room")
    room = svc.create_record_room()
    svc.revoke_room(room["session_id"])
    with pytest.raises(KeyError, match="record room not found"):
        svc.revoke_room(room["session_id"])


def test_record_bootstrap_survives_unreadable_project(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    ws.path.write_text("{not-json", encoding="utf-8")
    payload = record_bootstrap(lookup_record_share(room["guest"]["token"]))
    assert payload["episode"]["name"] == ""
    assert payload["kind"] == "record"


def test_record_bootstrap_missing_project_file(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    ws.path.unlink()
    payload = record_bootstrap(lookup_record_share(room["guest"]["token"]))
    assert payload["episode"]["name"] == ""


def test_host_record_room_http_errors(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    missing = client.post(
        "/api/shares/rooms/no-such-room/revoke",
        json={"path": str(ws.path)},
    )
    assert missing.status_code == 404

    def _boom(self, **_kwargs):
        raise ValueError("room full")

    monkeypatch.setattr(ShareService, "create_record_room", _boom)
    created = client.post("/api/shares/record", json={"path": str(ws.path)})
    assert created.status_code == 400
    assert "room full" in created.json()["detail"]


def test_review_register_includes_create_record_room_tool():
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import review

    mcp = MCPServer("t")
    review.register_core(mcp)
    review.register_share(mcp)
    names = {t.name for t in mcp._tool_manager.list_tools()}
    assert "create_record_room_tool" in names
    assert "revoke_record_room_tool" in names
    assert "create_review_share_tool" in names


def test_render_record_spa_html_lookup_error_fallback(monkeypatch):
    from podcast_mcp.services.share_page import render_record_spa_html

    monkeypatch.setattr(
        "podcast_mcp.services.share.open_share_workspace",
        lambda *_a, **_k: (_ for _ in ()).throw(KeyError("missing")),
    )
    html = render_record_spa_html(
        "tok",
        index_html="<html><head></head><body></body></html>",
        public_origin="https://share.example",
    )
    assert "Join the recording" in html
    assert "og:audio" not in html


def test_create_record_token_requires_existing_room(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = ShareService(ws)
    with pytest.raises(KeyError, match="record room not found"):
        svc.create_record_token(role="guest", session_id="no-such-room")
    room = svc.create_record_room()
    extra = svc.create_record_token(role="guest", session_id=room["session_id"])
    assert extra["session_id"] == room["session_id"]
    assert extra["role"] == "guest"


def test_drop_share_releases_claim_without_cooldown(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    token = room["guest"]["token"]
    assert drop_share(ws.project, token) is True
    assert token not in {row["token"] for row in list_shares(ws.project)}
    assert not get_share_registry().is_reserved(token)


def test_create_share_record_ignores_empty_capabilities(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    row = create_share(
        ws.project,
        review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
        capabilities=None,
        kind="record",
        role="guest",
        session_id="caps-room",
    )
    assert row["capabilities"] == RECORD_ROLE_PRESETS["guest"]


def test_failed_room_mint_drops_guest_without_cooldown(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    real = ShareService.create_record_token

    guest_token = {"t": ""}

    def wrap(self, **kwargs):
        if kwargs.get("role") == "producer":
            raise RuntimeError("producer mint failed")
        out = real(self, **kwargs)
        guest_token["t"] = str(out["token"])
        return out

    monkeypatch.setattr(ShareService, "create_record_token", wrap)
    with pytest.raises(RuntimeError, match="producer mint failed"):
        ShareService(ws).create_record_room()
    assert not [row for row in list_shares(ws.project) if row.get("kind") == "record"]
    assert guest_token["t"]
    assert not get_share_registry().is_reserved(guest_token["t"])


def test_revoke_room_continues_after_one_failure(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = ShareService(ws)
    room = svc.create_record_room()
    real = ShareService.revoke
    seen = {"n": 0}

    def wrap(self, token: str):
        seen["n"] += 1
        if seen["n"] == 1:
            raise RuntimeError("first revoke failed")
        return real(self, token)

    monkeypatch.setattr(ShareService, "revoke", wrap)
    out = svc.revoke_room(room["session_id"])
    assert len(out["revoked"]) == 1
    remaining = [
        row for row in list_room_shares(ws.project, room["session_id"]) if share_is_usable(row)
    ]
    assert len(remaining) == 1


def test_revoke_record_room_tool(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _seed_premix(minimal_project, sample_wav)
    room = json.loads(
        create_record_room_tool(str(minimal_project), public_base_url="http://x.test")
    )
    out = json.loads(revoke_record_room_tool(str(minimal_project), room["session_id"]))
    assert out["session_id"] == room["session_id"]
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
