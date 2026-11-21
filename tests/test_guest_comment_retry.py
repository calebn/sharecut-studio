from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import CommentService
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTHER_KEY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _workspace(minimal_project, sample_wav) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@pytest.fixture
def share(minimal_project, sample_wav):
    ws = _workspace(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="retry")
    row = ShareService(ws).create(
        review_version_id=ver["id"], capabilities=["play", "view", "comment", "reply", "mcp"]
    )
    return ws, row, TestClient(create_app())


def _post(client, token, **extra):
    body = {"body": "Guest note", "author": "Ana", "timeline_start": 1.5, **extra}
    return client.post(f"/api/review/{token}/comments", json=body)


def _comments(minimal_project):
    return load_project(minimal_project).comments


def test_same_comment_id_twice_makes_one_comment_and_one_history_entry(share, minimal_project):
    _, row, client = share
    first = _post(client, row["token"], comment_id=KEY)
    assert first.status_code == 200
    entries_after_first = len(load_project(minimal_project).history.entries)
    again = _post(client, row["token"], comment_id=KEY)
    assert again.status_code == 200
    assert again.json()["comment"]["id"] == first.json()["comment"]["id"]
    assert len(_comments(minimal_project)) == 1
    assert len(load_project(minimal_project).history.entries) == entries_after_first


@pytest.mark.parametrize("remove", ["delete", "undo"])
def test_replaying_removed_comment_does_not_restore_it(share, minimal_project, remove):
    ws, row, client = share
    first = _post(client, row["token"], comment_id=KEY)
    assert first.status_code == 200
    cid = first.json()["comment"]["id"]
    if remove == "delete":
        CommentService(ws).delete(cid)
    else:
        ws.undo()
    history = load_project(minimal_project).history
    replay = _post(client, row["token"], comment_id=KEY)
    assert replay.status_code == 400
    assert _comments(minimal_project) == []
    assert load_project(minimal_project).history == history


def test_undone_reply_id_cannot_be_reused_under_another_parent(share, minimal_project):
    ws, row, client = share
    first = _post(client, row["token"]).json()["comment"]["id"]
    second = _post(client, row["token"]).json()["comment"]["id"]
    body = {"reply_id": KEY, "body": "Answer", "author": "Ana"}
    url = f"/api/review/{row['token']}/comments"
    assert client.post(f"{url}/{first}/replies", json=body).status_code == 200
    ws.undo()
    assert client.post(f"{url}/{second}/replies", json=body).status_code == 400
    assert all(not comment.replies for comment in _comments(minimal_project))


def test_waiting_reply_target_resolves_without_a_guest_projection(share, minimal_project):
    _, row, client = share
    first = _post(client, row["token"], comment_id=KEY)
    assert first.status_code == 200
    url = f"/api/review/{row['token']}/comments/g-{KEY}/replies"
    reply = client.post(url, json={"reply_id": OTHER_KEY, "body": "Answer", "author": "Ana"})
    assert reply.status_code == 200
    assert reply.json()["comment_id"] == first.json()["comment"]["id"]
    assert len(_comments(minimal_project)[0].replies) == 1


def test_stored_id_is_scoped_to_the_share_and_not_the_raw_client_value(share):
    _, row, client = share
    stored = _post(client, row["token"], comment_id=KEY).json()["comment"]["id"]
    assert stored == f"g-{row['id']}-{KEY}"
    assert stored != KEY


def test_a_guest_cannot_collide_with_or_read_a_host_comment_through_the_id(share, minimal_project):
    ws, row, client = share
    CommentService(ws).add(
        body="Host private note", author="Ana", timeline_start=3.0, comment_id=KEY
    )
    reply = _post(client, row["token"], comment_id=KEY, body="Guest words")
    assert reply.status_code == 200
    assert reply.json()["comment"]["body"] == "Guest words"
    bodies = sorted(c.body for c in _comments(minimal_project))
    assert bodies == ["Guest words", "Host private note"]


def test_another_guest_name_cannot_read_a_comment_through_its_key(share):
    _, row, client = share
    assert _post(client, row["token"], comment_id=KEY).status_code == 200
    other = _post(client, row["token"], comment_id=KEY, author="Ben")
    assert other.status_code >= 400
    assert "Guest note" not in other.text


def test_a_bad_comment_id_is_refused(share):
    _, row, client = share
    for bad in ("short", KEY.upper(), KEY + "0", "../../etc/passwd" + "0" * 17):
        assert _post(client, row["token"], comment_id=bad).status_code == 422


