"""The files an export left in the project's export folder, as a closed set a client can fetch."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from stat import S_ISDIR
from typing import Literal

from podcast_mcp.export.audio import AUDIO_EXPORT_MEDIA
from podcast_mcp.export.chapters import render_chapters_json
from podcast_mcp.export.daw_format import DawFormat
from podcast_mcp.export.names import BOUNCES_DIRNAME, sanitize_export_stem
from podcast_mcp.export.transcript import TRANSCRIPT_FORMATS, TRANSCRIPT_MIME
from podcast_mcp.feed.inputs import feed_path
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.feed import FeedService
from podcast_mcp.services.document.transcript import TranscriptService
from podcast_mcp.services.pipeline import (
    TARGET_INTEGRATED_LUFS,
    completed_variant_files,
    current_source_digest,
    export_config_snapshot,
)
from podcast_mcp.util.coded_error import CodedFileNotFoundError
from podcast_mcp.util.fingerprint import FileStamp, file_stamp
from podcast_mcp.util.zip_stream import ZipMember, stored_zip_length

ExportedFileKind = Literal["audio", "transcript", "chapters", "feed", "bounce", "daw"]

CLIPS_DIRNAME = "clips"
_PARTIAL_TEMP = re.compile(r"\.\d+\.[0-9a-f]{32}\.partial\.")
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
_TRANSCRIPT_LABELS = {
    "txt": "Plain text",
    "md": "Markdown",
    "readable.txt": "Reading copy",
    "srt": "Captions",
    "vtt": "Captions",
}
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
    format: str | None = None


@dataclass(frozen=True)
class ServedFile:
    """A listed file with the host path to stream it from; never serialized."""

    id: str
    kind: ExportedFileKind
    path: Path
    media_type: str
    mtime_ns: int
    size: int
    format: str | None = None
    label: str | None = None
    source_digest: str | None = None

    @property
    def version(self) -> str:
        return f"{self.size}-{self.mtime_ns}"


ListedFiles = list[tuple[ExportedFile, ServedFile]]

ARCHIVE_KINDS: frozenset[ExportedFileKind] = frozenset({"audio", "transcript", "chapters", "feed"})


@dataclass(frozen=True)
class ArchivePlan:
    """The current files of a listing as one stored zip; only ``plan_archive`` builds one."""

    name: str
    members: tuple[ZipMember, ...]
    digest: str
    bytes: int


def plan_archive(listed: ListedFiles, *, stem: str) -> ArchivePlan | None:
    """Pack the current rows of ``ARCHIVE_KINDS`` in listing order; ``None`` when there are none.

    A row whose id is not a plain relative zip name, or repeats an earlier row's, is left out
    rather than renamed, so the plan's count and bytes are exactly what the archive holds.
    """
    members: list[ZipMember] = []
    packed: set[str] = set()
    for entry, served in listed:
        if entry.kind not in ARCHIVE_KINDS or not entry.current or served.id in packed:
            continue
        try:
            members.append(ZipMember(served.id, served.path, served.size, served.mtime_ns))
        except ValueError:
            continue
        packed.add(served.id)
    if not members:
        return None
    lines = "".join(f"{m.name}\0{m.size}-{m.mtime_ns}\n" for m in members)
    return ArchivePlan(
        f"{stem}-export.zip",
        tuple(members),
        hashlib.sha256(lines.encode()).hexdigest()[:32],
        stored_zip_length(members),
    )


def _same_text(path: Path, expected: str) -> bool:
    try:
        return path.read_text(encoding="utf-8") == expected
    except (OSError, ValueError):
        return False


def _directory_stamp(path: Path, *, follow_symlinks: bool) -> FileStamp | None:
    try:
        stamp = path.stat(follow_symlinks=follow_symlinks)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return file_stamp(stamp) if S_ISDIR(stamp.st_mode) else None


class ExportFilesService:
    """Lists and opens only files that an export writer produces, found by their own names.

    A client never supplies a path. ``open`` looks an id up in a fresh listing, so anything
    that is not a regular file inside the export folder (a traversal, a name no writer makes,
    a symlink) is not found.
    """

    def __init__(self, ws: ProjectWorkspace, *, host_files: bool = False) -> None:
        self.ws = ws
        self.host_files = host_files

    def publication_stamp(self) -> tuple[FileStamp | None, ...]:
        """A cheap hint that an atomic export publication changed the folder entries."""
        root = self.ws.project.export_dir()
        return (
            _directory_stamp(root, follow_symlinks=True),
            _directory_stamp(root / CLIPS_DIRNAME, follow_symlinks=False),
            _directory_stamp(root / "variants", follow_symlinks=False),
        )

    def _found(self) -> list[ServedFile]:
        project = self.ws.project
        export_root = project.export_dir()
        root = export_root.resolve()
        stem = sanitize_export_stem(project.name)

        def served(
            relative: str,
            kind: ExportedFileKind,
            media_type: str,
            format: str | None = None,
            label: str | None = None,
            source_digest: str | None = None,
        ) -> ServedFile | None:
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
            if kind == "daw":
                saved_at = datetime.fromtimestamp(stamp.mtime_ns / 1_000_000_000, UTC)
                label = f"Exported {saved_at.isoformat(sep=' ', timespec='milliseconds')[:-6]} UTC"
            return ServedFile(
                relative,
                kind,
                resolved,
                media_type,
                stamp.mtime_ns,
                stamp.size,
                format,
                label,
                source_digest,
            )

        wanted: list[tuple[str, ExportedFileKind, str, str | None]] = [
            (f"{stem}.{ext}", "audio", media, None) for ext, media in AUDIO_EXPORT_MEDIA.items()
        ]

        def audio_children(dirname: str, kind: ExportedFileKind) -> None:
            folder = export_root / dirname
            if not folder.is_dir() or folder.is_symlink():
                return
            wanted.extend(
                (f"{dirname}/{p.name}", kind, AUDIO_EXPORT_MEDIA[p.suffix[1:].lower()], None)
                for p in sorted(folder.iterdir())
                if p.suffix[1:].lower() in AUDIO_EXPORT_MEDIA
                and _plain_name(p.name)
                and not p.name.startswith(".")
                and _PARTIAL_TEMP.search(p.name) is None
            )

        audio_children(CLIPS_DIRNAME, "audio")
        if self.host_files:
            audio_children(BOUNCES_DIRNAME, "bounce")
        wanted.extend(
            (f"{stem}.{fmt}", "transcript", TRANSCRIPT_MIME[fmt], fmt) for fmt in TRANSCRIPT_FORMATS
        )
        wanted.append((f"{stem}.chapters.json", "chapters", _JSON_CHAPTERS_MEDIA, None))
        wanted.append((feed_path(project).name, "feed", _FEED_MEDIA, None))
        found = [
            found
            for relative, kind, media_type, format in wanted
            if (found := served(relative, kind, media_type, format)) is not None
        ]
        if self.host_files and export_root.is_dir() and not export_root.is_symlink():
            packages = []
            for directory in export_root.glob("daw-*"):
                if directory.is_symlink() or not re.fullmatch(r"daw-[0-9a-f]{12}", directory.name):
                    continue
                for format in DawFormat:
                    entry = served(
                        f"{directory.name}/{format.archive_name}", "daw", "application/zip"
                    )
                    if entry:
                        packages.append(entry)
            found.extend(sorted(packages, key=lambda row: (-row.mtime_ns, row.id)))
        for variant in completed_variant_files(project):
            label = (
                f"{variant.target.value.title()} ({TARGET_INTEGRATED_LUFS[variant.target]:g} LUFS) "
                f"· {variant.format.upper()}"
            )
            entry = served(
                variant.file_id,
                "audio",
                AUDIO_EXPORT_MEDIA[variant.format],
                variant.format,
                label,
                variant.source_digest,
            )
            if entry is not None and entry.path == variant.path:
                found.append(entry)
        return found

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
        """Every listed file with the file it was judged from, read in one pass.

        Audio, chapters and the feed are judged against the project here. Transcripts reuse ``TranscriptService.exported`` for ``current``. Chapters are current
        when the file equals a fresh render. The feed is current when the listing's own check
        says so. Canonical audio retains its existing currentness behavior; named variants
        compare their admitted source digest with current source evidence. Saved clips are
        current when candidate metadata references their writer-relative path.
        """
        project = self.ws.project
        found = self._found()
        clip_references = {
            clip.exported_path for clip in project.social_clip_candidates if clip.exported_path
        }
        clip_directory = (project.export_dir() / CLIPS_DIRNAME).relative_to(
            project.workspace_path()
        )
        transcript_files = [entry for entry in found if entry.kind == "transcript"]
        has_variants = any(entry.source_digest is not None for entry in found)
        config = (
            export_config_snapshot(self.ws.effective_config)
            if transcript_files or has_variants
            else None
        )
        source_digest = current_source_digest(project, config) if has_variants else None
        transcript_current = (
            {
                transcript.name: transcript.current
                for transcript in TranscriptService(self.ws).exported(config)
            }
            if transcript_files
            else {}
        )
        chapters_text = render_chapters_json(project.chapters) if project.chapters else None
        feed_current: bool | None = None
        out: ListedFiles = []
        for found_entry in found:
            name = found_entry.path.name
            try:
                size = found_entry.path.stat().st_size
            except OSError:
                continue
            if found_entry.kind == "transcript":
                current = transcript_current.get(name, False)
            elif found_entry.kind == "chapters":
                current = chapters_text is not None and _same_text(found_entry.path, chapters_text)
            elif found_entry.kind == "feed":
                if feed_current is None:
                    feed_current = FeedService(self.ws).read().file != "stale"
                current = feed_current
            elif found_entry.source_digest is not None:
                current = source_digest == found_entry.source_digest
            elif found_entry.kind == "audio" and found_entry.id.startswith(f"{CLIPS_DIRNAME}/"):
                filename = found_entry.id[len(CLIPS_DIRNAME) + 1 :]
                current = str(clip_directory / filename) in clip_references
            else:
                current = True
            entry = ExportedFile(
                id=found_entry.id,
                name=name,
                kind=found_entry.kind,
                label=self._label(found_entry),
                bytes=size,
                current=current,
                format=found_entry.format,
            )
            out.append((entry, found_entry))
        return out

    @staticmethod
    def _label(found: ServedFile) -> str:
        if found.label is not None:
            return found.label
        suffix = found.path.suffix[1:].lower()
        match found.kind:
            case "audio":
                return (
                    "Clip"
                    if found.id.startswith(f"{CLIPS_DIRNAME}/")
                    else _AUDIO_LABELS.get(suffix, _LISTENING_LABEL)
                )
            case "transcript":
                return _TRANSCRIPT_LABELS[found.format or suffix]
            case "chapters":
                return "Chapters"
            case "feed":
                return "Feed file"
            case "daw":
                return "Editable DAW session"
            case "bounce":
                return "Unmastered export"
