from __future__ import annotations

import wave
from pathlib import Path

import pytest

from feed_helpers import StubShow, complete_show
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.feed.model import (
    NoShows,
    SetEdit,
    ShowId,
    ShowProfile,
    ShowSummary,
    UnsetEdit,
)
from podcast_mcp.models import ChapterMarker, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService
from podcast_mcp.services.document import feed as feed_service
from podcast_mcp.services.document.feed import describe_fields
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_document_command
from podcast_mcp.util.coded_error import CodedValueError


class OneShow(NoShows):
    def __init__(self, profile: ShowProfile) -> None:
        self._profile = profile

    def shows(self) -> tuple[ShowSummary, ...]:
        return (ShowSummary(self._profile.id, "The Long River"),)

    def profile(self, show_id: ShowId) -> ShowProfile | None:
        return self._profile if show_id == self._profile.id else None


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Ana Reyes")]
    project.chapters = [ChapterMarker(time=0, title="Cold open")]
    save_project(project, minimal_project)
    return minimal_project


pytestmark = pytest.mark.usefixtures("shown")


@pytest.fixture
def shown(monkeypatch: pytest.MonkeyPatch) -> ShowProfile:
    """The one show on this machine, seen by the service and by the document-command handlers."""
    show = complete_show()
    monkeypatch.setattr(feed_service, "default_show_source", lambda: OneShow(show))
    return show


def _service(path: Path) -> FeedService:
    return FeedService(ProjectWorkspace.open(path))


def _export(path: Path, **files: bytes) -> Path:
    project = load_project(path)
    directory = project.export_dir()
    directory.mkdir(parents=True, exist_ok=True)
    stem = sanitize_export_stem(project.name)
    for extension, data in files.items():
        (directory / f"{stem}.{extension}").write_bytes(data)
    return directory / stem


def _wav(seconds: int, rate: int = 8000) -> bytes:
    import io

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * rate * seconds)
    return buffer.getvalue()


def _move(path: Path, command: str) -> None:
    head = ProjectWorkspace.open(path).project.history.head_id()
    submit_host_document_command(path, command, {"expected_head_id": head})


def _rows(path: Path) -> list[str]:
    return [row["type"] for row in DocumentSyncService.open(path).store.commands_after(0)]


