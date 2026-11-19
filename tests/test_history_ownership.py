"""A guest's Undo and Redo move only their own step (#3984)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from history_helpers import history_move
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.models.history import HistoryEntry, ProjectHistory, StepOwners
from podcast_mcp.project.store import WriteGrantKind, history_index_path, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_author,
)
from podcast_mcp.services.document import HistoryService, TimelineService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

ME = "share:aaaaaaaaaaaa"
OTHER = "share:bbbbbbbbbbbb"
UNDO_SENTENCE = "There is nothing of yours to undo. The latest change is someone else's."
REDO_SENTENCE = "There is nothing of yours to redo. Redo brings back only what you undid."


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def entry(
    entry_id: str,
    author: str | None,
    *,
    undone_by: str | None = None,
    operation: str | None = None,
) -> HistoryEntry:
    return HistoryEntry(
        id=entry_id,
        label=entry_id,
        snapshot_file=f"history/snapshots/{entry_id}.json",
        author=author,
        undone_by=undone_by,
        operation=operation,
    )


def history(cursor: int, *entries: HistoryEntry) -> ProjectHistory:
    return ProjectHistory(cursor=cursor, entries=list(entries))


BASE = entry("base", "host")


@pytest.mark.parametrize(
    ("label", "stack", "owners"),
    [
        ("own edit on top", history(1, BASE, entry("e1", ME)), StepOwners(ME, None)),
        ("host edit on top", history(1, BASE, entry("e1", "host")), StepOwners("host", None)),
        ("another guest on top", history(1, BASE, entry("e1", OTHER)), StepOwners(OTHER, None)),
        (
            "preview over own edit",
            history(2, BASE, entry("e1", ME), entry("p1", "system", operation="render_preview")),
            StepOwners(ME, None),
        ),
        (
            "merge entry on top",
            history(2, BASE, entry("e1", ME), entry("m1", "system")),
            StepOwners("system", None),
        ),
        ("entry written before 2.3", history(1, BASE, entry("e1", None)), StepOwners(None, None)),
        ("empty history", ProjectHistory(), StepOwners(None, None)),
        ("only the first entry", history(0, BASE), StepOwners(None, None)),
        (
            "own undone edit",
            history(0, BASE, entry("e1", ME, undone_by=ME)),
            StepOwners(None, ME),
        ),
        (
            "own edit undone by the host",
            history(0, BASE, entry("e1", ME, undone_by="host")),
            StepOwners(None, "host"),
        ),
        (
            "second of two own edits undone, a preview between",
            history(
                1,
                BASE,
                entry("e1", ME),
                entry("p1", "system", operation="render_preview"),
                entry("e2", ME, undone_by=ME),
            ),
            StepOwners(ME, ME),
        ),
        (
            "cursor on the preview before the second edit",
            history(
                2,
                BASE,
                entry("e1", ME),
                entry("p1", "system", operation="render_preview"),
                entry("e2", ME, undone_by=ME),
            ),
            StepOwners(ME, ME),
        ),
        (
            "only previews after the cursor",
            history(
                1,
                BASE,
                entry("e1", ME),
                entry("p1", "system", operation="render_preview"),
            ),
            StepOwners(ME, None),
        ),
    ],
)
def test_step_owners_table(label: str, stack: ProjectHistory, owners: StepOwners) -> None:
    assert stack.step_owners() == owners, label


def editor_link(minimal_project: Path, sample_wav: Path, *, mcp: bool = False) -> tuple[str, str]:
    project = load_project(minimal_project)
    artifacts = Path(project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="guard")
    share = ShareService(ws).create(
        review_version_id=version["id"],
        capabilities=capabilities_for_role("editor", with_mcp=mcp),
    )
    return share["token"], share_author(lookup_share(share["token"]))


def guest_move(client: TestClient, token: str, kind: str, project: Path, seq: int):
    return client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "type": f"{kind}History",
            "payload": history_move(project),
            "client_id": "guard-tab",
            "client_seq": seq,
            "role": "guest",
        },
    )


def guest_chapter(client: TestClient, token: str, title: str, seq: int) -> None:
    reply = client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "type": "AddChapter",
            "payload": {"title": title, "time": float(seq)},
            "client_id": "guard-tab",
            "client_seq": seq,
            "role": "guest",
        },
    )
    assert reply.status_code == 200, reply.text


def host_chapter(project: Path, title: str) -> None:
    TimelineService(ProjectWorkspace.open(project)).add_chapter(9.0, title)


def chapters(project: Path) -> list[str]:
    return [c.title for c in load_project(project).chapters]


def stored(project: Path) -> tuple[bytes, bytes]:
    index = history_index_path(load_project(project))
    return project.read_bytes(), index.read_bytes()


def test_a_guest_undo_is_refused_when_the_host_edit_is_on_top(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)
    host_chapter(minimal_project, "Hosts")
    before = stored(minimal_project)

    refused = guest_move(client, token, "Undo", minimal_project, 2)

    assert refused.status_code == 400, refused.text
    assert refused.json() == {"detail": UNDO_SENTENCE}
    assert refused.headers["X-Sharecut-Error-Code"] == "nothing_of_yours_to_undo"
    assert stored(minimal_project) == before
    assert chapters(minimal_project) == ["Mine", "Hosts"]


def test_a_guest_undoes_and_redoes_their_own_step_and_the_host_step_stays(
    minimal_project, sample_wav
):
    host_chapter(minimal_project, "Hosts")
    token, author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)
    assert chapters(minimal_project) == ["Mine", "Hosts"]

    undone = guest_move(client, token, "Undo", minimal_project, 2)
    assert undone.status_code == 200, undone.text
    assert chapters(minimal_project) == ["Hosts"]
    taken_back = load_project(minimal_project).history.entries[-1]
    assert (taken_back.label, taken_back.author, taken_back.undone_by) == (
        "after add chapter",
        author,
        author,
    )

    redone = guest_move(client, token, "Redo", minimal_project, 3)
    assert redone.status_code == 200, redone.text
    assert chapters(minimal_project) == ["Mine", "Hosts"]


def test_a_guest_cannot_redo_what_the_host_undid(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    assert chapters(minimal_project) == []
    before = stored(minimal_project)

    refused = guest_move(client, token, "Redo", minimal_project, 2)

    assert refused.status_code == 400, refused.text
    assert refused.json() == {"detail": REDO_SENTENCE}
    assert refused.headers["X-Sharecut-Error-Code"] == "nothing_of_yours_to_redo"
    assert stored(minimal_project) == before


def test_a_guest_cannot_undo_another_guests_step(minimal_project, sample_wav):
    first, _ = editor_link(minimal_project, sample_wav)
    second, _ = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, first, "First", 1)

    refused = guest_move(client, second, "Undo", minimal_project, 2)

    assert refused.status_code == 400, refused.text
    assert refused.headers["X-Sharecut-Error-Code"] == "nothing_of_yours_to_undo"
    assert chapters(minimal_project) == ["First"]


def test_a_guest_walks_back_two_own_edits_with_a_preview_between_them(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "One", 1)
    ProjectWorkspace.open(minimal_project).mutate(
        "before render preview",
        "after render preview",
        lambda p: setattr(p.timeline, "join_fade_max_ms", 40),
        operation="render_preview",
    )
    guest_chapter(client, token, "Two", 2)
    ProjectWorkspace.open(minimal_project).mutate(
        "before render preview",
        "after render preview",
        lambda p: setattr(p.timeline, "join_fade_max_ms", 50),
        operation="render_preview",
    )

    for seq in (3, 4):
        assert guest_move(client, token, "Undo", minimal_project, seq).status_code == 200
    assert chapters(minimal_project) == []
    for seq in (5, 6, 7):
        redone = guest_move(client, token, "Redo", minimal_project, seq)
        assert redone.status_code == 200, redone.text
    assert chapters(minimal_project) == ["One", "Two"]


def test_a_stale_head_wins_over_the_ownership_refusal(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)
    seen = history_move(minimal_project)
    host_chapter(minimal_project, "Hosts")

    stale = client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "type": "UndoHistory",
            "payload": seen,
            "client_id": "guard-tab",
            "client_seq": 2,
            "role": "guest",
        },
    )

    assert stale.status_code == 409, stale.text
    assert stale.headers["X-Sharecut-Error-Code"] == "history_stale"


def test_an_empty_history_still_says_there_is_nothing_to_undo(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())

    refused = guest_move(client, token, "Undo", minimal_project, 1)

    assert refused.status_code == 400, refused.text
    assert refused.headers["X-Sharecut-Error-Code"] == "nothing_to_undo"
    assert refused.json() == {"detail": "There is nothing to undo."}


def test_the_guest_mcp_undo_is_refused_with_the_same_sentence(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav, mcp=True)
    host_chapter(minimal_project, "Hosts")
    before = stored(minimal_project)

    out = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "guest_submit_document_command",
                "arguments": {"type": "UndoHistory", "payload": history_move(minimal_project)},
            },
        },
    )

    result = out["result"]
    assert result["isError"] is True
    assert result["structuredContent"]["error_code"] == "nothing_of_yours_to_undo"
    assert result["structuredContent"]["error"] == UNDO_SENTENCE
    assert stored(minimal_project) == before


def test_the_guest_mcp_undo_reply_carries_the_guests_own_flags(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav, mcp=True)
    guest_chapter(TestClient(create_app()), token, "Mine", 1)

    out = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "guest_submit_document_command",
                "arguments": {"type": "UndoHistory", "payload": history_move(minimal_project)},
            },
        },
    )

    history = out["result"]["structuredContent"]["snapshot"]["history"]
    assert (history["can_undo"], history["can_redo"]) == (False, True)
    assert chapters(minimal_project) == []


def test_the_host_undoes_a_guest_step_as_before_and_the_entry_names_the_host(
    minimal_project, sample_wav
):
    token, author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)

    DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="UndoHistory",
            payload=history_move(minimal_project),
            client_id="host",
            client_seq=None,
            role="viewer",
        ),
        range_policy="apply",
    )

    assert chapters(minimal_project) == []
    undone = [e for e in load_project(minimal_project).history.entries if e.undone_by]
    assert [(e.author, e.undone_by) for e in undone] == [(author, "host")]


def host_move(project: Path, kind: str) -> dict:
    reply = DocumentSyncService.open(project).submit(
        DocumentCommand(
            type=f"{kind}History",
            payload=history_move(project),
            client_id="host",
            client_seq=None,
            role="viewer",
        ),
        range_policy="apply",
    )
    return reply


def test_the_host_is_told_when_a_move_takes_back_or_brings_back_a_guests_step(
    minimal_project, sample_wav
):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)

    assert host_move(minimal_project, "Undo")["guest_step"] is True
    assert host_move(minimal_project, "Redo")["guest_step"] is True
    assert chapters(minimal_project) == ["Mine"]


def test_the_host_is_not_told_for_their_own_step(minimal_project):
    host_chapter(minimal_project, "Hosts")

    assert "guest_step" not in host_move(minimal_project, "Undo")
    assert "guest_step" not in host_move(minimal_project, "Redo")


def test_a_guests_own_move_reply_never_carries_guest_step(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)

    undone = guest_move(client, token, "Undo", minimal_project, 2)

    assert undone.status_code == 200, undone.text
    assert "guest_step" not in undone.json()
    redone = guest_move(client, token, "Redo", minimal_project, 3)
    assert "guest_step" not in redone.json()


def test_the_host_is_told_when_their_undo_takes_back_a_guests_comment(minimal_project, sample_wav):
    token, _author = editor_link(minimal_project, sample_wav)
    client = TestClient(create_app())
    posted = client.post(
        f"/api/review/{token}/comments",
        json={"body": "Fix", "author": "g", "timeline_start": 1.0},
    )
    assert posted.status_code == 200, posted.text

    assert host_move(minimal_project, "Undo")["guest_step"] is True
    assert load_project(minimal_project).comments == []


def test_a_guests_second_undo_cannot_take_back_an_unrecorded_host_change(
    minimal_project, sample_wav
):
    token, _author = editor_link(minimal_project, sample_wav)
    host = ProjectWorkspace.open(minimal_project)
    with host.transaction() as project:
        project.meta.name = "HOSTRENAME"
        host.save()
    client = TestClient(create_app())
    guest_chapter(client, token, "Mine", 1)

    first = guest_move(client, token, "Undo", minimal_project, 2)
    assert first.status_code == 200, first.text
    state = client.get(f"/api/review/{token}/daw/document/state?phase=full").json()
    assert (state["history"]["can_undo"], state["history"]["can_redo"]) == (False, True)
    before = stored(minimal_project)

    second = guest_move(client, token, "Undo", minimal_project, 3)

    assert second.status_code == 400, second.text
    assert second.headers["X-Sharecut-Error-Code"] == "nothing_of_yours_to_undo"
    assert stored(minimal_project) == before
    assert load_project(minimal_project).meta.name == "HOSTRENAME"
