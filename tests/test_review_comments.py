from __future__ import annotations

import os

from podcast_mcp.services.comment import CommentService
from podcast_mcp.services.review_comments import ReviewCommentsReplica, review_comments_locked
from podcast_mcp.services.workspace import ProjectWorkspace


def test_revision_chain_preserves_aba_and_ignores_unchanged_rows():
    replica = ReviewCommentsReplica()
    initial = replica.update([])
    assert initial is not None and initial["type"] == "Snapshot"
    assert replica.update([]) is None
    added = replica.update([{"id": "one", "body": "hello"}])
    assert added is not None and added["previous_revision"] == initial["revision"]
    assert added["operations"]["splices"] == [
        {"index": 0, "delete": 0, "insert": [{"id": "one", "body": "hello"}]}
    ]
    returned = replica.update([])
    assert returned is not None and returned["previous_revision"] == added["revision"]
    assert returned["revision"] != initial["revision"]
    assert set(initial) == {"plane", "type", "revision", "comments"}
    assert set(added) == {"plane", "type", "revision", "previous_revision", "operations"}


def test_locked_reader_adopts_same_inode_restored_mtime(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    CommentService(ws).add(body="before", author="test", timeline_start=0)
    before = review_comments_locked(ws)
    stat = minimal_project.stat()
    data = minimal_project.read_bytes().replace(b'"before"', b'"after!"')
    with minimal_project.open("r+b") as handle:
        handle.write(data)
    os.utime(minimal_project, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    after = review_comments_locked(ws)
    assert before[0]["body"] == "before"
    assert after[0]["body"] == "after!"


def review_token(minimal_project, sample_wav):
    from pathlib import Path

    from podcast_mcp.services import ReviewService
    from podcast_mcp.services.share import ShareService

    ws = ProjectWorkspace.open(minimal_project)
    artifact = Path(ws.project.workspace_dir) / "artifacts"
    artifact.mkdir(exist_ok=True)
    (artifact / "premix.wav").write_bytes(sample_wav.read_bytes())
    version = ReviewService(ws).publish(label="Review")
    return ShareService(ws).create(
        review_version_id=version["id"], capabilities=["play", "comment", "reply", "action"]
    )["token"]


def test_no_view_comments_socket_and_own_rest_operations(minimal_project, sample_wav):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    token = review_token(minimal_project, sample_wav)
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        initial = socket.receive_json()
        assert initial["plane"] == "comments" and initial["comments"] == []
        reply = client.post(
            f"/api/review/{token}/comments",
            json={"body": "/tmp/owned-comment", "author": "Guest", "timeline_start": 0},
        )
        assert reply.status_code == 200
        added = socket.receive_json()
        assert added["previous_revision"] == initial["revision"]
        assert added["operations"]["splices"][0]["insert"][0]["body"] == "/tmp/owned-comment"
        comment_id = reply.json()["comment"]["id"]
        response = client.post(
            f"/api/review/{token}/comments/{comment_id}/replies",
            json={"body": "Reply", "author": "Guest"},
        )
        assert response.status_code == 200
        changed = socket.receive_json()
        assert changed["previous_revision"] == added["revision"]
        assert changed["operations"]["updates"][0]["value"]["replies"][0]["body"] == "Reply"
        assert set(changed) == {"plane", "type", "revision", "previous_revision", "operations"}


def test_healthy_socket_sanity_recovers_a_saved_comment_without_publication(
    minimal_project, sample_wav, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import review_share
    from podcast_mcp.gui.server import create_app

    monkeypatch.setattr(review_share, "COMMENTS_SANITY_S", 0.05)
    token = review_token(minimal_project, sample_wav)
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        initial = socket.receive_json()
        ws = ProjectWorkspace.open(minimal_project)
        CommentService(ws).add(body="Saved silently", author="Host", timeline_start=0)
        changed = socket.receive_json()
        assert changed["previous_revision"] == initial["revision"]
        assert changed["operations"]["splices"][0]["insert"][0]["body"] == "Saved silently"


def test_subscription_signal_between_read_and_replacement_is_not_lost(
    minimal_project, sample_wav, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import review_share
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.document_sync.service import document_hub_key
    from podcast_mcp.services.session_sync.hub import get_hub

    token = review_token(minimal_project, sample_wav)
    read = review_share.review_comments_locked
    first = True

    def racing_read(ws):
        nonlocal first
        comments = read(ws)
        if first:
            first = False
            CommentService(ws).add(body="During initial read", author="Host", timeline_start=0)
            get_hub().publish(document_hub_key(ws.project), {"type": "signal"})
        return comments

    monkeypatch.setattr(review_share, "review_comments_locked", racing_read)
    with TestClient(create_app()).websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        initial = socket.receive_json()
        assert initial["type"] == "Snapshot" and initial["comments"] == []
        changed = socket.receive_json()
        assert changed["previous_revision"] == initial["revision"]
        assert changed["operations"]["splices"][0]["insert"][0]["body"] == "During initial read"


def test_action_resolution_and_undo_share_one_comments_chain(minimal_project, sample_wav):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.document_sync.service import notify_document_changed

    ws = ProjectWorkspace.open(minimal_project)
    comments = CommentService(ws)
    added = comments.add(body="Check this", author="Host", timeline_start=0)
    comment_id = added["id"]
    token = review_token(minimal_project, sample_wav)
    with TestClient(create_app()).websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        initial = socket.receive_json()
        comments.resolve(comment_id=comment_id, resolved=True, by="Host")
        notify_document_changed(minimal_project)
        resolved = socket.receive_json()
        assert resolved["previous_revision"] == initial["revision"]
        assert resolved["operations"]["updates"][0]["value"]["resolved"] is True
        from podcast_mcp.services.history import HistoryService

        HistoryService(ws).undo()
        notify_document_changed(minimal_project)
        undone = socket.receive_json()
        assert undone["previous_revision"] == resolved["revision"]
        assert undone["operations"]["updates"][0]["value"]["resolved"] is False


def test_live_comments_socket_closes_on_periodic_token_revocation(
    minimal_project, sample_wav, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.share import ShareService

    original = GuestWsGuard.__init__

    def quick_recheck(self, *args, **kwargs):
        kwargs["interval"] = 0.02
        original(self, *args, **kwargs)

    monkeypatch.setattr(GuestWsGuard, "__init__", quick_recheck)
    token = review_token(minimal_project, sample_wav)
    with TestClient(create_app()).websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        assert socket.receive_json()["type"] == "Snapshot"
        ShareService(ProjectWorkspace.open(minimal_project)).revoke(token)
        closed = socket.receive()
        assert closed["type"] == "websocket.close" and closed["code"] == 4403


def test_restricted_comments_socket_rejects_before_replacement(
    minimal_project, sample_wav, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import review_share
    from podcast_mcp.gui.server import create_app

    token = review_token(minimal_project, sample_wav)
    monkeypatch.setattr(review_share, "access_required", lambda _row: True)
    monkeypatch.setattr(review_share, "guest_restricted_origin_allowed", lambda _origin: False)
    with TestClient(create_app()).websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        assert socket.receive()["code"] == 4403
    monkeypatch.setattr(review_share, "guest_restricted_origin_allowed", lambda _origin: True)
    monkeypatch.setattr(review_share, "_restricted_principal_ok", lambda _socket, _token: False)
    with TestClient(create_app()).websocket_connect(f"/api/review/{token}/progress/ws") as socket:
        assert socket.receive()["code"] == 4401