def test_read_with_no_export_and_no_show_names_what_is_missing(
    episode: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(feed_service, "default_show_source", NoShows)
    view = _service(episode).read()

    assert view.show.kind == "none"
    assert view.item["item.title"].value == "test_episode"
    assert view.sections.audio.source.kind == "pending"
    assert view.file == "none"
    assert view.findings[0].severity == "blocker"


def test_read_finds_the_export_and_measures_the_wav_header(episode: Path) -> None:
    _export(episode, mp3=b"x" * 1234, wav=_wav(3), vtt=b"WEBVTT\n", srt=b"1\n")

    view = _service(episode).read()

    assert view.sections.audio.value.bytes == 1234
    assert view.sections.audio.source.file == "test_episode.mp3"
    assert view.item["item.duration"].value == 3
    assert [t.format for t in view.sections.transcripts.value] == ["VTT", "SRT"]
    assert (
        view.item["item.enclosure.url"].value
        == "https://cdn.example.test/long-river/test_episode.mp3"
    )


def test_an_unreadable_wav_leaves_the_duration_pending(episode: Path) -> None:
    _export(episode, mp3=b"x", wav=b"not a wav")

    view = _service(episode).read()

    assert view.item["item.duration"].source.kind == "pending"


def test_a_single_show_on_the_machine_is_the_episodes_show_without_linking(episode: Path) -> None:
    view = _service(episode).read()

    assert view.show.kind == "ready" and view.channel["channel.title"].value == "The Long River"


def test_the_file_is_current_stale_or_absent_against_the_feed_file_on_disk(episode: Path) -> None:
    from podcast_mcp.feed.render import render

    stem = _export(episode, mp3=b"x" * 10)
    service = _service(episode)
    xml = render(service.read())
    stem.with_name(stem.name + ".feed.xml").write_text(xml, encoding="utf-8")

    assert _service(episode).read().file == "current"
    _service(episode).apply(SetEdit(key="item.intro", value="New"), "person")
    assert _service(episode).read().file == "stale"


def test_apply_pins_through_a_document_command_and_stamps_who_edited(episode: Path) -> None:
    service = _service(episode)

    view = service.apply(SetEdit(key="item.intro", value="A walk."), "agent")

    fact = view.item["item.intro"]
    assert (fact.value, fact.source.kind, fact.source.by) == ("A walk.", "pinned", "agent")
    assert _rows(episode) == ["SetFeedField"]
    saved = load_project(episode).feed.pins["item.intro"]
    assert (saved.value, saved.by) == ("A walk.", "agent")
    assert "<p>A walk.</p>" in view.notes_html


def test_an_edit_undoes_and_redoes_through_the_document_plane(episode: Path) -> None:
    service = _service(episode)
    service.apply(SetEdit(key="item.intro", value="First"), "person")
    service.apply(SetEdit(key="item.intro", value="Second"), "person")
    service.apply(UnsetEdit(key="item.intro"), "person")
    assert "item.intro" not in load_project(episode).feed.pins

    _move(episode, "UndoHistory")
    assert load_project(episode).feed.pins["item.intro"].value == "Second"
    _move(episode, "UndoHistory")
    assert load_project(episode).feed.pins["item.intro"].value == "First"
    _move(episode, "UndoHistory")
    assert load_project(episode).feed.pins == {}
    _move(episode, "RedoHistory")
    assert load_project(episode).feed.pins["item.intro"].value == "First"
    assert _rows(episode)[:3] == ["SetFeedField", "SetFeedField", "ClearFeedField"]


def test_keep_mine_resets_the_basis_and_use_new_returns_to_the_composed_notes(
    episode: Path,
) -> None:
    service = _service(episode)
    service.apply(SetEdit(key="item.notes", value="My notes."), "person")
    project = load_project(episode)
    project.chapters.append(ChapterMarker(time=60, title="Later"))
    save_project(project, episode)

    drifted = _service(episode).read()
    assert drifted.item["item.notes"].source.drifted is True
    assert ("item.notes", "info") in [(f.key, f.severity) for f in drifted.findings]

    kept = _service(episode).apply(SetEdit(key="item.notes", value="My notes."), "person")
    assert kept.item["item.notes"].source.drifted is False

    fresh = _service(episode).apply(UnsetEdit(key="item.notes"), "person")
    assert "item.notes" not in fresh.item
    assert "<li>1:00 Later</li>" in fresh.notes_html


def test_unsetting_what_holds_no_pin_writes_nothing(episode: Path) -> None:
    service = _service(episode)
    entries = len(load_project(episode).history.entries)

    service.apply(UnsetEdit(key="item.title"), "person")
    service.apply(SetEdit(key="item.intro", value=""), "person")
    service.apply(SetEdit(key="item.intro", value="  \n"), "person")

    assert _rows(episode) == []
    assert len(load_project(episode).history.entries) == entries


@pytest.mark.parametrize(
    ("edit", "code"),
    [
        (SetEdit(key="item.nope", value="x"), "feed_field_unknown"),
        (SetEdit(key="item.guid", value="x"), "feed_field_not_editable"),
        (SetEdit(key="item.chapters", value="x"), "feed_field_edit_at_source"),
        (
            SetEdit(key="item.enclosure.url", value="http://a.example.test/x.mp3"),
            "feed_value_invalid",
        ),
        (SetEdit(key="channel.title", value="The Long River"), "feed_show_unavailable"),
        (UnsetEdit(key="item.nope"), "feed_field_unknown"),
        (SetEdit(key="item.nope", value=" "), "feed_field_unknown"),
        (UnsetEdit(key="item.person[Nobody].role"), "feed_field_unknown"),
        (SetEdit(key="item.person[Nobody].role", value="host"), "feed_field_unknown"),
        (SetEdit(key="item.person[Ana Reyes].role", value="bogus"), "feed_value_invalid"),
        (SetEdit(key="item.pubDate", value="garbage"), "feed_value_invalid"),
    ],
)
def test_a_refused_edit_leaves_no_journal_row_and_no_history_step(
    episode: Path, edit: SetEdit, code: str
) -> None:
    entries = len(load_project(episode).history.entries)

    with pytest.raises(CodedValueError) as raised:
        _service(episode).apply(edit, "person")

    assert raised.value.code == code
    assert _rows(episode) == []
    assert len(load_project(episode).history.entries) == entries


def test_unsetting_a_show_pin_with_no_show_store_is_refused_not_ignored(episode: Path) -> None:
    project = load_project(episode)
    project.feed.pins["channel.title"] = (
        StubShow().pins.get("channel.title") or complete_show().pins["channel.title"]
    )
    save_project(project, episode)

    with pytest.raises(CodedValueError, match="not available yet"):
        _service(episode).apply(UnsetEdit(key="channel.title"), "person")


def test_linking_a_show_that_is_gone_is_refused_and_creates_nothing(
    episode: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.feed.show_store import ShowStore

    store = ShowStore(tmp_path / "shows")
    monkeypatch.setattr(feed_service, "default_show_source", lambda: store)

    with pytest.raises(CodedValueError) as raised:
        _service(episode).apply(SetEdit(key="show", value="old-show", link=True), "person")

    assert raised.value.code == "feed_show_not_found"
    assert list(store.shows()) == []
    assert load_project(episode).feed.show_id is None


def test_choosing_a_show_by_name_still_creates_it_without_the_link_flag(
    episode: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.feed.show_store import ShowStore

    store = ShowStore(tmp_path / "shows")
    monkeypatch.setattr(feed_service, "default_show_source", lambda: store)

    _service(episode).apply(SetEdit(key="show", value="Fresh Show"), "person")

    assert [summary.title for summary in store.shows()] == ["Fresh Show"]


def test_the_pins_and_identity_survive_save_and_load(episode: Path) -> None:
    _service(episode).apply(SetEdit(key="item.season", value=2), "person")
    project = load_project(episode)
    project.feed.mint_identity()
    save_project(project, episode)

    again = load_project(episode).feed

    assert again.pins["item.season"].value == 2
    assert again.guid and again.first_exported_at and again.show_id is None


def test_the_docs_describe_every_registry_row_and_the_skill_names_every_tool() -> None:
    root = Path(__file__).resolve().parents[1]
    doc = (root / "docs" / "podcast-feed.md").read_text(encoding="utf-8")
    skill = (root / ".agents" / "skills" / "podcast-rss-feed" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert [row["key"] for row in describe_fields() if f"`{row['key']}`" not in doc] == []
    assert [
        tool for tool in ("feed_read", "feed_set", "feed_unset", "feed_write") if tool not in skill
    ] == []


@pytest.mark.parametrize("command", ["SetFeedField", "ClearFeedField"])
def test_the_document_plane_refuses_show_settings_like_the_service(
    episode: Path, command: str
) -> None:
    payload = (
        {"key": "channel.title", "value": "Sneaky"}
        if command == "SetFeedField"
        else {"key": "channel.title"}
    )

    with pytest.raises(CodedValueError) as raised:
        submit_host_document_command(episode, command, payload)

    assert raised.value.code == "feed_show_unavailable"
    assert "channel.title" not in load_project(episode).feed.pins


def test_an_offset_publish_date_is_stored_in_utc_and_the_feed_still_renders(episode: Path) -> None:
    service = _service(episode)

    service.apply(SetEdit(key="item.pubDate", value="2026-10-23T09:00:00+02:00"), "person")

    assert load_project(episode).feed.pins["item.pubDate"].value == "2026-10-23T07:00:00Z"
    assert "<pubDate>Fri, 23 Oct 2026 07:00:00 GMT</pubDate>" in _service(episode).present(
        "item_xml"
    )


def test_an_unknown_view_is_a_coded_error(episode: Path) -> None:
    with pytest.raises(CodedValueError) as raised:
        _service(episode).present("bogus")  # type: ignore[arg-type]

    assert raised.value.code == "feed_view_unknown"


def test_a_feed_file_that_is_not_utf8_reads_as_stale(episode: Path) -> None:
    directory = _export(episode, mp3=b"x" * 10)
    directory.with_name(f"{directory.name}.feed.xml").write_bytes(b"\xff\xfe bad")

    assert _service(episode).read().file == "stale"


def test_the_service_has_one_show_source_for_the_caller_and_the_handler() -> None:
    import inspect

    assert list(inspect.signature(FeedService).parameters) == ["ws"]
    public = {n for n in vars(FeedService) if not n.startswith("_")}
    assert public == {
        "read",
        "present",
        "set",
        "unset",
        "apply",
        "write",
        "set_field",
        "clear_field",
    }


def test_a_blank_value_on_an_unknown_key_is_refused_not_ignored(episode: Path) -> None:
    for edit in (SetEdit(key="item.nope", value=""), SetEdit(key="item.nope", value="   ")):
        with pytest.raises(CodedValueError) as raised:
            _service(episode).apply(edit, "person")

        assert raised.value.code == "feed_field_unknown"


def test_a_host_clear_sees_a_pin_set_after_the_service_opened(episode: Path) -> None:
    stale = _service(episode)
    _service(episode).set("item.intro", "Set meanwhile.", "person")
    assert "item.intro" not in stale.ws.project.feed.pins

    view = stale.unset("item.intro", "person")

    assert load_project(episode).feed.pins == {}
    assert view.item["item.intro"].source.kind != "pinned"
