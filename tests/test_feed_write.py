"""Show derive and edits, the feed file writer, the ledger and the export hook."""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from feed_helpers import complete_show
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.export.episode import export_episode_deliverables
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.feed.model import Person
from podcast_mcp.feed.show_store import ShowStore, default_directory
from podcast_mcp.feed.writer import write_after_export, write_feed
from podcast_mcp.models import ChapterMarker, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService
from podcast_mcp.services.document_sync import submit_host_document_command
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.util.coded_error import CodedValueError

FIXTURES = Path(__file__).with_name("fixtures") / "feed"
NS = {
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "podcast": "https://podcastindex.org/namespace/1.0",
    "atom": "http://www.w3.org/2005/Atom",
}
PNG = b"\x89PNG\r\n\x1a\n" + b"cover art bytes"
MOMENT = datetime(2026, 10, 23, 9, 0, tzinfo=UTC)


@pytest.fixture
def store() -> ShowStore:
    return ShowStore(default_directory())


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Ana Reyes")]
    project.chapters = [ChapterMarker(time=0, title="Cold open"), ChapterMarker(time=60, title="B")]
    save_project(project, minimal_project)
    return minimal_project


def _export(path: Path, **files: bytes) -> Path:
    project = load_project(path)
    directory = project.export_dir()
    directory.mkdir(parents=True, exist_ok=True)
    stem = sanitize_export_stem(project.name)
    for extension, data in files.items():
        (directory / f"{stem}.{extension}").write_bytes(data)
    return directory


def _complete(store: ShowStore, name: str = "The Long River", **overrides: object) -> str:
    """A show with every channel fact a feed needs, as the person would have filled it."""
    created = store.create(name)
    full = complete_show()

    def fill(show: object) -> None:
        show.pins.update({k: v for k, v in full.pins.items() if k != "channel.title"})
        show.roster.extend(full.roster)
        show.media_url = full.media_url
        for key, value in overrides.items():
            setattr(show, key, value)

    store.update(created.id, fill)
    return created.id


def _service(path: Path) -> FeedService:
    return FeedService(ProjectWorkspace.open(path))


def _undo(path: Path) -> None:
    head = ProjectWorkspace.open(path).project.history.head_id()
    submit_host_document_command(path, "UndoHistory", {"expected_head_id": head})


def _feed(path: Path) -> ET.Element:
    directory = load_project(path).export_dir()
    return ET.parse(directory / "test_episode.feed.xml").getroot()


def test_with_no_show_the_view_offers_to_create_one(episode: Path) -> None:
    view = _service(episode).read()

    assert view.show.kind == "none"
    assert [f.fix.command for f in view.findings if f.key is None] == ["create_show"]


def test_the_only_show_on_the_machine_is_the_episodes_show_with_no_linking(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)

    view = _service(episode).read()

    assert (view.show.kind, view.show.id) == ("ready", "the-long-river")
    assert load_project(episode).feed.show_id is None
    assert view.channel["channel.title"].value == "The Long River"


