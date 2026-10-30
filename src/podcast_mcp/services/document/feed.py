"""The podcast listing for one episode: read it, edit it, and write its feed file.

Episode edits are undoable pins saved through document commands. Show edits go to the show
store under its lock. ``write`` publishes ``<stem>.feed.xml`` beside the exported audio.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from typing import Any, Literal

from podcast_mcp.feed.fields import FIELDS, SHOW_PERSON_KEY, AtSource, FieldSpec, lookup
from podcast_mcp.feed.inputs import export_files, gather_inputs, linked_show_id
from podcast_mcp.feed.model import (
    FeedEdit,
    FeedInputs,
    FeedView,
    Person,
    SetEdit,
    ShowSource,
    UnsetEdit,
)
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import checked_value, cleared_pins, clears, edited_pins, resolve
from podcast_mcp.feed.show_store import ShowFile, ShowStore, default_directory, show_id_for
from podcast_mcp.feed.writer import FeedWrite, write_feed
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.feed import FieldValue, Pin, PinAuthor
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import ProgressTask, resolve_progress_task
from podcast_mcp.util.project_state import render_lock

__all__ = ["FeedService", "FeedViewKind", "describe_fields", "export_files"]

SHOW_KEY = "show"
ROSTER_ATTRS = ("role", "group", "img", "href")
ROSTER_DEFAULTS: dict[str, str | None] = {
    "role": "host",
    "group": "cast",
    "img": None,
    "href": None,
}


@contextmanager
def _progress(phase: str, headline: str) -> Iterator[ProgressTask]:
    """The listing's progress task: reuse the adapter's, or open ``feed`` when called alone."""
    with resolve_progress_task("feed", "Podcast listing", prefer_parent=True) as task:
        task.set_phase(phase, headline)
        yield task


FeedViewKind = Literal["facts", "item_xml", "feed_xml", "notes_html", "show"]

_SHOW_ROW = {
    "key": SHOW_KEY,
    "scope": "episode",
    "label": "show",
    "help": "The show this episode belongs to. A show's name creates it, a show's id chooses it.",
    "edit": "feed set",
    "editable": True,
    "tags": [],
}


def _edit_text(spec: FieldSpec) -> str:
    if isinstance(spec.edit, AtSource):
        return spec.edit.where
    return {"pin": "feed set", "mint": "made once", "none": "measured or made"}[spec.edit]


def describe_fields() -> list[dict[str, Any]]:
    """The listing rows as plain data: the one source for CLI help, the MCP schema and the docs."""
    with _progress("fields", "Listing the fields"):
        return [
            _SHOW_ROW,
            *(
                {
                    "key": spec.key,
                    "scope": spec.scope,
                    "label": spec.label,
                    "help": spec.help,
                    "edit": _edit_text(spec),
                    "editable": spec.edit == "pin",
                    "tags": [t.path + (f"@{t.attr}" if t.attr else "") for t in spec.tags],
                }
                for spec in FIELDS
            ),
        ]


def default_show_source() -> ShowSource:
    """Where this machine's shows live: ``PODCAST_CONFIG_DIR/shows``."""
    return ShowStore(default_directory())


