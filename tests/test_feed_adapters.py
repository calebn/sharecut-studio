"""The CLI, MCP and HTTP adapters over FeedService: thin, and the same facts on every surface."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from feed_helpers import complete_show
from podcast_mcp.cli.main import app
from podcast_mcp.feed.model import NoShows
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import feed as mcp_feed
from podcast_mcp.models import ChapterMarker, Track, TrackRole, load_project, save_project
from podcast_mcp.services.document import feed as feed_service
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

runner = CliRunner()
CODE = "X-Sharecut-Error-Code"


class OneShow(NoShows):
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

    assert _cli("show", "-p", str(episode), "--xml", code=1).startswith('<?xml version="1.0"')
    assert _cli("show", "-p", str(episode), "--item").startswith("<item>")
    assert "<ol><li>0:00 Cold open</li></ol>" in _cli("show", "-p", str(episode), "--notes")
    assert json.loads(_cli("show", "-p", str(episode), "--shows")) == {
        "kind": "ready",
        "id": "long-river",
    }


def test_cli_xml_warns_and_exits_one_while_a_blocker_stands_and_is_quiet_when_none_does(
    episode: Path,
) -> None:
    out = _cli("show", "-p", str(episode), "--xml", code=1)

    assert "Warning: this feed is not valid yet (" in out
    export = load_project(episode).export_dir()
    export.mkdir(parents=True, exist_ok=True)
    (export / "test_episode.mp3").write_bytes(b"x" * 10)
    quiet = _cli("show", "-p", str(episode), "--xml")
    assert "Warning" not in quiet and quiet.startswith("<?xml")


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


@pytest.mark.parametrize("target", ["missing.txt", ""])
def test_cli_set_from_an_unreadable_file_is_a_coded_error_not_a_traceback(
    episode: Path, tmp_path: Path, target: str
) -> None:
    (tmp_path / "binary.bin").write_bytes(b"\xff\xfe\x00")
    for name in (target or str(tmp_path), "binary.bin"):
        path = name if name.startswith("/") else str(tmp_path / name)
        out = _cli("set", "item.intro", f"@{path}", "-p", str(episode), code=1)

        assert "feed_file_unreadable" in out and "Traceback" not in out
    assert load_project(episode).feed.pins == {}


def test_cli_unset_of_a_typo_is_refused_but_a_known_key_with_no_pin_is_not(episode: Path) -> None:
    assert "feed_field_unknown" in _cli("unset", "item.nonsense", "-p", str(episode), code=1)
    assert "feed_field_unknown" in _cli(
        "unset", "item.person[Nobody].role", "-p", str(episode), code=1
    )
    _cli("unset", "item.intro", "-p", str(episode))
    assert _rows(episode) == []


def test_cli_fields_lists_every_row_with_how_it_is_edited(episode: Path) -> None:
    rows = json.loads(_cli("fields", "--json"))
    by_key = {r["key"]: r for r in rows}

    assert by_key["item.intro"]["editable"] is True
    assert by_key["item.guid"]["editable"] is False
    assert by_key["channel.title"]["editable"] is True
    assert by_key["channel.title"]["edit"] == "feed set"
    assert by_key["show"]["editable"] is True
    assert by_key["channel.roster"]["edit"].startswith("Set a person with channel.person[Name]")
    assert by_key["item.chapters"]["edit"] == "Edit chapters in the Chapters list."
    assert "enclosure@url" in by_key["item.enclosure.url"]["tags"]
    assert "item.title  [episode] feed set" in _cli("fields")


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "sent", "stored"),
    [
        ("item.season", 2, 2),
        ("item.season", "2", 2),
        ("item.explicit", True, True),
        ("item.explicit", "false", False),
        ("item.intro", "7", "7"),
        ("item.intro", '"quoted"', '"quoted"'),
    ],
)
async def test_a_real_mcp_client_may_send_text_numbers_and_booleans(
    episode: Path, key: str, sent: object, stored: object
) -> None:
    from mcp.client import Client

    from podcast_mcp.mcp import server

    async with Client(server.mcp) as client:
        result = await client.call_tool(
            "feed_set", {"project_path": str(episode), "field": key, "value": sent}
        )

    assert not result.is_error, result.content
    assert load_project(episode).feed.pins[key].value == stored


@pytest.mark.asyncio
async def test_a_real_mcp_client_gets_the_code_for_a_bad_view_or_key(episode: Path) -> None:
    from mcp.client import Client

    from podcast_mcp.mcp import server

    async with Client(server.mcp) as client:
        unset = await client.call_tool(
            "feed_unset", {"project_path": str(episode), "field": "item.nope"}
        )

    assert unset.is_error and "feed_field_unknown" in str(unset.structured_content or unset.content)
    with pytest.raises(CodedValueError) as raised:
        mcp_feed.feed_read(str(episode), view="bogus")  # type: ignore[arg-type]
    assert raised.value.code == "feed_view_unknown"


def test_the_tools_are_registered_on_the_server() -> None:
    import asyncio

    from podcast_mcp.mcp.server import mcp

    names = {tool.name for tool in asyncio.run(mcp.list_tools())}

    assert {"feed_read", "feed_set", "feed_unset", "feed_write"} <= names


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


def test_post_edit_restores_the_author_an_undo_names(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    edit = {"op": "set", "key": "item.intro", "value": "An agent wrote this."}

    res = client.post("/api/feed/edit", json={"path": str(episode), "edit": edit, "by": "agent"})

    assert res.status_code == 200, res.text
    assert res.json()["view"]["item"]["item.intro"]["source"]["by"] == "agent"


def test_post_edit_refuses_a_bad_edit_with_its_code(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.post(
        "/api/feed/edit",
        json={"path": str(episode), "edit": {"op": "set", "key": "item.chapters", "value": "x"}},
    )

    assert res.status_code == 400
    assert res.headers[CODE] == "feed_field_edit_at_source"


def test_post_edit_with_an_offset_publish_date_leaves_the_page_readable(episode: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    edit = {"op": "set", "key": "item.pubDate", "value": "2026-10-23T09:00:00+02:00"}

    res = client.post("/api/feed/edit", json={"path": str(episode), "edit": edit})

    assert res.status_code == 200, res.text
    assert "<pubDate>Fri, 23 Oct 2026 07:00:00 GMT</pubDate>" in res.json()["itemXml"]
    assert client.get("/api/feed", params={"path": str(episode)}).status_code == 200


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


@pytest.fixture
def writable(minimal_project: Path) -> Path:
    """An episode with a real show store, a complete show and an exported MP3."""
    from podcast_mcp.export.names import sanitize_export_stem
    from podcast_mcp.feed.show_store import ShowStore, default_directory

    store = ShowStore(default_directory())
    full = complete_show()
    store.create("The Long River")
    store.update(
        "the-long-river",
        lambda show: (
            show.pins.update({k: v for k, v in full.pins.items() if k != "channel.title"}),
            setattr(show, "media_url", full.media_url),
        ),
    )
    project = load_project(minimal_project)
    project.export_dir().mkdir(parents=True, exist_ok=True)
    stem = sanitize_export_stem(project.name)
    (project.export_dir() / f"{stem}.mp3").write_bytes(b"x" * 100)
    return minimal_project


def test_cli_write_writes_the_file_and_a_second_call_says_it_is_current(writable: Path) -> None:
    first = _cli("write", "-p", str(writable))
    again = _cli("write", "-p", str(writable))

    assert "Wrote" in first and "test_episode.feed.xml" in first
    assert "already current" in again
    assert "File: current" in _cli("show", "-p", str(writable))


def test_cli_write_is_refused_while_a_blocker_stands(minimal_project: Path) -> None:
    out = _cli("write", "-p", str(minimal_project), code=1)

    assert "feed_blocked" in out


def test_cli_set_creates_and_links_a_show_then_a_show_value(minimal_project: Path) -> None:
    _cli("set", "show", "The Long River", "-p", str(minimal_project))
    _cli("set", "channel.author", "Ana Reyes", "-p", str(minimal_project))

    shown = json.loads(_cli("show", "-p", str(minimal_project), "--json"))

    assert shown["show"] == {"kind": "ready", "id": "the-long-river"}
    assert shown["channel"]["channel.author"]["value"] == "Ana Reyes"
    assert load_project(minimal_project).feed.show_id == "the-long-river"


def test_mcp_feed_write_returns_the_path_and_the_file_state(writable: Path) -> None:
    result = json.loads(mcp_feed.feed_write(str(writable)))

    assert result["path"].endswith("test_episode.feed.xml")
    assert [Path(p).name for p in result["written"]] == ["test_episode.feed.xml"]
    assert result["file"] == "current"
    assert json.loads(mcp_feed.feed_write(str(writable)))["written"] == []


def test_post_write_writes_and_refuses_with_its_code(writable: Path, minimal_project: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.post("/api/feed/write", json={"path": str(writable)})

    assert res.status_code == 200, res.text
    assert res.json()["view"]["file"] == "current"
    assert (writable.parent / "export" / "test_episode.feed.xml").is_file()


def test_post_write_with_a_blocker_is_a_400_and_a_guest_is_a_403(minimal_project: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    refused = client.post("/api/feed/write", json={"path": str(minimal_project)})
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    ).post("/api/feed/write", json={"path": str(minimal_project)})

    assert refused.status_code == 400
    assert refused.headers[CODE] == "feed_blocked"
    assert relayed.status_code == 403


def test_an_editor_share_may_write_the_feed_file_and_a_commenter_may_not(
    writable: Path, published_share
) -> None:
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    client = TestClient(create_app(), client=("203.0.113.9", 50000))
    editor = published_share(capabilities=capabilities_for_role("editor"))[2]["token"]
    commenter = published_share(capabilities=capabilities_for_role("commenter"))[2]["token"]

    denied = client.post(f"/api/review/{commenter}/feed/write")
    allowed = client.post(f"/api/review/{editor}/feed/write")

    assert denied.status_code == 403
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["view"]["file"] == "current"
    assert str(writable.parent) not in allowed.text
    assert (writable.parent / "export" / "test_episode.feed.xml").is_file()


@pytest.mark.parametrize(
    ("role", "key", "value", "status"),
    [
        ("viewer", "channel.author", "Ana", 403),
        ("commenter", "channel.author", "Ana", 403),
        ("editor", "channel.author", "Ana", 200),
        ("editor", "channel.title", "The Long River", 200),
        ("editor", "channel.owner.email", "ana@example.test", 200),
        ("editor", "channel.person[Ana Reyes].role", "host", 200),
        ("editor", "channel.image", "https://cdn.example.test/c.jpg", 200),
        ("editor", "show", "Other Show", 403),
        ("editor", "channel.mediaUrl", "https://evil.example.test/{file}", 403),
        ("editor", "channel.image", "/etc/passwd", 403),
    ],
)
def test_a_guest_may_edit_a_show_value_by_role(
    writable: Path, published_share, role: str, key: str, value: str, status: int
) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    client = TestClient(create_app(), client=("203.0.113.9", 50000))
    token = published_share(capabilities=capabilities_for_role(role))[2]["token"]

    res = client.post(
        f"/api/review/{token}/feed/edit", json={"edit": {"op": "set", "key": key, "value": value}}
    )

    assert res.status_code == status, res.text
    shows = ShowStore(default_directory())
    show = shows.profile("the-long-river")
    held = show.pins.get(key)
    if key.startswith("channel.person"):
        assert (show.roster[0].role == value) == (status == 200) if show.roster else status != 200
    else:
        assert (held is not None and held.value == value) == (status == 200)
    assert show.media_url == "https://cdn.example.test/long-river/{file}"
    assert [s.id for s in shows.shows()] == ["the-long-river"]


def test_an_editor_is_pointed_at_the_episode_route_for_an_episode_value(
    writable: Path, published_share
) -> None:
    client, token = _guest(published_share)

    res = _guest_set(client, token, "item.intro", "Use the document route")

    assert res.status_code == 400
    assert res.headers[CODE] == "feed_field_not_editable"


@pytest.mark.parametrize(
    ("key", "code"),
    [
        ("channel.feedUrl", "feed_field_not_editable"),
        ("channel.podcastGuid", "feed_field_not_editable"),
        ("channel.roster", "feed_field_edit_at_source"),
        ("channel.bogus", "feed_field_unknown"),
        ("channel. mediaUrl", "feed_field_unknown"),
        ("channel.mediaUrl ", "feed_field_unknown"),
    ],
)
@pytest.mark.parametrize("op", ["set", "unset"])
def test_an_editor_set_or_unset_of_a_non_pin_or_unknown_key_gets_the_services_own_code(
    writable: Path, published_share, key: str, code: str, op: str
) -> None:
    client, token = _guest(published_share)
    edit = {"op": op, "key": key, **({"value": "x"} if op == "set" else {})}

    res = client.post(f"/api/review/{token}/feed/edit", json={"edit": edit})

    assert res.status_code == 400, res.text
    assert res.headers[CODE] == code
    assert res.headers[CODE] != "share_capability_required"


def test_an_editor_cannot_unset_a_host_only_row(writable: Path, published_share) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory

    client, token = _guest(published_share)

    res = client.post(
        f"/api/review/{token}/feed/edit",
        json={"edit": {"op": "unset", "key": "channel.mediaUrl"}},
    )

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"
    show = ShowStore(default_directory()).profile("the-long-river")
    assert show.media_url == "https://cdn.example.test/long-river/{file}"


def test_a_blank_artwork_set_from_an_editor_clears_the_pin_like_any_blank(
    writable: Path, published_share
) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory

    client, token = _guest(published_share)
    assert (
        _guest_set(client, token, "channel.image", "https://cdn.example.test/c.jpg").status_code
        == 200
    )

    for blank in ("", "   "):
        _guest_set(client, token, "channel.image", "https://cdn.example.test/c.jpg")
        res = _guest_set(client, token, "channel.image", blank)
        assert res.status_code == 200, res.text
        show = ShowStore(default_directory()).profile("the-long-river")
        assert "channel.image" not in show.pins


@pytest.mark.parametrize(
    ("stored", "says"),
    [("x" * 5000, "too long"), ("   ", "blank")],
)
def test_a_stored_text_that_breaks_a_limit_is_shown_and_named_not_called_the_wrong_kind(
    writable: Path, stored: str, says: str
) -> None:
    from podcast_mcp.models.feed import Pin

    project = load_project(writable)
    project.feed.pins["item.title"] = Pin(value=stored)
    save_project(project, writable)

    shown = json.loads(_cli("show", "-p", str(writable), "--json"))

    blocker = next(f for f in shown["findings"] if f["key"] == "item.title")
    assert blocker["severity"] == "blocker"
    assert says in blocker["message"] and "kind of value" not in blocker["message"]
    assert shown["item"]["item.title"]["value"] == stored


def test_the_host_may_edit_everything_a_guest_may_not(writable: Path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    for key, value in (
        ("channel.mediaUrl", "https://cdn.example.test/x/{file}"),
        ("show", "Other"),
    ):
        res = client.post(
            "/api/feed/edit",
            json={"path": str(writable), "edit": {"op": "set", "key": key, "value": value}},
        )
        assert res.status_code == 200, res.text


def _guest(published_share, role: str = "editor") -> tuple[TestClient, str]:
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    client = TestClient(create_app(), client=("203.0.113.9", 50000))
    return client, published_share(capabilities=capabilities_for_role(role))[2]["token"]


def _guest_set(client: TestClient, token: str, key: str, value: str):
    return client.post(
        f"/api/review/{token}/feed/edit", json={"edit": {"op": "set", "key": key, "value": value}}
    )


@pytest.mark.parametrize("role", ["viewer", "editor"])
def test_a_guest_never_receives_the_hosts_artwork_path(
    writable: Path, published_share, tmp_path: Path, role: str
) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory
    from podcast_mcp.models.feed import Pin

    art = tmp_path / "private-dir" / "cover.png"
    art.parent.mkdir()
    art.write_bytes(b"\x89PNG\r\n\x1a\nart")
    ShowStore(default_directory()).update(
        "the-long-river", lambda show: show.pins.update({"channel.image": Pin(value=str(art))})
    )
    client, token = _guest(published_share, role)

    read = client.get(f"/api/review/{token}/feed")
    written = client.post(f"/api/review/{token}/feed/write") if role == "editor" else None

    for res in (read, written):
        if res is not None:
            assert res.status_code == 200, res.text
            assert "private-dir" not in res.text and str(tmp_path) not in res.text


def test_a_guest_show_edit_is_attributed_to_the_guest(writable: Path, published_share) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory

    client, token = _guest(published_share)

    assert _guest_set(client, token, "channel.author", "Ana").status_code == 200

    show = ShowStore(default_directory()).profile("the-long-river")
    assert show.pins["channel.author"].by == "guest"


def test_a_roster_role_must_be_a_taxonomy_role_with_or_without_the_attribute(
    writable: Path, published_share
) -> None:
    client, token = _guest(published_share)

    bare = _guest_set(client, token, "channel.person[Ana Reyes]", "wizard")
    dotted = _guest_set(client, token, "channel.person[Ana Reyes].role", "wizard")
    fine = _guest_set(client, token, "channel.person[Ana Reyes]", "Producer")

    assert bare.status_code == dotted.status_code == 400
    assert fine.status_code == 200, fine.text


def test_a_roster_name_is_capped_like_every_other_name(writable: Path, published_share) -> None:
    client, token = _guest(published_share)

    assert _guest_set(client, token, f"channel.person[{'a' * 129}]", "host").status_code == 400
    assert _guest_set(client, token, f"channel.person[{'a' * 128}]", "host").status_code == 200


def test_an_editor_removes_a_roster_person_only_by_unsetting_or_blanking_it(
    writable: Path, published_share
) -> None:
    from podcast_mcp.feed.show_store import ShowStore, default_directory

    client, token = _guest(published_share)

    def names() -> list[str]:
        return [p.name for p in ShowStore(default_directory()).profile("the-long-river").roster]

    assert _guest_set(client, token, "channel.person[Ana Reyes]", "host").status_code == 200
    assert _guest_set(client, token, "channel.person[Bo Chen]", "producer").status_code == 200
    assert names() == ["Ana Reyes", "Bo Chen"]

    blank = _guest_set(client, token, "channel.person[Bo Chen]", "")
    assert blank.status_code == 200 and names() == ["Ana Reyes"]

    _guest_set(client, token, "channel.person[Bo Chen]", "producer")
    unset = client.post(
        f"/api/review/{token}/feed/edit",
        json={"edit": {"op": "unset", "key": "channel.person[Bo Chen]"}},
    )
    assert unset.status_code == 200 and names() == ["Ana Reyes"]
    attribute = client.post(
        f"/api/review/{token}/feed/edit",
        json={"edit": {"op": "unset", "key": "channel.person[Ana Reyes].href"}},
    )
    assert attribute.status_code == 200 and names() == ["Ana Reyes"]


def test_a_guest_view_replaces_any_local_path_with_the_file_name() -> None:
    from podcast_mcp.gui.routes.feed_routes import served

    class Leaky:
        def present(self, kind: str):
            if kind == "item_xml":
                return "<item/>"
            return {
                "show": {"kind": "ready", "id": "s"},
                "channel": {
                    "channel.image": {"value": "/srv/private/cover.png", "source": {}},
                    "channel.title": {"value": "Title", "source": {}},
                },
                "item": {},
                "sections": {"art": {"value": {"src": "/srv/private/cover.png", "alt": "a"}}},
            }

    guest = served(Leaky(), guest=True)
    host = served(Leaky())

    assert "/srv/private" not in str(guest)
    assert guest["view"]["channel"]["channel.image"]["value"] == "cover.png"
    assert guest["view"]["channel"]["channel.title"]["value"] == "Title"
    assert host["view"]["channel"]["channel.image"]["value"] == "/srv/private/cover.png"


def test_a_remote_item_guid_may_be_any_text_but_the_feed_guid_is_a_uuid(episode: Path) -> None:
    feed = "917393e3-1b1e-5cef-ace4-edaa54e1f810"
    for item in ("urn:uuid:7e987b0f-fea7-464c-84dc-8f109256000b", "https://example.test/ep/42"):
        _cli("set", "item.remoteItem", f"{feed} {item}", "-p", str(episode))
    refused = _cli("set", "item.remoteItem", "not-a-guid ep-42", "-p", str(episode), code=1)

    assert "feed_value_invalid" in refused


def _store_bad_value(path: Path) -> None:
    from podcast_mcp.models.feed import Pin

    project = load_project(path)
    project.feed.pins["item.value"] = Pin(value="{}")
    save_project(project, path)


def test_a_stored_value_the_feed_now_refuses_is_a_blocker_on_every_surface(
    writable: Path, published_share
) -> None:
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    _store_bad_value(writable)
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    guest = TestClient(create_app(), client=("203.0.113.9", 50000))
    token = published_share(capabilities=capabilities_for_role("viewer"))[2]["token"]

    shown = json.loads(_cli("show", "-p", str(writable), "--json"))
    host = client.get("/api/feed", params={"path": str(writable)})
    seen = guest.get(f"/api/review/{token}/feed")
    refused = _cli("write", "-p", str(writable), code=1)

    blocker = next(f for f in shown["findings"] if f["key"] == "item.value")
    assert blocker["severity"] == "blocker"
    assert "hexadecimal" in blocker["message"]
    assert host.status_code == 200, host.text
    assert seen.status_code == 200, seen.text
    assert "feed_blocked" in refused
    assert not (writable.parent / "export" / "test_episode.feed.xml").exists()


@pytest.mark.parametrize("key", ["item.title", "item.pubDate", "item.image"])
def test_a_hand_edited_pin_that_is_not_text_is_a_coded_blocker_not_a_crash(
    writable: Path, key: str
) -> None:
    from podcast_mcp.models.feed import Pin

    project = load_project(writable)
    project.feed.pins[key] = Pin(value=5)
    save_project(project, writable)

    shown = json.loads(_cli("show", "-p", str(writable), "--json"))
    refused = _cli("write", "-p", str(writable), code=1)

    blocker = next(f for f in shown["findings"] if f["key"] == key)
    assert blocker["severity"] == "blocker"
    assert "stored" in blocker["message"] and key not in blocker["message"]
    assert "feed_blocked" in refused


@pytest.mark.parametrize(("key", "value"), [("item.season", 99_999_999), ("item.episode", -4)])
def test_a_stored_count_out_of_range_is_a_coded_blocker_over_the_service_and_http(
    writable: Path, key: str, value: int
) -> None:
    from podcast_mcp.models.feed import Pin

    project = load_project(writable)
    project.feed.pins[key] = Pin(value=value, by="guest")
    save_project(project, writable)
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    shown = json.loads(_cli("show", "-p", str(writable), "--json"))
    refused = _cli("write", "-p", str(writable), code=1)
    served = client.get("/api/feed", params={"path": str(writable)})
    over_http = client.post("/api/feed/write", json={"path": str(writable)})

    blocker = next(f for f in shown["findings"] if f["key"] == key)
    assert blocker["severity"] == "blocker"
    assert "outside the allowed range" in blocker["message"]
    assert "feed_blocked" in refused
    assert served.status_code == 200, served.text
    assert over_http.status_code == 400
    assert over_http.headers[CODE] == "feed_blocked"
    assert not (writable.parent / "export" / "test_episode.feed.xml").exists()


def test_setting_a_show_person_echoes_the_show_hosts_not_the_episode_credits(
    writable: Path,
) -> None:
    _cli("set", "show", "The Long River", "-p", str(writable))

    out = json.loads(_cli("set", "channel.person[Zed Quill].role", "host", "-p", str(writable)))

    assert out["fact"]["value"] is not None
    assert out["fact"]["value"] == ["Zed Quill (host)"]


def test_an_unreadable_show_is_reported_when_its_own_name_is_set_or_after_unsetting_it(
    writable: Path,
) -> None:
    from podcast_mcp.feed.show_store import default_directory

    _cli("set", "show", "The Long River", "-p", str(writable))
    (default_directory() / "the-long-river.yaml").write_text("pins: [broken", encoding="utf-8")

    same = _cli("set", "show", "The Long River", "-p", str(writable), code=1)
    _cli("unset", "show", "-p", str(writable))
    again = _cli("set", "show", "The Long River", "-p", str(writable), code=1)

    for out in (same, again):
        assert "feed_show_unreadable" in out
        assert "the-long-river.yaml" in out
        assert "feed_show_exists" not in out


def test_a_roster_edit_echoes_the_credits_not_null(episode: Path) -> None:
    out = json.loads(_cli("set", "item.person[Ana Reyes].role", "guest", "-p", str(episode)))

    assert out["fact"] is not None


def test_a_failed_publish_is_a_500_for_the_host_and_an_editor_and_hides_the_folder_from_a_guest(
    writable: Path, published_share
) -> None:
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    _cli("set", "show", "The Long River", "-p", str(writable))
    (writable.parent / "export" / "test_episode.feed.xml").mkdir(parents=True)
    host = TestClient(create_app(), client=("127.0.0.1", 50000))
    guest = TestClient(create_app(), client=("203.0.113.9", 50000))
    token = published_share(capabilities=capabilities_for_role("editor"))[2]["token"]

    on_host = host.post("/api/feed/write", json={"path": str(writable)})
    as_guest = guest.post(f"/api/review/{token}/feed/write")

    assert on_host.status_code == 500
    assert on_host.headers[CODE] == "feed_write_failed"
    assert as_guest.status_code == 500
    assert as_guest.headers[CODE] == "feed_write_failed"
    assert str(writable.parent) not in as_guest.text
    assert "export" not in as_guest.text