def test_two_shows_leave_the_choice_pending_until_one_is_linked(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _complete(store, "Field Notes")

    view = _service(episode).read()
    assert view.show.kind == "choose"
    assert [s.id for s in view.show.shows] == ["field-notes", "the-long-river"]
    assert [f.fix.command for f in view.findings if f.key is None] == ["link_show"]

    linked = _service(episode).set("show", "field-notes", "person")

    assert (linked.show.kind, linked.show.id) == ("ready", "field-notes")
    assert load_project(episode).feed.show_id == "field-notes"


def test_setting_show_to_a_new_name_creates_the_show_and_links_it(
    episode: Path, store: ShowStore
) -> None:
    view = _service(episode).set("show", "The Long River", "person")

    assert (view.show.kind, view.show.id) == ("ready", "the-long-river")
    assert view.channel["channel.title"].value == "The Long River"
    assert load_project(episode).feed.show_id == "the-long-river"
    assert [s.id for s in store.shows()] == ["the-long-river"]


def test_setting_show_to_an_existing_name_links_without_a_second_show(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _complete(store, "Field Notes")

    _service(episode).set("show", "The Long River", "person")

    assert load_project(episode).feed.show_id == "the-long-river"
    assert len(store.shows()) == 2


def test_linking_a_show_undoes_with_history_and_unsetting_unlinks(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _complete(store, "Field Notes")
    service = _service(episode)
    service.set("show", "field-notes", "person")
    entries = len(load_project(episode).history.entries)

    service.set("show", "field-notes", "person")
    assert len(load_project(episode).history.entries) == entries

    service.unset("show", "person")
    assert load_project(episode).feed.show_id is None
    _undo(episode)
    assert load_project(episode).feed.show_id == "field-notes"


def test_a_show_value_is_saved_in_the_show_file_not_the_project(
    episode: Path, store: ShowStore
) -> None:
    _service(episode).set("show", "The Long River", "person")

    view = _service(episode).set("channel.author", "Ana Reyes", "agent")

    assert view.channel["channel.author"].source.by == "agent"
    assert store.profile("the-long-river").pins["channel.author"].value == "Ana Reyes"
    assert load_project(episode).feed.pins == {}


def test_a_show_edit_with_no_show_says_to_create_one(episode: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        _service(episode).set("channel.author", "Ana", "person")

    assert raised.value.code == "feed_show_missing"
    assert "feed set show" in str(raised.value)


def test_a_refused_show_value_changes_nothing(episode: Path, store: ShowStore) -> None:
    _service(episode).set("show", "The Long River", "person")
    path = store.directory / "the-long-river.yaml"
    before = path.read_bytes()

    with pytest.raises(CodedValueError) as raised:
        _service(episode).set("channel.link", "http://not-https.example.test", "person")

    assert raised.value.code == "feed_value_invalid"
    assert path.read_bytes() == before


def test_the_hosting_address_is_the_shows_media_template(episode: Path, store: ShowStore) -> None:
    _service(episode).set("show", "The Long River", "person")

    view = _service(episode).set("channel.mediaUrl", "https://cdn.example.test/lr/{file}", "person")

    assert store.profile("the-long-river").media_url == "https://cdn.example.test/lr/{file}"
    assert view.channel["channel.mediaUrl"].value == "https://cdn.example.test/lr/{file}"
    assert "channel.mediaUrl" not in store.profile("the-long-river").pins
    with pytest.raises(CodedValueError, match="file"):
        _service(episode).set("channel.mediaUrl", "https://cdn.example.test/lr/", "person")
    _service(episode).unset("channel.mediaUrl", "person")
    assert store.profile("the-long-river").media_url is None


def test_the_roster_is_edited_one_person_at_a_time(episode: Path, store: ShowStore) -> None:
    service = _service(episode)
    service.set("show", "The Long River", "person")

    service.set("channel.person[Ana Reyes]", "host", "person")
    service.set("channel.person[Ana Reyes].href", "https://ana.example.test", "person")
    service.set("channel.person[Bo Chen].role", "producer", "person")
    view = service.read()

    assert store.profile("the-long-river").roster == [
        Person("Ana Reyes", role="host", href="https://ana.example.test"),
        Person("Bo Chen", role="producer"),
    ]
    assert view.channel["channel.roster"].value == ["Ana Reyes (host)", "Bo Chen (producer)"]
    assert [c.role for c in view.sections.credits.value] == ["host"]

    service.unset("channel.person[Ana Reyes].href", "person")
    service.unset("channel.person[Bo Chen]", "person")

    assert store.profile("the-long-river").roster == [Person("Ana Reyes", role="host")]


def test_unsetting_a_show_pin_that_is_not_there_writes_nothing(
    episode: Path, store: ShowStore
) -> None:
    _service(episode).set("show", "The Long River", "person")
    path = store.directory / "the-long-river.yaml"
    before = path.stat().st_mtime_ns

    _service(episode).unset("channel.author", "person")
    _service(episode).unset("channel.person[Nobody]", "person")

    assert path.stat().st_mtime_ns == before


def test_a_show_season_is_the_default_until_an_episode_sets_its_own(
    episode: Path, store: ShowStore
) -> None:
    service = _service(episode)
    service.set("show", "The Long River", "person")

    view = service.set("channel.season", 2, "person")
    assert view.item["item.season"].value == 2
    assert view.item["item.season"].source.kind == "inherited"

    view = service.set("item.season", 3, "person")
    assert view.item["item.season"].value == 3


def test_art_can_be_a_file_on_this_machine(episode: Path, store: ShowStore, tmp_path: Path) -> None:
    service = _service(episode)
    service.set("show", "The Long River", "person")
    art = tmp_path / "cover.png"
    art.write_bytes(PNG)

    view = service.set("channel.image", str(art), "person")
    pending = view.channel["channel.image"]
    assert pending.value is None
    assert pending.source.fix.key == "channel.mediaUrl"

    view = service.set("channel.mediaUrl", "https://cdn.example.test/lr/{file}", "person")
    assert (
        view.channel["channel.image"].value == "https://cdn.example.test/lr/test_episode.cover.png"
    )
    with pytest.raises(CodedValueError, match="https address or an existing"):
        service.set("channel.image", str(tmp_path / "nope.png"), "person")


def test_writing_is_refused_while_a_blocker_stands_and_mints_nothing(episode: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        _service(episode).write()

    assert raised.value.code == "feed_blocked"
    assert "needs a show" in str(raised.value)
    assert load_project(episode).feed.guid is None
    assert not (load_project(episode).export_dir() / "test_episode.feed.xml").exists()


def test_writing_makes_the_feed_file_and_gives_the_episode_its_identity_once(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _export(episode, mp3=b"x" * 1234)

    result = _service(episode).write()
    first = load_project(episode).feed

    assert result.path.name == "test_episode.feed.xml"
    assert first.guid and first.guid.startswith("urn:uuid:") and first.first_exported_at
    item = _feed(episode).find("channel/item")
    assert item.find("guid").text == first.guid
    assert item.find("guid").get("isPermaLink") == "false"
    assert (
        item.find("enclosure").get("url") == "https://cdn.example.test/long-river/test_episode.mp3"
    )
    assert item.find("enclosure").get("length") == "1234"

    _service(episode).write()
    assert load_project(episode).feed.guid == first.guid
    assert load_project(episode).feed.first_exported_at == first.first_exported_at


def test_a_second_write_with_nothing_changed_touches_no_file(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    directory = _export(episode, mp3=b"x" * 10)
    _service(episode).write()
    feed = directory / "test_episode.feed.xml"
    os.utime(feed, ns=(1, 1))

    again = _service(episode).write()

    assert again.written == ()
    assert feed.stat().st_mtime_ns == 1
    assert _service(episode).read().file == "current"


def test_the_file_goes_stale_after_an_edit_and_current_after_a_write(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _export(episode, mp3=b"x" * 10)
    service = _service(episode)
    assert service.read().file == "none"
    service.write()
    assert service.read().file == "current"

    edited = service.set("item.intro", "Why the river moved.", "agent")
    assert edited.file == "stale"
    service.write()

    assert service.read().file == "current"
    assert "Why the river moved." in (
        load_project(episode).export_dir() / "test_episode.feed.xml"
    ).read_text(encoding="utf-8")


def test_the_guid_survives_undoing_back_past_the_first_write(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _export(episode, mp3=b"x" * 10)
    service = _service(episode)
    service.set("item.intro", "One.", "person")
    service.write()
    guid = load_project(episode).feed.guid

    _undo(episode)
    _undo(episode)

    assert load_project(episode).feed.guid == guid


def test_episodes_are_numbered_in_the_order_they_are_first_written(
    minimal_project: Path, store: ShowStore, tmp_path: Path
) -> None:
    _complete(store)
    numbers = []
    for name in ("one", "two"):
        project = load_project(minimal_project)
        project.name = name
        project.feed.guid = None
        project.feed.first_exported_at = None
        save_project(project, minimal_project)
        directory = _export(minimal_project, mp3=b"x" * 10)
        FeedService(ProjectWorkspace.open(minimal_project)).write()
        root = ET.parse(directory / f"{name}.feed.xml").getroot()
        numbers.append(root.find("channel/item/itunes:episode", NS).text)
        FeedService(ProjectWorkspace.open(minimal_project)).write()

    assert numbers == ["1", "2"]
    assert len(store.profile("the-long-river").ledger) == 2


def test_an_episode_pin_overrides_the_ledger_number(episode: Path, store: ShowStore) -> None:
    _complete(store)
    _export(episode, mp3=b"x" * 10)
    _service(episode).set("item.episode", 40, "person")

    _service(episode).write()

    assert _feed(episode).find("channel/item/itunes:episode", NS).text == "40"
    assert list(store.profile("the-long-river").ledger.values()) == [40]


def test_the_show_artwork_file_is_copied_into_the_export_set(
    episode: Path, store: ShowStore, tmp_path: Path
) -> None:
    show_id = _complete(store)
    art = tmp_path / "cover.png"
    art.write_bytes(PNG)
    directory = _export(episode, mp3=b"x" * 10)
    _service(episode).set("channel.image", str(art), "person")

    result = _service(episode).write()

    assert {p.name for p in result.written} == {"test_episode.feed.xml", "test_episode.cover.png"}
    assert (directory / "test_episode.cover.png").read_bytes() == art.read_bytes()
    channel = _feed(episode).find("channel")
    assert (
        channel.find("itunes:image", NS).get("href")
        == "https://cdn.example.test/long-river/test_episode.cover.png"
    )
    assert store.profile(show_id).pins["channel.image"].value == str(art)

    art.unlink()
    view = _service(episode).read()
    assert view.channel["channel.image"].value is None
    assert ("channel.image", "warn") in [(f.key, f.severity) for f in view.findings]
    _service(episode).write()
    assert "itunes:image" not in (directory / "test_episode.feed.xml").read_text(encoding="utf-8")


def test_written_xml_matches_the_golden_and_parses_back(episode: Path, store: ShowStore) -> None:
    _complete(
        store,
        media_url="https://cdn.example.test/long-river/{file}",
    )
    store.update(
        "the-long-river",
        lambda show: show.pins.update({"channel.copyright": _pin("2026 The Long River")}),
    )
    directory = _export(episode, mp3=b"x" * 1234, vtt=b"WEBVTT\n")
    project = load_project(episode)
    project.feed.guid = "urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f"
    project.feed.pins = {}
    save_project(project, episode)
    workspace = ProjectWorkspace.open(episode)
    workspace.project.feed.pins["item.intro"] = _pin("Why the river moved.")

    write_feed(workspace.project, store, now=MOMENT)

    text = (directory / "test_episode.feed.xml").read_text(encoding="utf-8")
    golden = FIXTURES / "write_golden.xml"
    if os.environ.get("REGENERATE_FEED_GOLDEN"):
        golden.write_text(text, encoding="utf-8")
    assert text == golden.read_text(encoding="utf-8")
    root = ET.fromstring(text)
    assert root.get("version") == "2.0"
    assert root.find("channel/title").text == "The Long River"
    assert root.find("channel/atom:link", NS).get("href").endswith("/test_episode.feed.xml")
    assert root.find("channel/item/podcast:person", NS).text == "Ana Reyes"
    assert root.find("channel/item/itunes:episode", NS).text == "1"


def _pin(value: object):
    from podcast_mcp.models.feed import Pin

    return Pin(value=value)


def test_two_episodes_writing_at_once_get_different_numbers(
    minimal_project: Path, store: ShowStore
) -> None:
    import threading

    _complete(store)
    errors: list[BaseException] = []

    def work(name: str) -> None:
        try:
            for index in range(8):
                store.number_for("the-long-river", f"urn:uuid:{name}{index}")
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in "ab"]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert sorted(store.profile("the-long-river").ledger.values()) == list(range(1, 17))


def test_an_export_writes_the_feed_file_and_keeps_the_identity_it_minted(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete(store)
    directory = _export(episode, mp3=b"x" * 10, wav=b"w")
    master = directory.parent / "artifacts" / "mastered.wav"
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"mastered")
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.service.pipeline_steps.ensure_current_master",
        lambda *_args: master,
    )
    workspace = ProjectWorkspace.open(episode)

    PipelineService(workspace).export_audio(formats=[])

    assert (directory / "test_episode.feed.xml").is_file()
    assert load_project(episode).feed.guid is not None


def test_an_export_with_nothing_to_write_still_succeeds(episode: Path) -> None:
    project = load_project(episode)
    project.export_dir().mkdir(parents=True, exist_ok=True)
    defaults = load_defaults()
    defaults["export"] = {"formats": []}
    master = project.artifacts_dir() / "mastered.wav"
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"mastered")

    written = export_episode_deliverables(project, MagicMock(), master, defaults)

    assert ".wav" in [p.suffix for p in written]
    assert not (project.export_dir() / "test_episode.feed.xml").exists()
    assert project.feed.guid is None


@pytest.mark.parametrize("fault", [PermissionError("locked"), OSError("disk"), RuntimeError("bug")])
def test_a_feed_file_that_cannot_be_replaced_never_fails_the_export(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch, fault: Exception
) -> None:
    _complete(store)
    directory = _export(episode, mp3=b"x" * 10)
    project = load_project(episode)
    (directory / "test_episode.feed.xml").write_text("<rss/>", encoding="utf-8")

    def locked(*_args: object, **_kwargs: object) -> list[Path]:
        raise fault

    monkeypatch.setattr("podcast_mcp.feed.writer.render_atomic_all", locked)
    defaults = load_defaults()
    defaults["export"] = {"formats": []}
    master = project.artifacts_dir() / "mastered.wav"
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"mastered")

    written = export_episode_deliverables(project, MagicMock(), master, defaults)

    assert written
    assert (directory / "test_episode.feed.xml").read_text(encoding="utf-8") == "<rss/>"
    assert write_after_export(project) is None
    assert _service(episode).read().file == "stale"


def test_the_feed_commands_report_progress_phases(episode: Path, store: ShowStore) -> None:
    from podcast_mcp.util.progress import RecordingProgress, bind_progress

    _complete(store)
    _export(episode, mp3=b"x" * 10)
    recorder = RecordingProgress()

    with bind_progress(recorder):
        service = _service(episode)
        service.read()
        service.set("item.intro", "Hello.", "person")
        service.write()

    phases = [e.phase for e in recorder.events if e.phase]
    assert {"read", "edit", "check", "write"} <= set(phases)


def _master(episode: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = _export(episode, mp3=b"x" * 10, wav=b"w")
    master = directory.parent / "artifacts" / "mastered.wav"
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"mastered")
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.service.pipeline_steps.ensure_current_master",
        lambda *_args: master,
    )
    return directory


def test_identity_minted_by_an_export_survives_a_failed_final_save(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.app.workspace import ProjectWorkspace as Workspace

    _complete(store)
    directory = _master(episode, monkeypatch)
    real, calls = Workspace.save_merged, []

    def flaky(self, *args, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("the final save failed")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Workspace, "save_merged", flaky)

    with pytest.raises(RuntimeError):
        PipelineService(ProjectWorkspace.open(episode)).export_audio(formats=[])

    minted = load_project(episode).feed
    assert minted.guid is not None and minted.show_id == "the-long-river"
    first = _feed(episode).find("channel/item/guid").text
    assert first == minted.guid
    assert list(store.profile("the-long-river").ledger.items()) == [(minted.guid, 1)]

    monkeypatch.setattr(Workspace, "save_merged", real)
    PipelineService(ProjectWorkspace.open(episode)).export_audio(formats=[])

    assert load_project(episode).feed.guid == minted.guid
    assert (directory / "test_episode.feed.xml").is_file()
    assert list(store.profile("the-long-river").ledger.items()) == [(minted.guid, 1)]


def test_a_failed_identity_save_publishes_nothing_and_mints_nothing(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    directory = _export(episode, mp3=b"x" * 10)
    project = load_project(episode)

    def refuse() -> None:
        raise RuntimeError("save failed")

    with pytest.raises(RuntimeError):
        write_feed(project, store, persist=refuse)

    assert project.feed.guid is None and project.feed.show_id is None
    assert not (directory / "test_episode.feed.xml").exists()
    assert store.profile("the-long-river").ledger == {}

    write_feed(project, store, persist=lambda: None)

    assert project.feed.guid is not None
    assert list(store.profile("the-long-river").ledger.values()) == [1]


def test_a_blocker_that_appears_while_the_identity_is_saved_stops_the_write(
    episode: Path, store: ShowStore
) -> None:
    show_id = _complete(store)
    directory = _export(episode, mp3=b"x" * 10)
    project = load_project(episode)

    def concurrent_edit() -> None:
        store.update(show_id, lambda show: show.pins.pop("channel.description"))

    with pytest.raises(CodedValueError) as raised:
        write_feed(project, store, persist=concurrent_edit)

    assert raised.value.code == "feed_blocked"
    assert not (directory / "test_episode.feed.xml").exists()


def test_the_feed_service_and_the_export_hook_write_under_the_render_lock(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.util.project_state import render_lock_held

    _complete(store)
    _export(episode, mp3=b"x" * 10)
    held: list[bool] = []
    real = ShowStore.number_for

    def watch(self, *args, **kwargs):
        held.append(render_lock_held(project))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(ShowStore, "number_for", watch)
    project = load_project(episode)

    _service(episode).write()
    other = load_project(episode)
    other.feed.guid = None
    project = other
    write_after_export(other, store)

    assert held == [True, True]


def test_the_artwork_is_published_before_the_feed_file(
    episode: Path, store: ShowStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.feed import writer

    _complete(store)
    art = tmp_path / "cover.png"
    art.write_bytes(PNG)
    _export(episode, mp3=b"x" * 10)
    _service(episode).set("channel.image", str(art), "person")
    order: list[str] = []
    real = writer.render_atomic_all

    def spy(paths, render, **kwargs):
        order.extend(p.name for p in paths)
        return real(paths, render, **kwargs)

    monkeypatch.setattr(writer, "render_atomic_all", spy)

    _service(episode).write()

    assert order == ["test_episode.cover.png", "test_episode.feed.xml"]


def test_the_first_write_links_the_only_show_so_a_second_show_changes_nothing(
    episode: Path, store: ShowStore
) -> None:
    _complete(store)
    _export(episode, mp3=b"x" * 10)

    _service(episode).write()
    _complete(store, "Field Notes")

    assert load_project(episode).feed.show_id == "the-long-river"
    view = _service(episode).read()
    assert (view.show.kind, view.show.id) == ("ready", "the-long-river")
    assert view.item["item.episode"].value == 1


def test_a_pinned_episode_number_already_used_is_not_assigned_again(
    episode: Path, store: ShowStore
) -> None:
    show_id = _complete(store)
    store.update(show_id, lambda show: show.ledger.update({"urn:uuid:other": 2}))
    _export(episode, mp3=b"x" * 10)
    _service(episode).set("item.episode", 2, "person")

    _service(episode).write()

    ledger = store.profile(show_id).ledger
    assert ledger.pop("urn:uuid:other") == 2
    assert list(ledger.values()) == [3]


def test_a_ledger_with_unusable_numbers_is_flagged_not_fatal(
    episode: Path, store: ShowStore
) -> None:
    show_id = _complete(store)
    store.update(show_id, lambda show: show.ledger.update({"zero": 0, "a": 2, "dup": 2}))
    _export(episode, mp3=b"x" * 10)

    view = _service(episode).read()

    assert ("warn", None) in [(f.severity, f.key) for f in view.findings]
    assert any("episode numbers" in f.message for f in view.findings)
    _service(episode).write()
    assert list(store.profile(show_id).ledger.values())[-1] == 3


def test_a_corrupt_show_file_is_named_in_the_view_and_never_breaks_the_export(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete(store)
    (store.directory / "field-notes.yaml").write_text("pins: [broken", encoding="utf-8")
    directory = _master(episode, monkeypatch)

    view = _service(episode).read()

    assert (view.show.kind, view.show.id) == ("ready", "the-long-river")
    assert any(f.severity == "warn" and "field-notes.yaml" in f.message for f in view.findings)
    PipelineService(ProjectWorkspace.open(episode)).export_audio(formats=[])
    assert (directory / "test_episode.feed.xml").is_file()


def test_an_episode_linked_to_a_corrupt_show_file_still_reads_and_exports(
    episode: Path, store: ShowStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    show_id = _complete(store)
    project = load_project(episode)
    project.feed.show_id = show_id
    save_project(project, episode)
    (store.directory / f"{show_id}.yaml").write_text("pins: [broken", encoding="utf-8")
    _master(episode, monkeypatch)

    view = _service(episode).read()

    assert any(f.severity == "warn" and f"{show_id}.yaml" in f.message for f in view.findings)
    PipelineService(ProjectWorkspace.open(episode)).export_audio(formats=[])
