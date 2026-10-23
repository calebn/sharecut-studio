"""A guest on a review link names themselves; the server keeps the name a safe display label."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService


@pytest.fixture
def commenter_link(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="Names")
    share = ShareService(ws).create(review_version_id=ver["id"], capabilities=["play", "comment"])
    return TestClient(create_app()), share["token"]


def _post(client, token, author):
    response = client.post(
        f"/api/review/{token}/comments",
        json={"body": "note", "author": author, "timeline_start": 1.0},
    )
    assert response.status_code == 200, response.text
    return response.json()["comment"]


def test_named_guest_comment_keeps_the_name_trimmed(commenter_link):
    client, token = commenter_link
    assert _post(client, token, "  Alex   Kim  ")["author"] == "Alex Kim"


@pytest.mark.parametrize("blank", ["", "   ", "​\n"])
def test_blank_guest_name_posts_as_guest(commenter_link, blank):
    client, token = commenter_link
    assert _post(client, token, blank)["author"] == "Guest"


def test_guest_name_is_capped_at_forty_characters(commenter_link):
    client, token = commenter_link
    assert _post(client, token, "x" * 90)["author"] == "x" * 40


@pytest.mark.parametrize("reserved", ["Host", "host", "Agent", "DAW"])
def test_guest_cannot_post_under_a_reserved_name(commenter_link, reserved):
    client, token = commenter_link
    author = _post(client, token, reserved)["author"]
    assert author == f"{reserved} (guest)"


def test_guest_name_carries_no_markup_or_control_characters(commenter_link):
    client, token = commenter_link
    author = _post(client, token, "<b>Sam</b>\x07\x1b[31m")["author"]
    assert "<" not in author
    assert ">" not in author
    assert all(ch.isprintable() for ch in author)
    assert "Sam" in author


def test_guest_reply_name_gets_the_same_treatment(commenter_link):
    client, token = commenter_link
    cid = _post(client, token, "Sam")["id"]
    reply = client.post(
        f"/api/review/{token}/comments/{cid}/replies",
        json={"body": "re", "author": "  host  "},
    )
    assert reply.status_code == 200, reply.text
    assert reply.json()["reply"]["author"] == "host (guest)"
    blank = client.post(
        f"/api/review/{token}/comments/{cid}/replies",
        json={"body": "again", "author": " "},
    )
    assert blank.json()["reply"]["author"] == "Guest"


def test_host_sees_the_guest_name_in_the_comment_list(commenter_link, minimal_project):
    client, token = commenter_link
    _post(client, token, "Riley")
    ws = ProjectWorkspace.open(minimal_project)
    assert [c.author for c in ws.project.comments] == ["Riley"]


def test_lone_surrogate_name_never_reaches_the_project(commenter_link, minimal_project):
    from podcast_mcp.services.session_sync import guest_display_name

    assert guest_display_name("x\ud83d") == "x"
    client, token = commenter_link
    raw = b'{"body":"note","author":"x\\ud83d","timeline_start":1.0}'
    response = client.post(
        f"/api/review/{token}/comments",
        content=raw,
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert ProjectWorkspace.open(minimal_project).project.comments == []
    assert _post(client, token, "ok")["author"] == "ok"


@pytest.mark.parametrize("silent", ["​‍⁠", "﻿", "‮"])
def test_name_of_only_invisible_characters_is_guest(commenter_link, silent):
    client, token = commenter_link
    assert _post(client, token, silent)["author"] == "Guest"


def test_name_is_capped_by_code_points_not_utf16_units(commenter_link):
    client, token = commenter_link
    assert _post(client, token, "\U0001f600" * 90)["author"] == "\U0001f600" * 40


def test_oversized_name_fields_are_refused(commenter_link):
    client, token = commenter_link
    cid = _post(client, token, "Sam")["id"]
    big = "n" * 201
    assert (
        client.post(
            f"/api/review/{token}/comments",
            json={"body": "x", "author": big, "timeline_start": 1.0},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/review/{token}/comments/{cid}/replies",
            json={"body": "x", "author": big},
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/review/{token}/comments/{cid}/actions/none/done",
            json={"done": True, "by": big},
        ).status_code
        == 422
    )


def test_action_done_label_is_a_display_name_too(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.services.collaboration.share import open_share_workspace
    from podcast_mcp.services.document import CommentService

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="Actions")
    share = ShareService(ws).create(
        review_version_id=ver["id"], capabilities=["play", "comment", "action"]
    )
    _row, sws = open_share_workspace(share["token"])
    comment = CommentService(sws).add(
        body="Fix levels", author="guest", timeline_start=2.0, action_texts=["Normalize"]
    )
    cid = comment["id"]
    aid = comment["action_items"][0]["id"]
    client = TestClient(create_app())
    path = f"/api/review/{share['token']}/comments/{cid}/actions/{aid}/done"
    done = client.post(path, json={"done": True, "by": "  Host "})
    assert done.status_code == 200, done.text
    assert done.json()["action_item"]["completed_by"] == "Host (guest)"


@pytest.mark.parametrize(
    "spoof",
    [
        "\uff28\uff4f\uff53\uff54",
        "\uff21\uff27\uff25\uff2e\uff34",
        "\uff24aw",
        "\uff28ost",
        "Host.",
        "host!",
        "  Agent \u3002",
        "Host...",
    ],
)
def test_compatibility_forms_and_trailing_punctuation_of_reserved_names_are_suffixed(
    commenter_link, spoof
):
    client, token = commenter_link
    assert _post(client, token, spoof)["author"].endswith(" (guest)")


def test_lookalike_that_is_not_the_reserved_name_stays_as_typed(commenter_link):
    client, token = commenter_link
    assert _post(client, token, "Host 2")["author"] == "Host 2"
    assert _post(client, token, "Hostess")["author"] == "Hostess"


def test_huge_remote_name_is_bounded_before_sanitising():
    from podcast_mcp.services.session_sync import guest_display_name

    assert guest_display_name("a" * 5_000_000) == "a" * 40
