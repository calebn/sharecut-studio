"""Each guest sees Undo and Redo flags that are true for them alone (#3984)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.models.history import StepOwners
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import sanitize_guest_document_event
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import (
    ShareService,
    lookup_share,
    share_daw_project_view,
)
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_author,
)
from podcast_mcp.services.document_sync import DocumentSyncService, host_document_event

HISTORY_KEYS = {"cursor", "can_undo", "can_redo", "entries", "groups", "head_id"}


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def two_editor_links(minimal_project: Path, sample_wav: Path) -> list[tuple[str, str]]:
    project = load_project(minimal_project)
    artifacts = Path(project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="flags")
    links = []
    for _ in range(2):
        token = ShareService(ws).create(
            review_version_id=version["id"], capabilities=capabilities_for_role("editor")
        )["token"]
        links.append((token, share_author(lookup_share(token))))
    return links


def command(client: TestClient, token: str, title: str, seq: int) -> dict[str, Any]:
    reply = client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "type": "AddChapter",
            "payload": {"title": title, "time": float(seq)},
            "client_id": f"flags-{seq}",
            "client_seq": seq,
            "role": "guest",
        },
    )
    assert reply.status_code == 200, reply.text
    return reply.json()


def flags(history: dict[str, Any]) -> tuple[bool, bool]:
    return history["can_undo"], history["can_redo"]


def state_flags(client: TestClient, token: str) -> tuple[bool, bool]:
    state = client.get(f"/api/review/{token}/daw/document/state?phase=full").json()
    return flags(state["history"])


def next_applied(socket) -> dict[str, Any]:
    while True:
        frame = socket.receive_json()
        if frame["plane"] == "document" and frame["type"] == "Applied":
            return frame


def test_each_guest_sees_flags_that_are_true_for_them_alone(minimal_project, sample_wav):
    (token_a, _a), (token_b, _b) = two_editor_links(minimal_project, sample_wav)
    client = TestClient(create_app())
    with (
        client.websocket_connect(f"/api/review/{token_a}/daw/ws") as socket_a,
        client.websocket_connect(f"/api/review/{token_b}/daw/ws") as socket_b,
    ):
        hello = {}
        for name, socket in (("a", socket_a), ("b", socket_b)):
            frames = [socket.receive_json(), socket.receive_json()]
            hello[name] = next(f for f in frames if f["plane"] == "document")
            assert flags(hello[name]["snapshot"]["history"]) == (False, False)

        reply = command(client, token_a, "A", 1)
        assert flags(reply["snapshot"]["history"]) == (True, False)
        pumped_a, pumped_b = next_applied(socket_a), next_applied(socket_b)
        assert flags(pumped_a["snapshot"]["history"]) == (True, False)
        assert flags(pumped_b["snapshot"]["history"]) == (False, False)

        assert state_flags(client, token_a) == (True, False)
        assert state_flags(client, token_b) == (False, False)
        assert flags(share_daw_project_view(token_a)["history"]) == (True, False)
        assert flags(share_daw_project_view(token_b)["history"]) == (False, False)

        ProjectWorkspace.open(minimal_project).mutate(
            "before render preview",
            "after render preview",
            lambda p: setattr(p.timeline, "join_fade_max_ms", 40),
            operation="render_preview",
        )
        assert state_flags(client, token_a) == (True, False)
        assert state_flags(client, token_b) == (False, False)


def test_a_late_guest_hello_carries_flags_for_a_step_already_written(minimal_project, sample_wav):
    (token_a, _a), (token_b, _b) = two_editor_links(minimal_project, sample_wav)
    client = TestClient(create_app())
    command(client, token_a, "A", 1)
    for token, expected in ((token_a, (True, False)), (token_b, (False, False))):
        with client.websocket_connect(f"/api/review/{token}/daw/ws") as socket:
            frames = [socket.receive_json(), socket.receive_json()]
            document = next(f for f in frames if f["plane"] == "document")
            assert flags(document["snapshot"]["history"]) == expected


def test_a_guest_redo_flag_follows_who_undid(minimal_project, sample_wav):
    (token_a, _a), (token_b, _b) = two_editor_links(minimal_project, sample_wav)
    client = TestClient(create_app())
    command(client, token_a, "A", 1)
    undone = client.post(
        f"/api/review/{token_a}/daw/document/command",
        json={
            "type": "UndoHistory",
            "payload": {
                "expected_head_id": client.get(
                    f"/api/review/{token_a}/daw/document/state?phase=full"
                ).json()["project"]["history"]["head_id"]
            },
            "client_id": "flags-undo",
            "client_seq": 2,
            "role": "guest",
        },
    )
    assert undone.status_code == 200, undone.text
    assert flags(undone.json()["snapshot"]["history"]) == (False, True)
    assert state_flags(client, token_a) == (False, True)
    assert state_flags(client, token_b) == (False, False)


def test_guest_payloads_hold_only_the_booleans_and_no_owner_or_share_id(
    minimal_project, sample_wav
):
    (token_a, author_a), (token_b, author_b) = two_editor_links(minimal_project, sample_wav)
    client = TestClient(create_app())
    payloads = [command(client, token_a, "A", 1)]
    for token in (token_a, token_b):
        payloads.append(client.get(f"/api/review/{token}/daw/document/state?phase=full").json())
        payloads.append(share_daw_project_view(token))
        with client.websocket_connect(f"/api/review/{token}/daw/ws") as socket:
            payloads += [
                f
                for f in (socket.receive_json(), socket.receive_json())
                if f["plane"] == "document"
            ]
    histories = []
    for payload in payloads:
        histories += [
            h
            for h in (
                payload.get("history"),
                (payload.get("snapshot") or {}).get("history"),
                (payload.get("project") or {}).get("history"),
            )
            if h is not None
        ]
    assert histories
    for history in histories:
        assert set(history) <= HISTORY_KEYS
        assert isinstance(history["can_undo"], bool) and isinstance(history["can_redo"], bool)
    text = json.dumps(payloads)
    assert "_history_owners" not in text
    assert author_a.removeprefix("share:") not in text
    assert author_b.removeprefix("share:") not in text


def test_the_hub_event_carries_the_owners_and_the_host_frame_does_not(
    minimal_project, sample_wav, monkeypatch
):
    (token_a, author_a), _b = two_editor_links(minimal_project, sample_wav)
    published: list[dict[str, Any]] = []

    class Recorder:
        def publish(self, _key: str, event: dict[str, Any]) -> None:
            published.append(event)

    monkeypatch.setattr("podcast_mcp.services.document_sync.service.get_hub", lambda: Recorder())
    command(TestClient(create_app()), token_a, "A", 1)

    [event] = published
    assert event["_history_owners"] == StepOwners(author_a, None)
    assert "_history_owners" not in host_document_event(event)
    assert "_guest_snapshot" not in host_document_event(event)


def test_without_a_viewer_the_sanitizer_drops_the_owners_and_sets_no_flag():
    event = {
        "snapshot": {"server_seq": 3, "history": {"head_id": "abc", "can_undo": True}},
        "_history_owners": StepOwners("share:x", None),
    }

    out = sanitize_guest_document_event(event)

    assert out == {
        "snapshot": {
            "server_seq": 3,
            "history": {
                "cursor": 0,
                "can_undo": False,
                "can_redo": False,
                "entries": [],
                "groups": [],
                "head_id": "abc",
            },
        }
    }


def test_a_resync_frame_gets_no_flags():
    out = sanitize_guest_document_event(
        {
            "snapshot": {"server_seq": 4, "resync": True},
            "_history_owners": StepOwners("share:x", None),
        },
        viewer="share:x",
    )

    assert out == {"snapshot": {"server_seq": 4, "resync": True}}


def test_the_document_service_reads_the_owners_it_publishes(minimal_project):
    service = DocumentSyncService.open(minimal_project)

    state = service.guest_document_state(projection="shell")

    assert state["_history_owners"] == StepOwners(None, None)
    assert state["snapshot"]["history"]["can_undo"] is False