class FeedService:
    """``read`` shows the listing; ``apply`` edits it; ``write`` publishes the feed file."""

    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws
        self.shows: ShowSource = default_show_source()

    def _inputs(self, project: EpisodeProject) -> FeedInputs:
        return gather_inputs(project, self.shows)

    def read(self) -> FeedView:
        with _progress("read", "Reading the listing"):
            return self._read()

    def _read(self) -> FeedView:
        project = self.ws.project
        return resolve(self._inputs(project), project.feed.pins)

    def present(self, kind: FeedViewKind = "facts") -> dict[str, Any] | str:
        """One read in the shape a surface asked for: the wire view, the XML or the notes."""
        view = self.read()
        match kind:
            case "facts":
                return view.wire()
            case "show":
                return view.show.model_dump(mode="json")
            case "notes_html":
                return view.notes_html
            case "item_xml":
                return render(view, item_only=True)
            case "feed_xml":
                return render(view)
            case _:
                raise CodedValueError(
                    f"{kind} is not a view; use facts, item_xml, feed_xml, notes_html or show",
                    code="feed_view_unknown",
                )

    def set(self, key: str, value: FieldValue, by: PinAuthor) -> FeedView:
        return self.apply(SetEdit(key=key, value=value), by)

    def unset(self, key: str, by: PinAuthor) -> FeedView:
        return self.apply(UnsetEdit(key=key), by)

    def apply(self, edit: FeedEdit, by: PinAuthor) -> FeedView:
        """Edit one value. Setting the empty string unsets; unsetting what holds no pin changes nothing.

        An episode value is a document command, so it undoes and syncs like any episode edit.
        A show value is saved in the show store under its lock. ``show`` links or creates the show.
        """
        with _progress("edit", "Saving the change"):
            if edit.key == SHOW_KEY:
                return self._choose_show(edit, by)
            spec = lookup(edit.key)
            if spec is not None and spec.scope == "show":
                return self._apply_show(edit, by)
            return self._apply_episode(edit, by)

    def _apply_episode(self, edit: FeedEdit, by: PinAuthor) -> FeedView:
        from podcast_mcp.services.document_sync import submit_host_document_command

        if clears(edit):
            self.ws.reload()
            if edit.key not in self.ws.project.feed.pins:
                self._pins_after(self.ws.project, edit, by)
                return self._read()
            submit_host_document_command(
                self.ws.path, "ClearFeedField", {"key": edit.key}, client_id=f"feed:{by}"
            )
        else:
            assert isinstance(edit, SetEdit)
            self._pins_after(self.ws.project, edit, by)
            submit_host_document_command(
                self.ws.path,
                "SetFeedField",
                {"key": edit.key, "value": edit.value, "by": by},
                client_id=f"feed:{by}",
            )
        self.ws.reload()
        return self._read()

    def _pins_after(self, project: EpisodeProject, edit: FeedEdit, by: PinAuthor) -> dict[str, Pin]:
        inputs, pins = self._inputs(project), project.feed.pins
        if clears(edit):
            return cleared_pins(inputs, pins, edit.key)
        return edited_pins(inputs, pins, edit, by)

    def _store(self) -> ShowStore:
        if not isinstance(self.shows, ShowStore):
            raise CodedValueError(
                "Show settings are not available yet", code="feed_show_unavailable"
            )
        return self.shows

    def _apply_show(self, edit: FeedEdit, by: PinAuthor) -> FeedView:
        store = self._store()
        project = self.ws.project
        blank = clears(edit)
        show_id = linked_show_id(project, store.shows())
        if show_id is None:
            if blank:
                return self._read()
            raise CodedValueError(
                "This episode has no show yet. Create or choose one with: feed set show <name>",
                code="feed_show_missing",
            )
        value = None
        if not isinstance(edit, UnsetEdit) and not blank:
            value = checked_value(edit)[1]
        store.update(show_id, lambda show: _edit_show(show, edit.key, value, by))
        return self._read()

    def _choose_show(self, edit: FeedEdit, by: PinAuthor) -> FeedView:
        """Link the episode to a show, creating the show first when no show has that name or id."""
        store = self._store()
        project = self.ws.project
        if clears(edit):
            if project.feed.show_id is not None:
                self._link(None)
            return self._read()
        assert isinstance(edit, SetEdit)
        name = str(edit.value).strip()
        ids = {summary.id for summary in store.shows()}
        if edit.link and name not in ids:
            raise CodedValueError(
                "That show is no longer there. Choose another or create a new one.",
                code="feed_show_not_found",
            )
        show_id = name if name in ids else show_id_for(name)
        if show_id not in ids:
            # An unreadable show file is never replaced, or reported as taken, behind the person's back.
            if project.feed.show_id is not None:
                store.profile(project.feed.show_id)
            store.profile(show_id)
            show_id = store.create(name, by).id
        if project.feed.show_id != show_id:
            self._link(show_id)
        return self._read()

    def _link(self, show_id: str | None) -> None:
        def link(project: EpisodeProject) -> None:
            project.feed.show_id = show_id

        self.ws.mutate("before linking the show", "after linking the show", link)
        self.ws.reload()

    def write(self) -> FeedWrite:
        """Write ``<stem>.feed.xml``. Refused while a blocker stands; a second call changes nothing."""
        with _progress("check", "Checking the listing") as task, render_lock(self.ws.project):
            self.ws.reload()
            task.set_phase("write", "Writing the feed file")
            return write_feed(self.ws.project, self.shows, persist=self._save_identity)

    def _save_identity(self) -> None:
        feed = self.ws.project.feed
        guid, first, show_id = feed.guid, feed.first_exported_at, feed.show_id

        def stamp(project: EpisodeProject) -> None:
            project.feed.guid = project.feed.guid or guid
            project.feed.first_exported_at = project.feed.first_exported_at or first
            project.feed.show_id = project.feed.show_id or show_id

        self.ws.mutate("before minting the episode id", "after minting the episode id", stamp)

    def set_field(self, key: str, value: FieldValue, by: PinAuthor) -> dict[str, Any]:
        def pin(project: EpisodeProject) -> dict[str, Any]:
            project.feed.pins = self._pins_after(project, SetEdit(key=key, value=value), by)
            return {"key": key, "pinned": key in project.feed.pins}

        return self.ws.mutate("before set listing field", "after set listing field", pin)

    def clear_field(self, key: str) -> dict[str, Any]:
        def clear(project: EpisodeProject) -> dict[str, Any]:
            project.feed.pins = cleared_pins(self._inputs(project), project.feed.pins, key)
            return {"key": key, "pinned": False}

        return self.ws.mutate("before clear listing field", "after clear listing field", clear)


def _edit_show(show: ShowFile, key: str, value: Any, by: PinAuthor) -> None:
    """Apply one show-scope edit to a show opened for update; ``value`` None removes."""
    if (match := SHOW_PERSON_KEY.match(key)) is not None:
        _edit_roster(show, match["name"].strip(), match["attr"], value)
    elif key == "channel.mediaUrl":
        show.media_url = value
    elif value is None:
        show.pins.pop(key, None)
    else:
        show.pins[key] = Pin(value=value, by=by)


def _edit_roster(show: ShowFile, name: str, attr: str | None, value: Any) -> None:
    found = next(
        (i for i, p in enumerate(show.roster) if p.name.casefold() == name.casefold()), None
    )
    if value is None and attr is None:
        if found is not None:
            del show.roster[found]
        return
    if found is None:
        if value is None:
            return
        show.roster.append(Person(name=name))
        found = len(show.roster) - 1
    changes: dict[str, Any] = {
        attr or "role": ROSTER_DEFAULTS[attr or "role"] if value is None else value
    }
    show.roster[found] = replace(show.roster[found], **changes)
