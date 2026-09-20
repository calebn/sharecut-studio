"""Final push toward 95% - comments GUI routes, review helpers, precorrect."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.review_shares import (
    create_share,
    list_shares,
    resolve_share,
    revoke_share,
)
from podcast_mcp.edits.review_versions import (
    get_version,
    list_versions,
    set_active_version,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.transcript_precorrect import TranscriptPrecorrectService

runner = CliRunner()


def test_comments_http_routes(minimal_project):
    client = TestClient(create_app())
    path = str(minimal_project)

    created = client.post(
        "/api/comments",
        json={
            "path": path,
            "body": "api",
            "author": "a",
            "timeline_start": 0.5,
            "action_texts": ["do"],
        },
    )
    assert created.status_code == 200, created.text
    cid = created.json()["comment"]["id"]

    patched = client.patch(
        f"/api/comments/{cid}",
        json={"path": path, "body": "patched"},
    )
    assert patched.status_code == 200

    reply = client.post(
        f"/api/comments/{cid}/replies",
        json={"path": path, "body": "r", "author": "b"},
    )
    assert reply.status_code == 200

    actions = (
        patched.json()["comment"].get("action_items")
        or created.json()["comment"].get("action_items")
        or []
    )
    if actions:
        aid = actions[0]["id"]
        done = client.post(
            f"/api/comments/{cid}/actions/{aid}/done",
            json={"path": path, "done": True, "by": "a"},
        )
        assert done.status_code == 200

    resolved = client.patch(
        f"/api/comments/{cid}",
        json={"path": path, "resolved": True, "by": "a"},
    )
    assert resolved.status_code == 200

    deleted = client.delete(f"/api/comments/{cid}", params={"path": path})
    assert deleted.status_code == 200


def test_review_versions_helpers(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="helpers")
    rows = list_versions(ws.project)
    assert any(r.id == ver["id"] for r in rows)
    assert get_version(ws.project, ver["id"]).id == ver["id"]
    set_active_version(ws.project, ver["id"])
    set_active_version(ws.project, None)


def test_review_shares_corrupt_and_search(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="s")
    row = create_share(ws.project, review_version_id=ver["id"])
    assert list_shares(ws.project)
    assert resolve_share(row["token"]) is not None
    shares_file = Path(ws.project.workspace_dir) / "artifacts" / "review" / "shares.json"
    shares_file.write_text("{bad", encoding="utf-8")
    assert list_shares(ws.project) == []
    shares_file.write_text("{}", encoding="utf-8")
    assert list_shares(ws.project) == []
    assert revoke_share(ws.project, "missing") is False


def test_history_cli(minimal_project):
    r = runner.invoke(cli_app, ["history-status", "--project", str(minimal_project)])
    assert r.exit_code == 0
    r2 = runner.invoke(cli_app, ["history", "list", "--project", str(minimal_project)])
    assert r2.exit_code == 0


def test_precorrect_mutate_path(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = TranscriptPrecorrectService(ws)
    with patch("podcast_mcp.services.transcript_precorrect.run_precorrect_transcript") as run:
        result = type("R", (), {"to_dict": lambda self: {"n": 1}})()
        run.return_value = result
        out = svc.precorrect(dry_run=True)
        assert out["n"] == 1
        with patch.object(ws, "mutate", return_value={"n": 2}) as mut:
            out2 = svc.precorrect(dry_run=False)
            assert out2["n"] == 2
            mut.assert_called_once()


def test_document_command_to_row():
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    cmd = DocumentCommand(
        type="AddComment",
        payload={"body": "x"},
        client_id="c",
        role="viewer",
        client_seq=1,
    )
    row = cmd.to_row()
    assert row["type"] == "AddComment"
    assert row["payload"]["body"] == "x"


def test_gui_server_static_and_review_spa(tmp_path):
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    (assets / "x.js").write_text("1", encoding="utf-8")
    app = create_app(static_dir=dist)
    client = TestClient(app)
    assert client.get("/").status_code == 200
    assert client.get("/r/some-token").status_code == 404
    assert client.get("/rec/some-token").status_code == 404
    assert client.get("/assets/x.js").status_code == 200


def test_cors_origins_extra(monkeypatch):
    monkeypatch.setenv("PODCAST_REVIEW_CORS_ORIGINS", "https://a.test, https://b.test")
    from podcast_mcp.gui.server import _cors_origins

    origins = _cors_origins()
    assert "https://a.test" in origins


def test_create_share_rejects_malformed_expires_at(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="s")
    with pytest.raises(ValueError, match="expires_at must be ISO 8601"):
        create_share(ws.project, review_version_id=ver["id"], expires_at="tomorrow")
    with pytest.raises(ValueError, match="expires_at must be ISO 8601"):
        create_share(ws.project, review_version_id=ver["id"], expires_at="2026-13-45")
    # valid ISO 8601 still accepted
    row = create_share(ws.project, review_version_id=ver["id"], expires_at="2026-12-31T23:59:59Z")
    assert row["expires_at"] == "2026-12-31T23:59:59Z"
    # None (no expiry) still accepted
    row2 = create_share(ws.project, review_version_id=ver["id"], expires_at=None)
    assert row2["expires_at"] is None
