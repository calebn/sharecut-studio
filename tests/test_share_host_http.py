"""Host GUI /api/shares list, create, revoke."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService, ShareService
from podcast_mcp.services.share import present_share


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
    live = [r for r in after.json()["shares"] if r["token"] == token]
    assert live[0]["usable"] is False
    assert live[0]["revoked"] is True

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
    assert res.status_code == 400
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
    assert res.status_code == 400


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
