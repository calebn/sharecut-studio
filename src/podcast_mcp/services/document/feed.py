"""The podcast listing for one episode: read it, and edit it through undoable pins."""

from __future__ import annotations

import wave
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.feed.fields import FIELDS, AtSource, FieldSpec, lookup
from podcast_mcp.feed.model import (
    ExportFile,
    ExportFiles,
    FeedEdit,
    FeedInputs,
    FeedView,
    NoShows,
    SetEdit,
    ShowSource,
    UnsetEdit,
)
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import edited_pins, resolve
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.feed import FieldValue, PinAuthor
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.wav import open_wav

FEED_AUDIO_EXTENSIONS = ("mp3", "m4a")
TRANSCRIPT_EXTENSIONS = ("vtt", "srt")


def _file(path: Path) -> ExportFile | None:
    try:
        return ExportFile(name=path.name, bytes=path.stat().st_size) if path.is_file() else None
    except OSError:
        return None


def _wav_seconds(path: Path) -> float | None:
    try:
        with open_wav(path) as reader:
            return reader.getnframes() / reader.getframerate()
    except (wave.Error, EOFError, OSError, ZeroDivisionError):
        return None


def export_files(project: EpisodeProject) -> ExportFiles:
    """What the export directory holds for this episode, found by the export's own file names."""
    directory = project.export_dir()
    stem = sanitize_export_stem(project.name)

    def named(extension: str) -> ExportFile | None:
        return _file(directory / f"{stem}.{extension}")

    audio = next((f for ext in FEED_AUDIO_EXTENSIONS if (f := named(ext))), None)
    wav = named("wav")
    if wav is not None:
        wav = ExportFile(name=wav.name, bytes=wav.bytes, seconds=_wav_seconds(directory / wav.name))
    feed = directory / f"{stem}.feed.xml"
    try:
        feed_xml = feed.read_text(encoding="utf-8") if feed.is_file() else None
    except (OSError, UnicodeDecodeError):
        feed_xml = None
    return ExportFiles(
        audio=audio,
        wav=wav,
        transcripts=tuple(f for ext in TRANSCRIPT_EXTENSIONS if (f := named(ext))),
        feed_xml=feed_xml,
    )


FeedViewKind = Literal["facts", "item_xml", "feed_xml", "notes_html", "show"]


def _edit_text(spec: FieldSpec) -> str:
    if isinstance(spec.edit, AtSource):
        return spec.edit.where
    if spec.edit == "pin" and spec.scope == "show":
        return "Set on the show. Not available yet."
    return {"pin": "feed set", "mint": "made once", "none": "measured or made"}[spec.edit]


def describe_fields() -> list[dict[str, Any]]:
    """The listing rows as plain data: the one source for CLI help, the MCP schema and the docs."""
    return [
        {
            "key": spec.key,
            "scope": spec.scope,
            "label": spec.label,
            "help": spec.help,
            "edit": _edit_text(spec),
            "editable": spec.edit == "pin" and spec.scope == "episode",
            "tags": [t.path + (f"@{t.attr}" if t.attr else "") for t in spec.tags],
        }
        for spec in FIELDS
    ]


def default_show_source() -> ShowSource:
    """Where this machine's shows live. The show store replaces ``NoShows`` here."""
    return NoShows()


class FeedService:
    """``read`` shows the listing; ``apply`` edits it. Every surface calls these."""

    def __init__(self, ws: ProjectWorkspace, shows: ShowSource | None = None) -> None:
        self.ws = ws
        self.shows: ShowSource = shows or default_show_source()

    def inputs(self, project: EpisodeProject) -> FeedInputs:
        shows = tuple(self.shows.shows())
        show_id = project.feed.show_id or (shows[0].id if len(shows) == 1 else None)
        profile = self.shows.profile(show_id) if show_id else None
        return FeedInputs(project=project, show=profile, shows=shows, files=export_files(project))

    def read(self) -> FeedView:
        project = self.ws.project
        return resolve(self.inputs(project), project.feed.pins)

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

    def set(self, key: str, value: FieldValue, by: PinAuthor) -> FeedView:
        return self.apply(SetEdit(key=key, value=value), by)

    def unset(self, key: str, by: PinAuthor) -> FeedView:
        return self.apply(UnsetEdit(key=key), by)

    def apply(self, edit: FeedEdit, by: PinAuthor) -> FeedView:
        """Edit one value as a document command, so it undoes and syncs like any episode edit.

        Setting the empty string unsets. Unsetting a key that holds no pin changes nothing.
        """
        from podcast_mcp.services.document_sync import submit_host_document_command

        project = self.ws.project
        pins = project.feed.pins
        clears = isinstance(edit, UnsetEdit) or edit.value == ""
        if clears and edit.key not in pins:
            return self.read()
        if (spec := lookup(edit.key)) is not None and spec.scope == "show":
            raise CodedValueError(
                "Show settings are not available yet", code="feed_show_unavailable"
            )
        if not clears:
            assert isinstance(edit, SetEdit)
            edited_pins(self.inputs(project), pins, edit, by)
            submit_host_document_command(
                self.ws.path,
                "SetFeedField",
                {"key": edit.key, "value": edit.value, "by": by},
                client_id=f"feed:{by}",
            )
        else:
            submit_host_document_command(
                self.ws.path, "ClearFeedField", {"key": edit.key}, client_id=f"feed:{by}"
            )
        self.ws.reload()
        return self.read()

    def set_field(self, key: str, value: FieldValue, by: PinAuthor) -> dict[str, Any]:
        def pin(project: EpisodeProject) -> dict[str, Any]:
            project.feed.pins = edited_pins(
                self.inputs(project), project.feed.pins, SetEdit(key=key, value=value), by
            )
            return {"key": key, "pinned": key in project.feed.pins}

        return self.ws.mutate("before set listing field", "after set listing field", pin)

    def clear_field(self, key: str) -> dict[str, Any]:
        def clear(project: EpisodeProject) -> dict[str, Any]:
            project.feed.pins = {k: p for k, p in project.feed.pins.items() if k != key}
            return {"key": key, "pinned": False}

        return self.ws.mutate("before clear listing field", "after clear listing field", clear)
