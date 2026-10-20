"""A review link follows the latest published version unless it is pinned (#1763)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.review import create_review_share_tool
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import (
    ShareService,
    open_share_workspace,
    share_project_view,
)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _publish_second(ws, label):
    ws.reload()
    # A changed premix gives the fix its own mix file.
    premix = Path(ws.project.workspace_dir) / "artifacts" / "premix.wav"
    premix.write_bytes(premix.read_bytes() + b"\0\0" * 8)
    return ReviewService(ws).publish(label=label)


def test_follow_latest_link_serves_the_next_published_version(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    link = ShareService(ws).create(review_version_id=first["id"], follow_latest=True)
    token = link["token"]
    assert link["follow_latest"] is True
    assert share_project_view(token)["review_version"]["id"] == first["id"]

    second = _publish_second(ws, "Intro fix")
    row, _ = open_share_workspace(token)
    assert row["review_version_id"] == second["id"]
    view = share_project_view(token)
    assert view["review_version"]["label"] == "Intro fix"
    assert view["link_follows_latest"] is True
    assert view["newer_version"] is None
    client = TestClient(create_app())
    assert client.get(f"/api/review/{token}/audio").status_code == 200
    listed = ShareService(ws).list_presented()
    assert [r["review_version_label"] for r in listed] == ["Intro fix"]


def test_pinned_link_stays_on_its_version_and_names_the_newer_one(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    link = ShareService(ws).create(review_version_id=first["id"])
    assert link["follow_latest"] is False
    second = _publish_second(ws, "Intro fix")

    view = share_project_view(link["token"])
    assert view["review_version"]["id"] == first["id"]
    assert view["link_follows_latest"] is False
    assert view["newer_version"] == {"id": second["id"], "label": "Intro fix"}


def test_follow_latest_comment_stamps_the_version_heard(minimal_project, sample_wav, tmp_workspace):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    link = ShareService(ws).create(
        review_version_id=first["id"], capabilities=["play", "comment"], follow_latest=True
    )
    second = _publish_second(ws, "Intro fix")
    client = TestClient(create_app())
    posted = client.post(
        f"/api/review/{link['token']}/comments",
        json={"body": "better", "author": "guest", "timeline_start": 1.0},
    )
    assert posted.status_code == 200
    assert posted.json()["comment"]["review_version_id"] == second["id"]


def test_create_for_host_follows_latest_unless_a_version_is_named(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    followed = ShareService(ws).create_for_host()
    frozen = ShareService(ws).create_for_host(review_version_id=first["id"])
    assert followed["follow_latest"] is True
    assert frozen["follow_latest"] is False


def test_mcp_tool_follows_unless_pinned(minimal_project, sample_wav, tmp_workspace):
    import json

    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    follows = json.loads(create_review_share_tool(str(minimal_project)))
    pinned_active = json.loads(create_review_share_tool(str(minimal_project), pin=True))
    pinned_named = json.loads(create_review_share_tool(str(minimal_project), first["id"]))
    assert follows["follow_latest"] is True
    assert pinned_active["follow_latest"] is False
    assert pinned_named["follow_latest"] is False


def test_revoking_a_follow_link_keeps_the_object_other_links_serve(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.media.review_media import delete_object_store_object_if_unused

    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    link = ShareService(ws).create(review_version_id=first["id"], follow_latest=True)
    ws.reload()
    # No object is stored here, so "unused" is only decided by the share check: a live
    # follow link on the active version must count as a user of it.
    assert delete_object_store_object_if_unused(ws, first["id"]) is False
    ShareService(ws).revoke(link["token"])


def test_follow_latest_keeps_the_newest_mix_when_the_active_version_is_cleared(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    link = ShareService(ws).create(review_version_id=first["id"], follow_latest=True)
    second = _publish_second(ws, "Intro fix")
    ReviewService(ws).set_active(None)
    row, _ = open_share_workspace(link["token"])
    assert row["review_version_id"] == second["id"]


def test_object_cleanup_keeps_the_newest_mix_a_follow_link_serves_without_an_active_version(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.services.media.review_media import delete_object_store_object_if_unused

    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    ShareService(ws).create(review_version_id=first["id"], follow_latest=True)
    second = _publish_second(ws, "Intro fix")
    ReviewService(ws).set_active(None)
    ws.reload()
    for ver in ws.project.review.versions:
        ver.object_store_key = f"mix/{ver.id}.wav"

    class FakeStore:
        def __init__(self):
            self.deleted: list[str] = []

        def delete_object(self, key):
            self.deleted.append(key)

    store = FakeStore()
    assert delete_object_store_object_if_unused(ws, second["id"], object_store=store) is False
    assert store.deleted == []


def test_host_share_freeze_pins_the_link_to_the_current_version(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    first = ReviewService(ws).publish(label="Rough cut")
    client = TestClient(create_app(served_project=Path(minimal_project)))
    path = str(minimal_project)

    frozen = client.post("/api/shares", json={"path": path, "freeze": True}).json()["share"]
    following = client.post("/api/shares", json={"path": path}).json()["share"]
    assert frozen["follow_latest"] is False
    assert frozen["review_version_id"] == first["id"]
    assert following["follow_latest"] is True

    second = _publish_second(ws, "Intro fix")
    frozen_view = share_project_view(frozen["token"])
    assert frozen_view["review_version"]["id"] == first["id"]
    assert frozen_view["link_follows_latest"] is False
    assert frozen_view["newer_version"] == {"id": second["id"], "label": "Intro fix"}
    assert share_project_view(following["token"])["review_version"]["id"] == second["id"]
