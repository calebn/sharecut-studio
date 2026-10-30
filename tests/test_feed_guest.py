"""An Editor share link edits the episode's podcast listing; Viewer and Commenter links do not."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from feed_helpers import complete_show
from podcast_mcp.feed.model import NoShows, ShowSummary
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import ReviewRole
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import FeedService
from podcast_mcp.services.document import feed as feed_service
from podcast_mcp.services.document_sync.capabilities import (
    EDIT_COMMANDS,
    ROLE_DOCUMENT_COMMANDS,
    authorize_document_payload,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.util.coded_error import CodedPermissionError

Share = Callable[..., tuple[Any, dict[str, Any], dict[str, Any]]]
FEED_COMMANDS = ("SetFeedField", "ClearFeedField")


class OneShow(NoShows):
    def shows(self):
        return ()

    def profile(self, show_id):
        return complete_show()


@pytest.fixture(autouse=True)
def _show(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(feed_service, "default_show_source", OneShow)


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Ana Reyes")]
    project.feed.show_id = "long-river"
    save_project(project, minimal_project)
    return minimal_project


def _token(published_share: Share, role: str, *, mcp: bool = False) -> str:
    caps = capabilities_for_role(role, with_mcp=mcp)
    return published_share(capabilities=caps)[2]["token"]


def _command(client: TestClient, token: str, kind: str, payload: dict[str, Any], seq: int = 1):
    return client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "type": kind,
            "payload": payload,
            "client_id": "guest-tab",
            "client_seq": seq,
            "role": "guest",
        },
    )


def _pins(path: Path) -> dict[str, Any]:
    return {k: p.value for k, p in load_project(path).feed.pins.items()}


@pytest.mark.parametrize("command", FEED_COMMANDS)
def test_only_the_editor_role_may_edit_the_listing(command: str) -> None:
    assert [r.value for r in ReviewRole if command in ROLE_DOCUMENT_COMMANDS[r]] == ["editor"]
    assert command in EDIT_COMMANDS


@pytest.mark.parametrize("role", ["viewer", "commenter"])
@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        ("SetFeedField", {"key": "item.intro", "value": "Hi"}),
        ("ClearFeedField", {"key": "item.intro"}),
    ],
)
def test_viewer_and_commenter_links_are_refused(
    episode: Path, published_share: Share, role: str, kind: str, payload: dict[str, Any]
) -> None:
    token = _token(published_share, role)

    res = _command(TestClient(create_app()), token, kind, payload)

    assert res.status_code == 403
    assert res.headers["X-Sharecut-Error-Code"] == "share_capability_required"
    assert _pins(episode) == {}


def test_an_editor_link_sets_and_clears_a_value_and_the_event_leaks_nothing(
    episode: Path, published_share: Share
) -> None:
    token = _token(published_share, "editor")
    client = TestClient(create_app())

    res = _command(client, token, "SetFeedField", {"key": "item.intro", "value": "From a guest."})

    assert res.status_code == 200, res.text
    assert _pins(episode) == {"item.intro": "From a guest."}
    assert load_project(episode).feed.pins["item.intro"].by == "guest"
    body = res.text
    assert str(episode.parent) not in body and "From a guest." not in body
    assert res.json()["command"] == {"type": "SetFeedField"}

    cleared = _command(client, token, "ClearFeedField", {"key": "item.intro"}, seq=2)

    assert cleared.status_code == 200, cleared.text
    assert _pins(episode) == {}


def test_a_guest_edit_undoes_as_a_guest(episode: Path, published_share: Share) -> None:
    token = _token(published_share, "editor")
    client = TestClient(create_app())
    done = _command(client, token, "SetFeedField", {"key": "item.season", "value": 4})
    assert _pins(episode) == {"item.season": 4}

    undone = _command(
        client, token, "UndoHistory", {"expected_head_id": done.json()["history_head_id"]}, seq=2
    )

    assert undone.status_code == 200, undone.text
    assert _pins(episode) == {}


@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        ("SetFeedField", {"key": "channel.title", "value": "Hijacked"}),
        ("ClearFeedField", {"key": "channel.title"}),
        ("SetFeedField", {"key": "../../etc/passwd", "value": "x"}),
    ],
)
def test_a_guest_cannot_touch_show_settings_or_forge_an_author(
    episode: Path, published_share: Share, kind: str, payload: dict[str, Any]
) -> None:
    token = _token(published_share, "editor")

    res = _command(TestClient(create_app()), token, kind, payload)

    assert res.status_code == 403
    assert res.headers["X-Sharecut-Error-Code"] == "share_capability_required"
    assert _pins(episode) == {}


def test_a_guest_asking_to_be_an_agent_is_told_why() -> None:
    editor = capabilities_for_role("editor")

    with pytest.raises(CodedPermissionError, match="edits as a person") as raised:
        authorize_document_payload(
            editor, "SetFeedField", {"key": "item.intro", "value": "x", "by": "agent"}
        )

    assert raised.value.code == "share_capability_required"


def test_a_guest_cannot_pose_as_an_agent_over_the_route(
    episode: Path, published_share: Share
) -> None:
    token = _token(published_share, "editor")

    res = _command(
        TestClient(create_app()),
        token,
        "SetFeedField",
        {"key": "item.intro", "value": "x", "by": "agent"},
    )

    assert res.status_code == 403
    assert _pins(episode) == {}


def test_a_guest_pin_reads_as_the_guests_in_the_host_view(
    episode: Path, published_share: Share
) -> None:
    token = _token(published_share, "editor")
    client = TestClient(create_app())

    _command(client, token, "SetFeedField", {"key": "item.intro", "value": "By a guest."})

    view = FeedService(ProjectWorkspace.open(episode)).read().wire()
    assert view["item"]["item.intro"]["source"]["by"] == "guest"


@pytest.mark.parametrize(
    "key",
    [
        "item.guid",
        "item.nope",
        "item.enclosure.length",
        "channel.mediaUrl",
        "item.person[Ana Reyes]",
    ],
)
def test_the_payload_gate_asks_the_registry_not_the_key_prefix(key: str) -> None:
    editor = capabilities_for_role("editor")

    with pytest.raises(CodedPermissionError):
        authorize_document_payload(editor, "SetFeedField", {"key": key, "value": "x"})


def test_the_payload_gate_lets_a_guest_edit_one_person_attribute() -> None:
    editor = capabilities_for_role("editor")

    authorize_document_payload(
        editor, "SetFeedField", {"key": "item.person[Ana Reyes].role", "value": "host"}
    )


class TwoShows(NoShows):
    def shows(self):
        return (ShowSummary("long-river", "The Long River"), ShowSummary("secret", "Unreleased"))

    def profile(self, show_id):
        return None


def test_a_guest_never_sees_the_titles_of_shows_the_episode_is_not_linked_to(
    episode: Path, published_share: Share, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(feed_service, "default_show_source", TwoShows)
    project = load_project(episode)
    project.feed.show_id = None
    save_project(project, episode)
    token = _token(published_share, "editor")
    client = TestClient(create_app())

    read = client.get(f"/api/review/{token}/feed")
    wrote = client.post(f"/api/review/{token}/feed/write")

    assert read.json()["view"]["show"] == {"kind": "choose", "shows": []}
    assert "Unreleased" not in read.text and "Unreleased" not in wrote.text
    host = FeedService(ProjectWorkspace.open(episode)).read().wire()
    assert [s["title"] for s in host["show"]["shows"]] == ["The Long River", "Unreleased"]


def test_a_guest_value_is_checked_like_the_hosts(episode: Path, published_share: Share) -> None:
    token = _token(published_share, "editor")

    res = _command(
        TestClient(create_app()),
        token,
        "SetFeedField",
        {"key": "item.enclosure.url", "value": "file:///etc/passwd"},
    )

    assert res.status_code == 400
    assert res.headers["X-Sharecut-Error-Code"] == "feed_value_invalid"
    assert res.json()["detail"] == (
        "Hosting address must be an https address, using plain letters and numbers."
    )
    assert _pins(episode) == {}


def test_the_payload_gate_only_lets_a_guest_name_an_episode_value() -> None:
    editor = capabilities_for_role("editor")

    authorize_document_payload(editor, "SetFeedField", {"key": "item.intro", "value": "x"})
    authorize_document_payload(None, "SetFeedField", {"key": "channel.title", "value": "x"})
    with pytest.raises(CodedPermissionError):
        authorize_document_payload(editor, "SetFeedField", {"key": "channel.title", "value": "x"})
    with pytest.raises(CodedPermissionError):
        authorize_document_payload(editor, "ClearFeedField", {})


@pytest.mark.parametrize("role", ["viewer", "commenter", "editor"])
def test_every_role_that_can_view_reads_the_listing(
    episode: Path, published_share: Share, role: str
) -> None:
    token = _token(published_share, role)

    res = TestClient(create_app()).get(f"/api/review/{token}/feed")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["view"]["show"] == {"kind": "ready", "id": "long-river"}
    assert body["itemXml"].startswith("<item>")
    assert str(episode.parent) not in res.text


def test_a_link_without_view_cannot_read_the_listing(episode: Path, published_share: Share) -> None:
    token = published_share(capabilities=["play", "comment"])[2]["token"]

    res = TestClient(create_app()).get(f"/api/review/{token}/feed")

    assert res.status_code == 403
    assert res.headers["X-Sharecut-Error-Code"] == "share_capability_required"


def test_an_unknown_token_reads_nothing(episode: Path) -> None:
    assert TestClient(create_app()).get("/api/review/nope/feed").status_code in (403, 404)


def test_the_guest_read_shows_a_value_the_guest_just_set(
    episode: Path, published_share: Share
) -> None:
    token = _token(published_share, "editor")
    client = TestClient(create_app())

    _command(client, token, "SetFeedField", {"key": "item.intro", "value": "Seen by all."})

    view = client.get(f"/api/review/{token}/feed").json()["view"]
    assert view["item"]["item.intro"]["value"] == "Seen by all."


def _rpc(token: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )


def test_a_guest_agent_edits_through_the_generic_command_tool_only_as_an_editor(
    episode: Path, published_share: Share
) -> None:
    command = {
        "type": "SetFeedField",
        "payload": {"key": "item.intro", "value": "From a guest agent."},
        "client_id": "agent",
    }
    editor = _token(published_share, "editor", mcp=True)

    ok = _rpc(editor, "guest_submit_document_command", command)

    assert "error" not in ok, ok
    assert _pins(episode) == {"item.intro": "From a guest agent."}
    rejected = _rpc(
        editor,
        "guest_submit_document_command",
        {**command, "payload": {"key": "channel.title", "value": "x"}},
    )
    assert rejected["error"]["code"] == -32003
    viewer = _token(published_share, "viewer", mcp=True)
    assert _rpc(viewer, "guest_submit_document_command", command)["error"]["code"] == -32003
