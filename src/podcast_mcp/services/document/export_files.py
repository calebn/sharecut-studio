"""The files an export left in the project's export folder, as a closed set a client can fetch."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from podcast_mcp.export.audio import AUDIO_EXPORT_MEDIA
from podcast_mcp.export.chapters import render_chapters_json
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.export.transcript import TRANSCRIPT_FORMATS, TRANSCRIPT_MIME
from podcast_mcp.feed.inputs import feed_path
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.feed import FeedService
from podcast_mcp.services.document.transcript import TranscriptService
from podcast_mcp.util.coded_error import CodedFileNotFoundError
from podcast_mcp.util.fingerprint import file_stamp

ExportedFileKind = Literal["audio", "transcript", "chapters", "feed"]

CLIPS_DIRNAME = "clips"
_HIDDEN_CHAR_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})
_BIDI_CONTROLS = frozenset(
    "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
)


def _plain_name(name: str) -> bool:
    """False for a name with a control, bidi control or line-separator character in it."""
    return not any(
        char in _BIDI_CONTROLS or unicodedata.category(char) in _HIDDEN_CHAR_CATEGORIES
        for char in name
    )


_AUDIO_LABELS = {"wav": "Lossless master", "flac": "Lossless"}
_LISTENING_LABEL = "Listening file"
_TRANSCRIPT_LABELS = {"txt": "Plain text", "md": "Markdown", "srt": "Captions", "vtt": "Captions"}
_JSON_CHAPTERS_MEDIA = "application/json"
_FEED_MEDIA = "application/rss+xml"


@dataclass(frozen=True)
class ExportedFile:
    """One listed file. ``id`` is its name relative to the export folder, for example ``clips/a.wav``."""

    id: str
    name: str
    kind: ExportedFileKind
    label: str
    bytes: int
    current: bool


ListedFiles = list[tuple[ExportedFile, str]]


@dataclass(frozen=True)
class ServedFile:
    """A listed file with the host path to stream it from; never serialized."""

    id: str
    kind: ExportedFileKind
    path: Path
    media_type: str
    version: str


def _same_text(path: Path, expected: str) -> bool:
    try:
        return path.read_text(encoding="utf-8") == expected
    except (OSError, ValueError):
        return False


class ExportFilesService:
    """Lists and opens only files that an export writer produces, found by their own names.

    A client never supplies a path. ``open`` looks an id up in a fresh listing, so anything
    that is not a regular file inside the export folder (a traversal, a name no writer makes,
    a symlink) is not found.
    """

    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def _found(self) -> list[ServedFile]:
        project = self.ws.project
        export_root = project.export_dir()
        root = export_root.resolve()
        stem = sanitize_export_stem(project.name)

        def served(relative: str, kind: ExportedFileKind, media_type: str) -> ServedFile | None:
            path = export_root / relative
            if path.is_symlink():
                return None
            try:
                resolved = path.resolve(strict=True)
            except OSError:
                return None
            if not resolved.is_file() or not resolved.is_relative_to(root):
                return None
            try:
                stamp = file_stamp(resolved)
            except OSError:
                return None
            return ServedFile(
                relative, kind, resolved, media_type, f"{stamp.size}-{stamp.mtime_ns}"
            )

        wanted: list[tuple[str, ExportedFileKind, str]] = [
            (f"{stem}.{ext}", "audio", media) for ext, media in AUDIO_EXPORT_MEDIA.items()
        ]
        clips = export_root / CLIPS_DIRNAME
        if clips.is_dir() and not clips.is_symlink():
            wanted.extend(
                (f"{CLIPS_DIRNAME}/{p.name}", "audio", AUDIO_EXPORT_MEDIA[p.suffix[1:].lower()])
                for p in sorted(clips.iterdir())
                if p.suffix[1:].lower() in AUDIO_EXPORT_MEDIA and _plain_name(p.name)
            )
        wanted.extend(
            (f"{stem}.{fmt}", "transcript", TRANSCRIPT_MIME[fmt]) for fmt in TRANSCRIPT_FORMATS
        )
        wanted.append((f"{stem}.chapters.json", "chapters", _JSON_CHAPTERS_MEDIA))
        wanted.append((feed_path(project).name, "feed", _FEED_MEDIA))
        return [found for item in wanted if (found := served(*item)) is not None]

    def open(self, file_id: str) -> ServedFile:
        """The listed file *file_id*; raises ``CodedFileNotFoundError`` (``export_file_gone``)."""
        for found in self._found():
            if found.id == file_id:
                return found
        raise CodedFileNotFoundError("That export file is not listed.", code="export_file_gone")

    def list(self) -> list[ExportedFile]:
        """Every listed file; see ``listed``."""
        return [entry for entry, _ in self.listed()]

    def listed(self) -> ListedFiles:
        """Every listed file with its version (size and mtime), read in one pass.

        Audio, chapters and the feed are judged against the project here. Transcripts reuse ``TranscriptService.exported`` for ``current``. Chapters are current
        when the file equals a fresh render. The feed is current when the listing's own check
        says so. Audio has no record of the edit state it was rendered from, so it is always
        reported current; the Deliver status row keeps the stale judgement for it.
        """
        project = self.ws.project
        transcript_current = {t.name: t.current for t in TranscriptService(self.ws).exported()}
        chapters_text = render_chapters_json(project.chapters) if project.chapters else None
        feed_current: bool | None = None
        out: ListedFiles = []
        for found in self._found():
            name = found.path.name
            try:
                size = found.path.stat().st_size
            except OSError:
                continue
            if found.kind == "transcript":
                current = transcript_current.get(name, True)
            elif found.kind == "chapters":
                current = chapters_text is not None and _same_text(found.path, chapters_text)
            elif found.kind == "feed":
                if feed_current is None:
                    feed_current = FeedService(self.ws).read().file != "stale"
                current = feed_current
            else:
                current = True
            entry = ExportedFile(
                id=found.id,
                name=name,
                kind=found.kind,
                label=self._label(found),
                bytes=size,
                current=current,
            )
            out.append((entry, found.version))
        return out

    @staticmethod
    def _label(found: ServedFile) -> str:
        suffix = found.path.suffix[1:].lower()
        match found.kind:
            case "audio":
                return (
                    "Clip"
                    if found.id.startswith(f"{CLIPS_DIRNAME}/")
                    else _AUDIO_LABELS.get(suffix, _LISTENING_LABEL)
                )
            case "transcript":
                return _TRANSCRIPT_LABELS[suffix]
            case "chapters":
                return "Chapters"
            case "feed":
                return "Feed file"
