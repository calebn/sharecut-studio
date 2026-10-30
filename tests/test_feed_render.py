from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from feed_helpers import add_clip, complete_show, inputs, make_project, mp3, pin, with_transcript
from podcast_mcp.feed.model import ExportFile, ExportFiles
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import resolve

NS = {
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "podcast": "https://podcastindex.org/namespace/1.0",
    "atom": "http://www.w3.org/2005/Atom",
    "content": "http://purl.org/rss/1.0/modules/content/",
}

GOLDEN_ITEM = """\
<item>
  <title>Nobody asked the river</title>
  <description><![CDATA[<p>A walk.</p><p>Chapters</p><ol><li>0:00 Cold open</li><li>5:12 The old mill</li></ol><p>With</p><ul><li>Ana Reyes, host</li></ul><p><a href="https://cdn.example.test/long-river/nobody_asked_the_river.vtt">Transcript</a></p>]]></description>
  <content:encoded><![CDATA[<p>A walk.</p><p>Chapters</p><ol><li>0:00 Cold open</li><li>5:12 The old mill</li></ol><p>With</p><ul><li>Ana Reyes, host</li></ul><p><a href="https://cdn.example.test/long-river/nobody_asked_the_river.vtt">Transcript</a></p>]]></content:encoded>
  <pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate>
  <guid isPermaLink="false">urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f</guid>
  <enclosure url="https://cdn.example.test/long-river/nobody_asked_the_river.mp3" length="49920000" type="audio/mpeg"/>
  <itunes:duration>3120</itunes:duration>
  <itunes:explicit>false</itunes:explicit>
  <itunes:season>1</itunes:season>
  <itunes:episode>12</itunes:episode>
  <itunes:episodeType>full</itunes:episodeType>
  <itunes:image href="https://cdn.example.test/long-river/cover.jpg"/>
  <podcast:chapters url="https://cdn.example.test/long-river/nobody_asked_the_river.chapters.json" type="application/json+chapters"/>
  <podcast:transcript url="https://cdn.example.test/long-river/nobody_asked_the_river.vtt" type="text/vtt" language="en"/>
  <podcast:transcript url="https://cdn.example.test/long-river/nobody_asked_the_river.srt" type="application/x-subrip" language="en"/>
  <podcast:person role="host">Ana Reyes</podcast:person>
  <podcast:soundbite startTime="612" duration="41">Nobody asked the river</podcast:soundbite>
</item>
"""


def _view(tmp_path: Path, *, pins=None, files=None, show=None, tweak=None):
    project = make_project(tmp_path)
    with_transcript(project)
    add_clip(project, 612, 653, "Nobody asked the river")
    if tweak:
        tweak(project)
    files = files or ExportFiles(
        audio=mp3(),
        wav=ExportFile("nobody_asked_the_river.wav", 1, 3120.0),
        transcripts=(
            ExportFile("nobody_asked_the_river.vtt", 1),
            ExportFile("nobody_asked_the_river.srt", 1),
        ),
    )
    all_pins = {
        "item.intro": pin("A walk."),
        "item.season": pin(1),
        "item.episode": pin(12),
        **(pins or {}),
    }
    return resolve(inputs(project, show=show or complete_show(), files=files), all_pins)


def test_the_item_is_the_golden_item(tmp_path: Path) -> None:
    assert render(_view(tmp_path), item_only=True) == GOLDEN_ITEM


def test_the_feed_wraps_the_item_in_a_channel_that_parses_back(tmp_path: Path) -> None:
    xml = render(_view(tmp_path))

    root = ET.fromstring(xml)
    channel = root.find("channel")
    assert root.tag == "rss" and root.get("version") == "2.0"
    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>\n')
    assert channel.findtext("title") == "The Long River"
    assert channel.findtext("link") == "https://long-river.example.test"
    assert channel.find("itunes:category", NS).get("text") == "Society & Culture"
    assert channel.findtext("itunes:owner/itunes:email", namespaces=NS) == "ana@example.test"
    atom = channel.find("atom:link", NS)
    assert (atom.get("rel"), atom.get("type")) == ("self", "application/rss+xml")
    assert atom.get("href").endswith("nobody_asked_the_river.feed.xml")
    assert channel.findtext("podcast:guid", namespaces=NS) == "1d949c52-bfd3-56ab-8f3f-b5d3cccf6e21"
    item = channel.find("item")
    assert item.findtext("guid") == "urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f"
    assert item.find("guid").get("isPermaLink") == "false"
    assert item.find("enclosure").attrib == {
        "url": "https://cdn.example.test/long-river/nobody_asked_the_river.mp3",
        "length": "49920000",
        "type": "audio/mpeg",
    }
    assert item.findtext("podcast:person", namespaces=NS) == "Ana Reyes"
    assert len(item.findall("podcast:transcript", NS)) == 2


