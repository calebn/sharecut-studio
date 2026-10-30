"""The shared (view, fix) -> view golden, consumed here by the Python resolver and renderer.

The web fixture server passes the same file in vitest (``feedGolden.test.ts``), so the
fixture cannot drift from the service. A view is the starting state; this test rebuilds
the episode behind it, applies the fix through ``edited_pins`` and checks what ``resolve``
and ``render`` say. Show creation, linking and writing land with the show store.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from feed_helpers import StubShow, complete_show, mp3, pin
from podcast_mcp.feed.model import (
    ExportFiles,
    FeedEdit,
    FeedInputs,
    FeedView,
    InputFix,
    Person,
    ShowSummary,
)
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import edited_pins, resolve
from podcast_mcp.models import ChapterMarker, EpisodeProject, Track, TrackRole
from podcast_mcp.models.feed import Pin

GOLDEN = json.loads(
    Path(__file__).with_name("fixtures").joinpath("feed", "feed_golden.json").read_text()
)
STALE_BASIS = "a digest from before the chapters changed"
SHOW_CASES = {"create_show", "link_show"}


def _pins(facts: dict[str, Any], *, scope: str) -> dict[str, Pin]:
    found: dict[str, Pin] = {}
    for key, fact in facts.items():
        source = fact["source"]
        if source["kind"] != "pinned" or not key.startswith(scope):
            continue
        basis = STALE_BASIS if source["drifted"] else None
        found[key] = pin(fact["value"], source["by"], basis)
    return found


def _world(tmp_path: Path, view: dict[str, Any], *, feed_xml: str | None = None) -> FeedInputs:
    item, sections = view["item"], view["sections"]
    project = EpisodeProject.create(item["item.title"]["value"], str(tmp_path))
    project.chapters = [
        ChapterMarker(time=c["at"], title=c["title"]) for c in sections["chapters"]["value"]
    ]
    credits = sections["credits"]["value"]
    project.tracks = [
        Track(id=f"t{i}", label=c["name"], role=TrackRole.DIALOGUE, speaker=c["name"])
        for i, c in enumerate(credits)
    ]
    project.feed.guid = item["item.guid"]["value"]
    project.feed.first_exported_at = item["item.pubDate"]["value"]
    # Numbers and a complete show keep the optional-field hints and show checks out of the way.
    project.feed.pins = {
        **_pins(item, scope="item."),
        "item.season": pin(1),
        "item.episode": pin(12),
    }
    audio = sections["audio"]
    kind = view["show"]["kind"]
    show = None
    if kind == "ready":
        base = complete_show(
            media_url=None, roster=[Person(c["name"], role=c["role"]) for c in credits]
        )
        show = StubShow(
            id=view["show"]["id"],
            pins={**base.pins, **_pins(view["channel"], scope="channel.")},
            roster=base.roster,
            media_url=None,
        )
    shows = (
        [ShowSummary(s["id"], s["title"]) for s in view["show"]["shows"]]
        if kind == "choose"
        else []
    )
    files = ExportFiles(
        audio=mp3(audio["source"]["file"], audio["value"]["bytes"]), feed_xml=feed_xml
    )
    return FeedInputs(project=project, show=show, shows=tuple(shows), files=files)


def _start(tmp_path: Path, name: str) -> FeedInputs:
    view = GOLDEN["views"][name]
    first = resolve(_world(tmp_path, view), _world(tmp_path, view).project.feed.pins)
    feed_xml = {"none": None, "current": render(first), "stale": "<rss/>"}[view["file"]]
    return _world(tmp_path, view, feed_xml=feed_xml)


def test_the_copy_matches_the_web_golden_when_the_web_app_has_one() -> None:
    web = Path(__file__).resolve().parents[1] / "gui/web/src/stages/deliver/feedGolden.json"
    if not web.is_file():
        pytest.skip("the Deliver listing section has not landed in this checkout")

    assert json.loads(web.read_text(encoding="utf-8")) == GOLDEN


@pytest.mark.parametrize("name", list(GOLDEN["views"]))
def test_every_golden_view_is_a_valid_python_view_that_serializes_back_unchanged(name: str) -> None:
    view = GOLDEN["views"][name]

    assert FeedView.model_validate(view).wire() == view


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["name"])
def test_the_service_agrees_with_the_golden(case: dict[str, Any], tmp_path: Path) -> None:
    inputs = _start(tmp_path, case["view"])
    pins = dict(inputs.project.feed.pins)
    steps = [case["fix"], *([case["then"]] if "then" in case else [])]
    for fix in steps:
        if fix["kind"] == "edit":
            pins = edited_pins(
                inputs, pins, TypeAdapter(FeedEdit).validate_python(fix["edit"]), "person"
            )
        elif fix["kind"] == "input":
            assert InputFix.model_validate(fix)
        elif fix["command"] in SHOW_CASES or (
            fix["command"] == "write_feed" and not _blocked(inputs, pins)
        ):
            pytest.skip("the show store and the feed writer land with the show slice")
    view = resolve(inputs, pins)
    wire = view.wire()
    want = case["expect"]
    for key, fact in want.get("item", {}).items():
        assert wire["item"].get(key) == fact
    for key, fact in want.get("channel", {}).items():
        assert wire["channel"].get(key) == fact
    if "show" in want:
        assert wire["show"] == want["show"]
    if "file" in want:
        assert wire["file"] == want["file"]
    if "findings" in want:
        assert [{"key": f["key"], "severity": f["severity"]} for f in wire["findings"]] == want[
            "findings"
        ]
    for text in want.get("notesHtmlIncludes", []):
        assert text in wire["notesHtml"]
    for text in want.get("notesHtmlExcludes", []):
        assert text not in wire["notesHtml"]
    item_xml = render(view, item_only=True)
    for text in want.get("itemXmlIncludes", []):
        assert text in item_xml
    for text in want.get("itemXmlExcludes", []):
        assert text not in item_xml


def _blocked(inputs: FeedInputs, pins: dict[str, Pin]) -> bool:
    return any(f.severity == "blocker" for f in resolve(inputs, pins).findings)
