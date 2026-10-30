"""The shared (view, fix) -> view golden, consumed here by the Python resolver and renderer.

The web fixture server passes the same file in vitest (``feedGolden.test.ts``), so the
fixture cannot drift from the service. A view is the starting state; this test rebuilds
the episode behind it, applies the fix through ``edited_pins`` and checks what ``resolve``
and ``render`` say. Creating a show, linking one and writing the feed file run on a saved
project, a real show store and ``FeedService`` instead.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from feed_helpers import StubShow, complete_show, mp3, pin
from podcast_mcp.export.names import sanitize_export_stem
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
from podcast_mcp.feed.show_store import ShowStore, default_directory
from podcast_mcp.models import ChapterMarker, EpisodeProject, Track, TrackRole, save_project
from podcast_mcp.models.feed import Pin
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService

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


def test_the_copy_matches_the_web_golden() -> None:
    web = Path(__file__).resolve().parents[1] / "gui/web/src/stages/deliver/feedGolden.json"

    assert web.is_file(), "gui/web owns feedGolden.json; this copy must sit beside it"
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
    view = None
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
            view = _run_on_disk(case, fix, tmp_path / "disk")
    view = view or resolve(inputs, pins)
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


def _seed(store: ShowStore, show_id: str, title: str, *, hosts: list[Person]) -> None:
    """A complete show, as the web fixture's shows are: only its title and id differ."""
    store.create(show_id)
    full = complete_show(media_url=None, roster=hosts)
    store.update(
        show_id,
        lambda show: (
            show.pins.update({**full.pins, "channel.title": pin(title)}),
            show.roster.extend(full.roster),
        ),
    )


def _run_on_disk(case: dict[str, Any], fix: dict[str, Any], tmp_path: Path) -> FeedView:
    """The same world on a saved project: the show store and the service decide the view."""
    view = GOLDEN["views"][case["view"]]
    inputs = _world(tmp_path, view)
    project = inputs.project
    audio = view["sections"]["audio"]
    project.ensure_dirs()
    path = save_project(project)
    exported = project.export_dir()
    exported.mkdir(parents=True, exist_ok=True)
    stem = sanitize_export_stem(project.name)
    (exported / f"{stem}.mp3").write_bytes(b"x" * audio["value"]["bytes"])
    if view["file"] == "stale":
        (exported / f"{stem}.feed.xml").write_text("<rss/>", encoding="utf-8")
    store = ShowStore(default_directory())
    hosts = [Person(c["name"], role=c["role"]) for c in view["sections"]["credits"]["value"]]
    for summary in view["show"].get("shows", []):
        _seed(store, summary["id"], summary["title"], hosts=hosts)
    if view["show"]["kind"] == "ready":
        _seed(store, view["show"]["id"], "The Long River", hosts=hosts)
    service = FeedService(ProjectWorkspace.open(path))
    if fix["command"] == "create_show":
        service.set("show", fix["args"]["title"], "person")
        # A created show starts with its title only. Its other facts are filled in as a person
        # fills them, so the findings that remain are the episode's.
        _fill_rest(store, "the-long-river", hosts)
    elif fix["command"] == "link_show":
        service.set("show", fix["args"]["id"], "person")
    else:
        service.write()
    return service.read()


def _fill_rest(store: ShowStore, show_id: str, hosts: list[Person]) -> None:
    full = complete_show(media_url=None, roster=hosts)
    store.update(
        show_id,
        lambda show: (
            show.pins.update({k: v for k, v in full.pins.items() if k != "channel.title"}),
            show.roster.extend(full.roster),
        ),
    )