def test_content_encoded_is_cdata_and_parses_back_to_the_notes_html(tmp_path: Path) -> None:
    view = _view(tmp_path, pins={"item.intro": pin("Tom & Jerry <3 ]]> done")})
    xml = render(view)

    assert "<content:encoded><![CDATA[<p>Tom &amp; Jerry &lt;3 ]]&gt; done</p>" in xml
    item = ET.fromstring(xml).find("channel/item")
    assert item.findtext("content:encoded", namespaces=NS) == view.notes_html
    assert item.findtext("description") == view.notes_html


def test_a_cdata_end_marker_in_pinned_notes_cannot_break_out(tmp_path: Path) -> None:
    view = _view(tmp_path, pins={"item.notes": pin("a ]]> b")})

    item = ET.fromstring(render(view)).find("channel/item")

    assert item.findtext("content:encoded", namespaces=NS) == "<p>a ]]&gt; b</p>"


def test_text_is_escaped_and_xml_illegal_characters_are_dropped(tmp_path: Path) -> None:
    view = _view(tmp_path, pins={"item.title": pin('Rock & "Roll" <live>\x0b\x00!')})

    item = ET.fromstring(render(view)).find("channel/item")

    assert item.findtext("title") == 'Rock & "Roll" <live>!'


def test_nothing_unknown_is_rendered_and_no_placeholder_address_ever_is(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    project.feed.guid = None
    project.feed.first_exported_at = None
    view = resolve(inputs(project, show=None, files=ExportFiles()), {})

    xml = render(view, item_only=True)

    item = ET.fromstring(render(view)).find("channel/item")
    assert [child.tag.rpartition("}")[2] for child in item] == [
        "title",
        "description",
        "encoded",
        "episodeType",
        "person",
    ]
    for fragment in ("http", "{file}", "example", "None", "null", "guid", "pubDate", "enclosure"):
        assert fragment not in xml


def test_hosting_dependent_elements_wait_for_a_hosting_address(tmp_path: Path) -> None:
    view = _view(
        tmp_path,
        show=complete_show(media_url=None),
        pins={"item.enclosure.url": pin("https://cdn.example.test/a.mp3")},
    )

    item = ET.fromstring(render(view)).find("channel/item")

    assert item.find("enclosure").get("url") == "https://cdn.example.test/a.mp3"
    assert item.find("podcast:chapters", NS) is None
    assert item.find("podcast:transcript", NS) is None
    assert "Transcript" not in view.notes_html
    assert ET.fromstring(render(view)).find("channel/atom:link", NS) is None


def test_optional_tags_appear_only_when_set(tmp_path: Path) -> None:
    view = _view(tmp_path, pins={"item.season": pin(2)}, files=ExportFiles(audio=mp3()))

    item = ET.fromstring(render(view)).find("channel/item")

    assert item.findtext("itunes:season", namespaces=NS) == "2"
    assert item.find("itunes:duration", NS) is None
    assert item.find("podcast:transcript", NS) is None


def test_item_persons_carry_their_group_image_and_link(tmp_path: Path) -> None:
    view = _view(
        tmp_path,
        pins={
            "item.person[Ana Reyes].href": pin("https://ana.example.test"),
            "item.person[Ana Reyes].img": pin("https://ana.example.test/a.jpg"),
            "item.person[Ana Reyes].group": pin("crew"),
        },
    )

    person = ET.fromstring(render(view)).find("channel/item/podcast:person", NS)

    assert person.attrib == {
        "role": "host",
        "group": "crew",
        "img": "https://ana.example.test/a.jpg",
        "href": "https://ana.example.test",
    }


def test_soundbite_times_keep_milliseconds_only_when_they_have_them(tmp_path: Path) -> None:
    view = _view(tmp_path, tweak=lambda p: add_clip(p, 10.25, 40.5, ""))

    bite = ET.fromstring(render(view)).find("channel/item/podcast:soundbite", NS)

    assert bite.attrib == {"startTime": "10.25", "duration": "30.25"}
    assert bite.text is None


@pytest.mark.parametrize("item_only", [False, True])
def test_rendering_is_deterministic(tmp_path: Path, item_only: bool) -> None:
    view = _view(tmp_path)

    assert render(view, item_only=item_only) == render(view, item_only=item_only)
