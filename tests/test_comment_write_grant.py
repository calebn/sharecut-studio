from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import (
    UnscopedProjectWriteError,
    WriteGrantKind,
    reset_write_counts_for_tests,
    write_counts,
    write_grant,
    write_guard_mode,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import (
    ShareService,
    open_share_workspace,
    share_add_comment,
    share_add_reply,
    share_set_action_done,
)
from podcast_mcp.services.document import CommentService
from podcast_mcp.services.document.comment import run_comment_mutation_with_file_revisions
from podcast_mcp.util.coded_error import CodedPermissionError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

LOOPBACK = ("127.0.0.1", 50000)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK)


@pytest.fixture
def seeded(minimal_project: Path) -> tuple[Path, str, str]:
    with write_grant(WriteGrantKind.DISPATCHER):
        comment = CommentService(ProjectWorkspace.open(minimal_project)).add(
            body="seed", author="host", timeline_start=1.0, action_texts=["do"]
        )
    reset_write_counts_for_tests()
    return minimal_project, comment.id, comment.action_items[0].id


def _shared(project: Path, sample_wav: Path, capabilities: list[str] | None = None) -> str:
    proj = load_project(project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, project)
    ws = ProjectWorkspace.open(project)
    with write_grant(WriteGrantKind.DISPATCHER):
        version = ReviewService(ws).publish(label="v1")
        token = ShareService(ws).create(review_version_id=version["id"], capabilities=capabilities)[
            "token"
        ]
    reset_write_counts_for_tests()
    return token


def _seed_on_share(token: str) -> tuple[str, str]:
    row, ws = open_share_workspace(token)
    with write_grant(WriteGrantKind.DISPATCHER):
        comment = CommentService(ws).add(
            body="seed",
            author="host",
            timeline_start=1.0,
            action_texts=["do"],
            review_version_id=row["review_version_id"],
        )
    reset_write_counts_for_tests()
    return comment.id, comment.action_items[0].id


def test_the_guard_is_strict_here() -> None:
    assert write_guard_mode() == "strict"


def test_host_post_creates_a_comment(client: TestClient, minimal_project: Path) -> None:
    res = client.post(
        "/api/comments",
        json={"path": str(minimal_project), "body": "b", "author": "a", "timeline_start": 1.0},
    )

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_host_patch_resolves(client: TestClient, seeded) -> None:
    project, cid, _ = seeded

    res = client.patch(
        f"/api/comments/{cid}", json={"path": str(project), "resolved": True, "by": "h"}
    )

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_host_patch_updates_the_body(client: TestClient, seeded) -> None:
    project, cid, _ = seeded

    res = client.patch(f"/api/comments/{cid}", json={"path": str(project), "body": "new"})

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_host_marks_an_action_done(client: TestClient, seeded) -> None:
    project, cid, aid = seeded

    res = client.post(
        f"/api/comments/{cid}/actions/{aid}/done",
        json={"path": str(project), "done": True, "by": "h"},
    )

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_host_replies(client: TestClient, seeded) -> None:
    project, cid, _ = seeded

    res = client.post(
        f"/api/comments/{cid}/replies",
        json={"path": str(project), "body": "r", "author": "a"},
    )

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_host_deletes(client: TestClient, seeded) -> None:
    project, cid, _ = seeded

    res = client.delete(f"/api/comments/{cid}", params={"path": str(project)})

    assert res.status_code == 200
    assert write_counts() == {"legacy_comment": 1}


def test_guest_adds_a_comment(minimal_project: Path, sample_wav: Path) -> None:
    token = _shared(minimal_project, sample_wav)

    result = share_add_comment(token, body="b", author="g", timeline_start=1.0)

    assert result["body"] == "b"
    assert write_counts() == {"legacy_comment": 1}


def test_guest_replies(minimal_project: Path, sample_wav: Path) -> None:
    token = _shared(minimal_project, sample_wav)
    cid, _ = _seed_on_share(token)

    share_add_reply(token, cid, body="r", author="g")

    assert write_counts() == {"legacy_comment": 1}


def test_guest_marks_an_action_done(minimal_project: Path, sample_wav: Path) -> None:
    token = _shared(minimal_project, sample_wav)
    cid, aid = _seed_on_share(token)

    share_set_action_done(token, cid, aid, done=True)

    assert write_counts() == {"legacy_comment": 1}


def test_the_helper_takes_the_grant_and_returns_file_revisions(minimal_project: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)

    comment, revisions = run_comment_mutation_with_file_revisions(
        ws, lambda: CommentService(ws).add(body="b", author="a", timeline_start=1.0)
    )

    assert comment.body == "b"
    assert len(revisions) == 3
    assert write_counts() == {"legacy_comment": 1}


def test_a_direct_service_mutation_without_a_grant_still_raises(minimal_project: Path) -> None:
    ws = ProjectWorkspace.open(minimal_project)

    with pytest.raises(UnscopedProjectWriteError):
        CommentService(ws).add(body="b", author="a", timeline_start=1.0)


def test_the_grant_does_not_open_the_host_gate(minimal_project: Path) -> None:
    relayed = TestClient(create_app(), client=LOOPBACK, headers={RELAYED_REQUEST_HEADER: "1"})

    res = relayed.post(
        "/api/comments",
        json={"path": str(minimal_project), "body": "b", "author": "a", "timeline_start": 1.0},
    )

    assert res.status_code == 403
    assert write_counts() == {}


def test_the_grant_does_not_add_a_guest_capability(minimal_project: Path, sample_wav: Path) -> None:
    token = _shared(minimal_project, sample_wav, capabilities=["play", "view"])

    with pytest.raises(CodedPermissionError):
        share_add_comment(token, body="b", author="g", timeline_start=1.0)

    assert write_counts() == {}