def test_comment_id_does_not_unlock_a_link_without_comment_permission(minimal_project, sample_wav):
    ws = _workspace(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="view only")
    row = ShareService(ws).create(review_version_id=ver["id"], capabilities=["play", "view"])
    client = TestClient(create_app())
    assert _post(client, row["token"], comment_id=KEY).status_code == 403
    assert _comments(minimal_project) == []


def test_comments_without_an_id_are_still_separate(share, minimal_project):
    _, row, client = share
    _post(client, row["token"])
    _post(client, row["token"])
    assert len(_comments(minimal_project)) == 2


def test_same_reply_id_twice_makes_one_reply(share, minimal_project):
    _, row, client = share
    cid = _post(client, row["token"]).json()["comment"]["id"]
    url = f"/api/review/{row['token']}/comments/{cid}/replies"
    body = {"body": "Thanks", "author": "Ana", "reply_id": KEY}
    first = client.post(url, json=body)
    entries_after_first = len(load_project(minimal_project).history.entries)
    again = client.post(url, json=body)
    assert first.status_code == again.status_code == 200
    assert again.json()["reply"]["id"] == first.json()["reply"]["id"]
    assert first.json()["reply"]["id"] == f"g-{row['id']}-{KEY}"
    assert len(_comments(minimal_project)[0].replies) == 1
    assert len(load_project(minimal_project).history.entries) == entries_after_first
    other = client.post(url, json={**body, "reply_id": OTHER_KEY})
    assert other.status_code == 200
    assert len(_comments(minimal_project)[0].replies) == 2


def test_a_reply_id_repeated_under_another_comment_makes_no_second_reply(share, minimal_project):
    _, row, client = share
    first = _post(client, row["token"]).json()["comment"]["id"]
    second = _post(client, row["token"], timeline_start=4.0).json()["comment"]["id"]
    body = {"body": "Thanks", "author": "Ana", "reply_id": KEY}
    assert (
        client.post(f"/api/review/{row['token']}/comments/{first}/replies", json=body).status_code
        == 200
    )
    elsewhere = client.post(f"/api/review/{row['token']}/comments/{second}/replies", json=body)
    assert elsewhere.status_code >= 400
    by_id = {c.id: c for c in _comments(minimal_project)}
    assert len(by_id[first].replies) == 1
    assert by_id[second].replies == []


def test_a_repeat_tells_nobody_the_comments_changed(share, monkeypatch):
    from podcast_mcp.services.collaboration import share as share_module

    _, row, client = share
    told: list[str] = []
    monkeypatch.setattr(
        share_module, "notify_comments_changed", lambda *a, **k: told.append("changed")
    )
    cid = _post(client, row["token"], comment_id=KEY).json()["comment"]["id"]
    assert told == ["changed"]
    _post(client, row["token"], comment_id=KEY)
    assert told == ["changed"]
    url = f"/api/review/{row['token']}/comments/{cid}/replies"
    reply = {"body": "Thanks", "author": "Ana", "reply_id": KEY}
    client.post(url, json=reply)
    assert told == ["changed", "changed"]
    client.post(url, json=reply)
    assert told == ["changed", "changed"]


def test_a_bad_reply_id_is_refused(share):
    _, row, client = share
    cid = _post(client, row["token"]).json()["comment"]["id"]
    bad = client.post(
        f"/api/review/{row['token']}/comments/{cid}/replies",
        json={"body": "x", "author": "Ana", "reply_id": "nope"},
    )
    assert bad.status_code == 422


def _call(token, name, arguments):
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )


def test_mcp_guest_tools_take_the_same_retry_ids(share, minimal_project):
    _, row, _ = share
    token = row["token"]
    args = {"body": "from an agent", "author": "Bot", "timeline_start": 0.5, "comment_id": KEY}
    assert "error" not in _call(token, "guest_add_comment", args)
    assert "error" not in _call(token, "guest_add_comment", args)
    comments = _comments(minimal_project)
    assert len(comments) == 1
    reply = {"comment_id": comments[0].id, "body": "re", "author": "Bot", "reply_id": KEY}
    assert "error" not in _call(token, "guest_add_reply", reply)
    assert "error" not in _call(token, "guest_add_reply", reply)
    assert len(_comments(minimal_project)[0].replies) == 1
    bad = _call(token, "guest_add_comment", {**args, "comment_id": "nope"})
    assert bad["result"]["isError"] is True
    assert len(_comments(minimal_project)) == 1
