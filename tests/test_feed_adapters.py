"""The CLI, MCP and HTTP adapters over FeedService: thin, and the same facts on every surface."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from feed_helpers import complete_show
from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import feed as mcp_feed
from podcast_mcp.models import ChapterMarker, Track, TrackRole, load_project, save_project
from podcast_mcp.services.document import feed as feed_service
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

runner = CliRunner()
CODE = "X-Sharecut-Error-Code"


class OneShow:
    def __init__(self) -> None:
        self.profile_ = complete_show()

    def shows(self):
        return ()

    def profile(self, show_id):
        return self.profile_


@pytest.fixture
def episode(minimal_project: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    project = load_project(minimal_project)
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Ana Reyes")]
    project.chapters = [ChapterMarker(time=0, title="Cold open")]
    project.feed.show_id = "long-river"
    save_project(project, minimal_project)
    monkeypatch.setattr(feed_service, "default_show_source", OneShow)
    return minimal_project


def _rows(path: Path) -> list[str]:
    return [row["type"] for row in DocumentSyncService.open(path).store.commands_after(0)]


def _cli(*args: str, code: int = 0) -> str:
    result = runner.invoke(app, ["feed", *args])
    assert result.exit_code == code, result.output
    return result.output


# --- CLI ------------------------------------------------------------------------------------


def test_cli_show_prints_a_readable_summary_with_the_fix_for_each_finding(episode: Path) -> None:
    out = _cli("show", "-p", str(episode))

    assert "item.title: test_episode  [the project name]" in out
    assert "item.intro: (missing) Say what this episode is about." in out
    assert "blocker RSS: The feed needs an address for the audio file." in out
    assert "warn Apple:" in out and "podcast feed set item.intro <value>" in out


def test_cli_show_json_xml_item_and_notes_are_the_views(episode: Path) -> None:
    wire = json.loads(_cli("show", "-p", str(episode), "--json"))
    assert wire["show"] == {"kind": "ready", "id": "long-river"}
    assert wire["item"]["item.title"]["source"] == {"kind": "derived", "rule": "the project name"}

    assert _cli("show", "-p", str(episode), "--xml").startswith('<?xml version="1.0"')
    assert _cli("show", "-p", str(episode), "--item").startswith("<item>")
    assert "<ol><li>0:00 Cold open</li></ol>" in _cli("show", "-p", str(episode), "--notes")
    assert json.loads(_cli("show", "-p", str(episode), "--shows")) == {
        "kind": "ready",
        "id": "long-river",
    }


def test_cli_show_refuses_two_views_at_once(episode: Path) -> None:
    out = _cli("show", "-p", str(episode), "--json", "--xml", code=2)

    assert "Choose one of" in out


def test_cli_check_exits_one_on_a_blocker_and_strict_also_on_a_warning(episode: Path) -> None:
    _cli("show", "-p", str(episode), "--check", code=1)
    _cli("set", "item.enclosure.url", "https://cdn.example.test/a.mp3", "-p", str(episode))
    _cli("show", "-p", str(episode), "--check", code=1)  # still no exported audio file
    _cli("show", "-p", str(episode), "--check", "--strict", code=1)


def test_cli_check_passes_when_nothing_blocks(episode: Path) -> None:
    export = load_project(episode).export_dir()
    export.mkdir(parents=True, exist_ok=True)
    (export / "test_episode.mp3").write_bytes(b"x" * 10)

    _cli("show", "-p", str(episode), "--check")
    _cli("show", "-p", str(episode), "--check", "--strict", code=1)  # the intro warning
    _cli("set", "item.intro", "A walk.", "-p", str(episode))
    _cli("set", "item.episode", "3", "-p", str(episode))
    _cli("show", "-p", str(episode), "--check", "--strict")


def test_cli_strict_counts_a_changed_pin(episode: Path) -> None:
    export = load_project(episode).export_dir()
    export.mkdir(parents=True, exist_ok=True)
    (export / "test_episode.mp3").write_bytes(b"x" * 10)
    _cli("set", "item.intro", "A walk.", "-p", str(episode))
    _cli("set", "item.episode", "3", "-p", str(episode))
    _cli("set", "item.notes", "Mine.", "-p", str(episode))
    project = load_project(episode)
    project.chapters.append(ChapterMarker(time=9, title="New"))
    save_project(project, episode)

    _cli("show", "-p", str(episode), "--check")
    _cli("show", "-p", str(episode), "--check", "--strict", code=1)


def test_cli_set_and_unset_pin_through_the_document_plane(episode: Path) -> None:
    out = json.loads(_cli("set", "item.intro", "A walk.", "-p", str(episode)))
    assert out["fact"]["value"] == "A walk." and out["fact"]["source"]["by"] == "person"
    assert _rows(episode) == ["SetFeedField"]

    gone = json.loads(_cli("unset", "item.intro", "-p", str(episode)))
    assert gone["fact"]["source"]["kind"] == "pending"
    assert _rows(episode) == ["SetFeedField", "ClearFeedField"]


def test_cli_set_reads_a_file_with_at_and_empty_unsets(episode: Path, tmp_path: Path) -> None:
    intro = tmp_path / "intro.txt"
    intro.write_text("Long\nintro.", encoding="utf-8")

    _cli("set", "item.intro", f"@{intro}", "-p", str(episode))
    assert load_project(episode).feed.pins["item.intro"].value == "Long\nintro."
    _cli("set", "item.intro", "", "-p", str(episode))
    assert load_project(episode).feed.pins == {}


def test_cli_set_refuses_a_bad_value_with_its_code(episode: Path) -> None:
    out = _cli("set", "item.guid", "x", "-p", str(episode), code=1)

    assert "feed_field_not_editable" in out


def test_cli_fields_lists_every_row_with_how_it_is_edited(episode: Path) -> None:
    rows = json.loads(_cli("fields", "--json"))
    by_key = {r["key"]: r for r in rows}

    assert by_key["item.intro"]["editable"] is True
    assert by_key["item.guid"]["editable"] is False
    assert by_key["channel.title"]["editable"] is False
    assert by_key["channel.title"]["edit"] == "Set on the show. Not available yet."
    assert by_key["item.chapters"]["edit"] == "Edit chapters in the Chapters list."
    assert "enclosure@url" in by_key["item.enclosure.url"]["tags"]
    assert "item.title  [episode] feed set" in _cli("fields")


# --- MCP ------------------------------------------------------------------------------------


def test_mcp_feed_read_returns_each_view(episode: Path) -> None:
    facts = json.loads(mcp_feed.feed_read(str(episode)))
    assert facts["item"]["item.title"]["value"] == "test_episode"
    assert mcp_feed.feed_read(str(episode), view="feed_xml").startswith("<?xml")
    assert mcp_feed.feed_read(str(episode), view="item_xml").startswith("<item>")
    assert "<p>Chapters</p>" in mcp_feed.feed_read(str(episode), view="notes_html")
    assert json.loads(mcp_feed.feed_read(str(episode), view="show"))["kind"] == "ready"


def test_mcp_feed_set_pins_as_an_agent_and_unset_releases_it(episode: Path) -> None:
    view = json.loads(mcp_feed.feed_set(str(episode), "item.intro", "Agent wrote this."))
    assert view["item"]["item.intro"]["source"] == {
        "kind": "pinned",
        "by": "agent",
        "drifted": False,
    }
    assert "<p>Agent wrote this.</p>" in view["notesHtml"]

    again = json.loads(mcp_feed.feed_unset(str(episode), "item.intro"))
    assert again["item"]["item.intro"]["source"]["kind"] == "pending"
    assert _rows(episode) == ["SetFeedField", "ClearFeedField"]


def test_mcp_feed_set_takes_numbers_and_lists_as_typed(episode: Path) -> None:
    mcp_feed.feed_set(str(episode), "item.season", 2)
    mcp_feed.feed_set(str(episode), "item.explicit", True)

    pins = load_project(episode).feed.pins
    assert (pins["item.season"].value, pins["item.explicit"].value) == (2, True)


def test_the_tools_are_registered_on_the_server() -> None:
    import asyncio

    from podcast_mcp.mcp.server import mcp

    names = {tool.name for tool in asyncio.run(mcp.list_tools())}

    assert {"feed_read", "feed_set", "feed_unset"} <= names


# --- HTTP -----------------------------------------------------------------------------------


def test_get_feed_returns_the_view_and_the_item_xml(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/feed", params={"path": str(episode)})

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["view"]["show"] == {"kind": "ready", "id": "long-river"}
    assert body["itemXml"].startswith("<item>")


def test_post_edit_pins_and_returns_the_new_view_and_unset_undoes_it(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    edit = {"op": "set", "key": "item.intro", "value": "From the page."}

    res = client.post("/api/feed/edit", json={"path": str(episode), "edit": edit})

    assert res.status_code == 200, res.text
    fact = res.json()["view"]["item"]["item.intro"]
    assert (fact["value"], fact["source"]["by"]) == ("From the page.", "person")
    assert "From the page." in res.json()["itemXml"]
    cleared = client.post(
        "/api/feed/edit",
        json={"path": str(episode), "edit": {"op": "unset", "key": "item.intro"}},
    )
    assert cleared.json()["view"]["item"]["item.intro"]["source"]["kind"] == "pending"


def test_post_edit_refuses_a_bad_edit_with_its_code(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.post(
        "/api/feed/edit",
        json={"path": str(episode), "edit": {"op": "set", "key": "item.chapters", "value": "x"}},
    )

    assert res.status_code == 400
    assert res.headers[CODE] == "feed_field_edit_at_source"


def test_a_relayed_guest_cannot_read_or_edit_the_listing(episode: Path) -> None:
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )

    assert relayed.get("/api/feed", params={"path": str(episode)}).status_code == 403
    res = relayed.post(
        "/api/feed/edit",
        json={"path": str(episode), "edit": {"op": "unset", "key": "item.intro"}},
    )
    assert res.status_code == 403
    assert _rows(episode) == []


def test_strict_authz_refuses_a_remote_peer(episode: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    remote = TestClient(create_app(), client=("203.0.113.9", 50000))

    assert remote.get("/api/feed", params={"path": str(episode)}).status_code == 403
