"""The optional Apple and Podcasting 2.0 rows: each renders what it was checked as, or is refused."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from feed_helpers import StubShow, complete_show, inputs, make_project, mp3, pin
from podcast_mcp.feed.model import ExportFiles, SetEdit
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import checked_value, edited_pins, resolve
from podcast_mcp.services.document import describe_fields
from podcast_mcp.util.coded_error import CodedValueError

NS = {
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "podcast": "https://podcastindex.org/namespace/1.0",
}
GUID = "917393e3-1b1e-5cef-ace4-edaa54e1f810"
OTHER = "3a1e5b2c-0d4f-4c1a-9a4a-1b2c3d4e5f60"

# key, what a person types, the XPath of the element, and its attributes and text
ROWS = [
    ("channel.locked", "yes", "channel/podcast:locked", {}, "yes"),
    ("channel.locked", "no", "channel/podcast:locked", {}, "no"),
    ("channel.type", "serial", "channel/itunes:type", {}, "serial"),
    ("channel.block", "yes", "channel/itunes:block", {}, "Yes"),
    ("channel.complete", "yes", "channel/itunes:complete", {}, "Yes"),
    (
        "channel.newFeedUrl",
        "https://new.example.test/feed.xml",
        "channel/itunes:new-feed-url",
        {},
        "https://new.example.test/feed.xml",
    ),
    ("channel.medium", "music", "channel/podcast:medium", {}, "music"),
    ("channel.updateFrequency", "Weekly", "channel/podcast:updateFrequency", {}, "Weekly"),
    (
        "channel.trailer",
        "https://cdn.example.test/t.mp3 2026-11-01T09:00:00Z Season trailer",
        "channel/podcast:trailer",
        {
            "url": "https://cdn.example.test/t.mp3",
            "pubdate": "Sun, 01 Nov 2026 09:00:00 GMT",
            "type": "audio/mpeg",
        },
        "Season trailer",
    ),
    (
        "channel.publisher",
        f"{GUID} https://pub.example.test/feed.xml",
        "channel/podcast:publisher/podcast:remoteItem",
        {"feedGuid": GUID, "feedUrl": "https://pub.example.test/feed.xml", "medium": "publisher"},
        None,
    ),
    (
        "channel.funding",
        "https://example.test/give Give to the river",
        "channel/podcast:funding",
        {"url": "https://example.test/give"},
        "Give to the river",
    ),
    (
        "channel.funding",
        "https://example.test/give",
        "channel/podcast:funding",
        {"url": "https://example.test/give"},
        "Support the show",
    ),
    (
        "channel.license",
        "cc-by-4.0 https://example.test/license",
        "channel/podcast:license",
        {"url": "https://example.test/license"},
        "cc-by-4.0",
    ),
    ("channel.location", "Mississippi Delta", "channel/podcast:location", {}, "Mississippi Delta"),
    ("channel.txt", "Hello apps", "channel/podcast:txt", {}, "Hello apps"),
    (
        "channel.socialInteract",
        "activitypub https://social.example.test/@lr/1 @lr@social.example.test",
        "channel/podcast:socialInteract",
        {
            "protocol": "activitypub",
            "uri": "https://social.example.test/@lr/1",
            "accountId": "@lr@social.example.test",
        },
        None,
    ),
    (
        "channel.chat",
        "irc irc.example.test #river",
        "channel/podcast:chat",
        {"protocol": "irc", "server": "irc.example.test", "space": "#river"},
        None,
    ),
    (
        "channel.value",
        "02abcdef Ana Reyes",
        "channel/podcast:value/podcast:valueRecipient",
        {"type": "node", "address": "02abcdef", "name": "Ana Reyes", "split": "100"},
        None,
    ),
    (
        "item.alternateEnclosure",
        "https://cdn.example.test/ep.ogg",
        "channel/item/podcast:alternateEnclosure/podcast:source",
        {"uri": "https://cdn.example.test/ep.ogg"},
        None,
    ),
    (
        "item.remoteItem",
        f"{GUID} {OTHER}",
        "channel/item/podcast:remoteItem",
        {"feedGuid": GUID, "itemGuid": OTHER},
        None,
    ),
    ("item.funding", "https://example.test/ep", "channel/item/podcast:funding", {}, None),
    ("item.license", "mit", "channel/item/podcast:license", {}, "mit"),
    ("item.location", "The old mill", "channel/item/podcast:location", {}, "The old mill"),
]


def _world(tmp_path: Path, show_pins: dict[str, object] | None = None):
    project = make_project(tmp_path)
    base = complete_show()
    show = StubShow(**{**base.__dict__, "pins": {**base.pins, **(show_pins or {})}})
    return inputs(project, show=show, files=ExportFiles(audio=mp3()))


def _rendered(tmp_path: Path, key: str, value: str) -> tuple[ET.Element, object]:
    """The feed with ``key`` set as the service would set it: a show row to the show, else a pin."""
    edit = SetEdit(key=key, value=value)
    if key.startswith("channel."):
        world = _world(tmp_path, {key: pin(checked_value(edit)[1])})
        pins: dict = {}
    else:
        world = _world(tmp_path)
        pins = edited_pins(world, {}, edit, "person")
    view = resolve(world, pins)
    return ET.fromstring(render(view)), view


@pytest.mark.parametrize(("key", "line", "path", "attrs", "text"), ROWS)
def test_a_pinned_row_renders_the_element_it_was_checked_as(
    tmp_path: Path, key: str, line: str, path: str, attrs: dict[str, str], text: str | None
) -> None:
    root, _ = _rendered(tmp_path, key, line)

    element = root.find(path, NS)

    assert element is not None
    for name, want in attrs.items():
        assert element.get(name) == want
    if text is not None:
        assert element.text == text


def test_the_podroll_lists_one_remote_item_per_line(tmp_path: Path) -> None:
    root, _ = _rendered(
        tmp_path, "channel.podroll", f"{GUID} https://a.example.test/feed.xml\n{OTHER}\n"
    )

    items = root.findall("channel/podcast:podroll/podcast:remoteItem", NS)

    assert [i.get("feedGuid") for i in items] == [GUID, OTHER]
    assert items[1].get("feedUrl") is None


@pytest.mark.parametrize(
    ("key", "line"),
    [
        ("channel.locked", "maybe"),
        ("channel.type", "weekly"),
        ("channel.block", "no"),
        ("channel.complete", "no"),
        ("channel.newFeedUrl", "http://old.example.test/feed.xml"),
        ("channel.medium", "radio"),
        ("channel.trailer", "https://cdn.example.test/t.mp3 yesterday Trailer"),
        ("channel.trailer", "https://cdn.example.test/t.mp3 2026-11-01T09:00:00 Trailer"),
        ("channel.trailer", "https://cdn.example.test/t.mp3"),
        ("channel.publisher", "short"),
        ("channel.publisher", "not-a-uuid-but-long-enough"),
        ("channel.value", "{}"),
        ("item.value", "not hex!"),
        ("item.remoteItem", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"),
        ("channel.updateFrequency", "w" * 128),
        ("channel.funding", "https://example.test/give " + "m" * 128),
        ("channel.podroll", "   "),
        ("channel.funding", "give-here"),
        ("channel.license", "cc-by http://x.example.test"),
        ("channel.socialInteract", "activitypub"),
        ("channel.chat", "irc"),
        ("item.alternateEnclosure", "https://cdn.example.test/ep"),
        ("item.remoteItem", "tiny"),
    ],
)
def test_a_line_that_cannot_render_is_refused_when_it_is_set(
    tmp_path: Path, key: str, line: str
) -> None:
    with pytest.raises(CodedValueError) as raised:
        checked_value(SetEdit(key=key, value=line))

    assert raised.value.code == "feed_value_invalid"


def test_a_feed_with_none_of_them_carries_none_and_says_nothing_about_them(
    tmp_path: Path,
) -> None:
    view = resolve(_world(tmp_path), {})
    xml = render(view)

    for name in (
        "locked",
        "medium",
        "funding",
        "license",
        "location",
        "txt",
        "value",
        "podroll",
        "publisher",
        "trailer",
        "block",
        "complete",
        "new-feed-url",
        "socialInteract",
        "chat",
        "alternateEnclosure",
        "remoteItem",
    ):
        assert f":{name}" not in xml
    optional = {k for k in view.channel if k.split(".")[1] in {"locked", "block", "funding"}}
    assert optional == set()
    assert {f.severity for f in view.findings if f.key and "." in f.key} <= {"warn", "info"}
    assert all(
        f.key not in {"channel.locked", "channel.funding", "item.funding"} for f in view.findings
    )


def test_the_flags_that_change_how_apps_treat_the_show_say_so_at_info_level(
    tmp_path: Path,
) -> None:
    world = _world(
        tmp_path,
        {
            "channel.block": pin(True),
            "channel.complete": pin(True),
            "channel.newFeedUrl": pin("https://new.example.test/feed.xml"),
        },
    )

    view = resolve(world, {})

    advice = [f for f in view.findings if f.key in world.show.pins and f.severity == "info"]
    assert [f.key for f in advice] == ["channel.block", "channel.complete", "channel.newFeedUrl"]
    assert all(f.platform == "Apple" and f.fix is None for f in advice)


def test_every_optional_row_is_listed_by_feed_fields_with_how_it_is_written() -> None:
    rows = {row["key"]: row for row in describe_fields()}
    wanted = {row[0] for row in ROWS} | {"channel.podroll"}

    assert wanted <= rows.keys()
    for key in wanted:
        assert rows[key]["editable"] is True
        assert rows[key]["tags"]
    assert "Written as" in rows["channel.funding"]["help"]


def test_an_uppercase_scheme_is_an_address_not_a_file_on_this_machine() -> None:
    from podcast_mcp.feed.urls import check_art_ref, is_local_art

    assert not is_local_art("HTTPS://cdn.example.test/x.jpg")
    assert check_art_ref("HTTPS://cdn.example.test/x.jpg") == "HTTPS://cdn.example.test/x.jpg"
    assert is_local_art("/srv/private/x.jpg")
