"""Document sync offline / structural_mode / conflict coverage."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.policy import (
    StructuralMutationMode,
    resolve_structural_mode,
)
from podcast_mcp.services.share import ShareService


def test_resolve_structural_mode_propose_override():
    assert resolve_structural_mode(["edit"], "propose") is StructuralMutationMode.PROPOSE
    assert resolve_structural_mode(["suggest"], None) is StructuralMutationMode.PROPOSE
    assert resolve_structural_mode(None, None) is StructuralMutationMode.APPLY


def test_same_seq_idempotent(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = DocumentSyncService(ws)
    cmd = DocumentCommand(
        type="SuggestPendingEdit",
        payload={
            "track_id": "host",
            "start": 0.1,
            "end": 0.2,
            "reason": "x",
        },
        client_id="c",
        role="guest",
        client_seq=1,
        command_id="cmd-1",
    )
    r1 = svc.submit(cmd, capabilities=["view", "suggest"])
    r2 = svc.submit(cmd, capabilities=["view", "suggest"])
    assert r1["ok"] is True
    assert r2.get("idempotent") is True
    assert r1["server_seq"] == r2["server_seq"]


def test_structural_mode_propose_from_edit_cap(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    art = ws.project.artifacts_dir()
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    ver = ReviewService(ws).publish(label="Propose")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit"],
    )
    client = TestClient(create_app())
    r = client.post(
        f"/api/review/{share['token']}/daw/document/command",
        json={
            "client_id": "g1",
            "client_seq": 1,
            "command_id": "abc123",
            "role": "guest",
            "type": "DeleteClip",
            "payload": {"clip_id": "c1"},
            "structural_mode": "propose",
        },
    )
    assert r.status_code == 200
    body = r.json()
    # Guest HTTP responses must not leak host filesystem paths.
    blob = str(body)
    assert "/Users/" not in blob
    assert "workspace_dir" not in blob
    snap_proj = (body.get("snapshot") or {}).get("project") or {}
    assert snap_proj.get("project_path", "") in ("", None) or not str(
        snap_proj.get("project_path", "")
    ).startswith("/")
    # Propose should leave a pending decision, not remove the clip.
    ws2 = ProjectWorkspace.open(minimal_project)
    assert any(c.id == "c1" for c in ws2.project.clips)


def test_valueerror_not_found_becomes_conflict(minimal_project):
    from unittest.mock import patch

    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    ws = ProjectWorkspace.open(minimal_project)
    svc = DocumentSyncService(ws)

    with (
        patch(
            "podcast_mcp.services.document_sync.service.apply_command",
            side_effect=ValueError("clip not found"),
        ),
        pytest.raises(DocumentConflictError, match="not found"),
    ):
        svc._apply(
            DocumentCommand(
                type="SuggestPendingEdit",
                payload={"track_id": "host", "start": 0.1, "end": 0.2},
                client_id="c",
                role="guest",
                client_seq=1,
                command_id="x",
            )
        )


def test_document_route_conflict_json(minimal_project):
    from uuid import uuid4

    client = TestClient(create_app())
    r = client.post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "AddReply",
            "payload": {
                "comment_id": "missing",
                "body": "x",
                "author": "a",
            },
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
            "command_id": uuid4().hex,
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["conflict"] is True


def test_document_ws_authz_revoked_mid_session(minimal_project, monkeypatch):
    from podcast_mcp.services.session_sync.authz import AuthzDecision

    calls = {"n": 0}

    def _auth(**_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return AuthzDecision(allowed=True, reason="")
        return AuthzDecision(allowed=False, reason="revoked")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.document.authorize_client",
        _auth,
    )
    client = TestClient(create_app())
    url = f"/api/document/ws?path={minimal_project}&client_id=c1&role=viewer"
    with client.websocket_connect(url) as ws:
        ws.receive_json()
        ws.send_json(
            {
                "type": "Command",
                "command_type": "SuggestPendingEdit",
                "payload": {"track_id": "host", "start": 0.0, "end": 0.1},
                "client_seq": 1,
            }
        )
        err = ws.receive_json()
        assert err["type"] == "Error"


def test_share_audio_permission_and_redirect_errors(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from pathlib import Path
    from unittest.mock import MagicMock

    from podcast_mcp.services import share as share_mod

    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="AudioPerm")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]

    real_has = share_mod.has_capability

    def _deny_play(caps, cap):
        if cap == share_mod.CAP_PLAY:
            return False
        return real_has(caps, cap)

    monkeypatch.setattr(share_mod, "has_capability", _deny_play)
    with pytest.raises(PermissionError):
        share_mod.share_audio_path(token)
    with pytest.raises(PermissionError):
        share_mod.resolve_share_audio_redirect(token)

    monkeypatch.setattr(share_mod, "has_capability", real_has)
    with pytest.raises(KeyError, match="track"):
        share_mod.share_daw_audio_path(token, kind="stem", track_id="nope")

    monkeypatch.setattr(
        "podcast_mcp.services.review_media.upload_review_version_to_object_store",
        MagicMock(side_effect=RuntimeError("upload fail")),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.presigned_review_audio_url",
        lambda *_a, **_k: None,
    )
    assert share_mod.resolve_share_audio_redirect(token) is None


def test_open_share_auto_revokes_missing_version(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog
):
    """Stale shares auto-revoke when the review version is gone."""
    import json
    import logging
    from pathlib import Path

    from podcast_mcp.services import share as share_mod

    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="GoneSoon")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]

    def _clear(p):
        p.review.versions.clear()
        p.review.active_version_id = None
        return {}

    ws.mutate("before clear versions", "after clear versions", _clear)

    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.share"):
        with pytest.raises(KeyError, match="invalid or revoked"):
            share_mod.open_share_workspace(token)
    assert any("Auto-revoking share" in r.message for r in caplog.records)
    from podcast_mcp.edits.share_registry import get_share_registry

    reg = get_share_registry()
    assert reg.get_active(token) is None
    assert reg.is_reserved(token)  # demoted to cooldown, still reserved
    sidecar = [
        row
        for row in json.loads(
            (Path(ws.project.workspace_dir) / "artifacts" / "review" / "shares.json").read_text(
                encoding="utf-8"
            )
        )
        if row.get("token") == token
    ]
    assert sidecar and sidecar[0].get("revoked") is True
    # Second lookup fails as revoked without another auto-revoke pass.
    with pytest.raises(KeyError, match="invalid or revoked"):
        share_mod.lookup_share(token)
