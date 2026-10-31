"""The segment store: one folder per segment version, changed under a lock.

``<directory>/<id>/v<N>/`` holds ``segment.json`` and the audio it names. A version is
built in a staging folder and lands by one rename, so a reader never sees half a version.
Every change runs under one library lock, so two writers (a CLI call and Studio) never
lose each other's version.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from filelock import Timeout

from podcast_mcp import settings
from podcast_mcp.segments.model import (
    MAX_SEGMENT_JSON_BYTES,
    SEGMENT_JSON,
    SegmentFile,
    is_segment_id,
    parse_segment,
    read_capped,
    segment_id_for,
    segment_json,
)
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.file_locks import hold_shared_file_lock

LOCK_WAIT_SEC = 15.0
_VERSION_DIR = re.compile(r"^v([1-9][0-9]*)$")
_CHUNK = 1 << 20

AddStatus = Literal["added", "unchanged", "new_version"]


@dataclass(frozen=True)
class DamagedSegment:
    """A stored segment that ``list`` could not read, and why."""

    id: str
    version: int
    problem: str
    code: str


@dataclass(frozen=True)
class Listing:
    segments: Sequence[SegmentFile]
    damaged: Sequence[DamagedSegment]


@dataclass(frozen=True)
class AddResult:
    status: AddStatus
    id: str
    version: int

    def wire(self) -> dict[str, str | int]:
        return {"status": self.status, "id": self.id, "version": self.version}


def default_directory() -> Path:
    """``PODCAST_CONFIG_DIR/segments``, with the config directory defaulting as the app's own does."""
    return settings.config_dir() / "segments"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while block := handle.read(_CHUNK):
                digest.update(block)
    except OSError as exc:
        raise CodedValueError(
            f"{path.name} cannot be read: {exc.strerror or exc}.", code="segment_unreadable"
        ) from exc
    return digest.hexdigest()


def verify_media(segment: SegmentFile, directory: Path) -> None:
    """Raise ``segment_hash_mismatch`` unless every file the segment names is there and unchanged."""
    for name, entry in segment.media.items():
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise CodedValueError(
                f"The segment {segment.name!r} is missing its audio file {name}.",
                code="segment_hash_mismatch",
            )
        if path.stat().st_size != entry.bytes or sha256_file(path) != entry.sha256:
            raise CodedValueError(
                f"The audio file {name} of segment {segment.name!r} does not match its recorded hash.",
                code="segment_hash_mismatch",
            )


class SegmentStore:
    """Segments on this machine, in ``directory`` (``PODCAST_CONFIG_DIR/segments``)."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory if directory is not None else default_directory()

    @contextmanager
    def _lock(self) -> Iterator[None]:
        with ExitStack() as stack:
            try:
                stack.enter_context(
                    hold_shared_file_lock(self.directory / ".segments.lock", timeout=LOCK_WAIT_SEC)
                )
            except Timeout as exc:
                raise CodedValueError(
                    "The segment library is being changed by another program. Try again in a moment.",
                    code="segment_busy",
                ) from exc
            except OSError as exc:
                raise CodedValueError(
                    f"The segment library at {self.directory} cannot be opened: "
                    f"{exc.strerror or exc}.",
                    code="segment_write_failed",
                ) from exc
            yield

    def _ids(self) -> Sequence[str]:
        if not self.directory.is_dir():
            return []
        return sorted(
            path.name
            for path in self.directory.iterdir()
            if path.is_dir() and not path.is_symlink() and is_segment_id(path.name)
        )

    def _versions(self, segment_id: str) -> Sequence[int]:
        folder = self.directory / segment_id
        if not folder.is_dir():
            return []
        found = [
            int(match.group(1))
            for path in folder.iterdir()
            if path.is_dir() and (match := _VERSION_DIR.fullmatch(path.name))
        ]
        return sorted(found)

    def versions(self, segment_id: str) -> Sequence[int]:
        if not is_segment_id(segment_id):
            return []
        return self._versions(segment_id)

    def path(self, segment_id: str, version: int | None = None) -> Path:
        """The folder holding one version (the newest by default)."""
        if not is_segment_id(segment_id):
            raise self._unknown(segment_id)
        versions = self._versions(segment_id)
        if not versions:
            raise self._unknown(segment_id)
        chosen = versions[-1] if version is None else version
        if chosen not in versions:
            raise CodedValueError(
                f"The segment {segment_id} has no version {chosen}.", code="segment_unknown"
            )
        return self.directory / segment_id / f"v{chosen}"

    @staticmethod
    def _unknown(segment_id: str) -> CodedValueError:
        return CodedValueError(f"There is no segment called {segment_id}.", code="segment_unknown")

    def _read(self, folder: Path, *, verify: bool = True) -> SegmentFile:
        raw = read_capped(
            folder / SEGMENT_JSON,
            MAX_SEGMENT_JSON_BYTES,
            what=f"The segment folder {folder.parent.name}/{folder.name} "
            "(remove it and import the segment again)",
            code="segment_unreadable",
        )
        segment = parse_segment(raw)
        expected_version = int(folder.name[1:])
        if segment.id != folder.parent.name or segment.version != expected_version:
            raise CodedValueError(
                f"The segment folder {folder.parent.name}/{folder.name} says it is "
                f"{segment.id} v{segment.version}. Remove it and import the segment again.",
                code="segment_unreadable",
            )
        if verify:
            verify_media(segment, folder)
        return segment

    def get(self, segment_id: str, version: int | None = None) -> SegmentFile:
        return self._read(self.path(segment_id, version))

    def scan(self) -> Listing:
        """The newest version of every segment, and the ones that could not be read."""
        found: list[SegmentFile] = []
        damaged: list[DamagedSegment] = []
        for segment_id in self._ids():
            versions = self._versions(segment_id)
            if not versions:
                continue
            try:
                found.append(self._read(self.directory / segment_id / f"v{versions[-1]}"))
            except CodedValueError as exc:
                damaged.append(DamagedSegment(segment_id, versions[-1], str(exc), exc.code))
        return Listing(found, damaged)

    def list(self) -> Sequence[SegmentFile]:
        """The newest readable version of every segment. Use :meth:`scan` to see damaged ones."""
        return self.scan().segments

    def add(self, segment_dir: Path) -> AddResult:
        """Copy the segment in ``segment_dir`` into the library.

        The same content as an intact stored version is ``unchanged``. A stored version whose
        audio no longer matches its hashes does not count, so importing the segment again
        lands as the next version and repairs the library. The same name with other
        content is stored as the next version and never replaces an earlier one.
        """
        raw = read_capped(
            segment_dir / SEGMENT_JSON,
            MAX_SEGMENT_JSON_BYTES,
            what=f"{segment_dir / SEGMENT_JSON}",
            code="segment_invalid",
        )
        incoming = parse_segment(raw)
        expected_id = segment_id_for(incoming.name)
        if incoming.id != expected_id:
            raise CodedValueError(
                f"The segment id {incoming.id!r} does not match its name {incoming.name!r}.",
                code="segment_invalid",
            )
        verify_media(incoming, segment_dir)
        with self._lock():
            existing = self._existing_with_content(incoming.content_sha256)
            if existing is not None:
                return AddResult("unchanged", existing.id, existing.version)
            versions = self._versions(incoming.id)
            version = (versions[-1] if versions else 0) + 1
            stored = incoming.model_copy(update={"version": version})
            self._install(stored, segment_dir)
            return AddResult("new_version" if versions else "added", stored.id, version)

    def _existing_with_content(self, content_sha256: str) -> SegmentFile | None:
        for segment_id in self._ids():
            for version in self._versions(segment_id):
                try:
                    stored = self._read(self.directory / segment_id / f"v{version}", verify=False)
                except CodedValueError:
                    continue
                if stored.content_sha256 != content_sha256:
                    continue
                try:
                    verify_media(stored, self.directory / segment_id / f"v{version}")
                except CodedValueError:
                    continue
                return stored
        return None

    def _install(self, segment: SegmentFile, source: Path) -> None:
        folder = self.directory / segment.id
        staging: Path | None = None
        try:
            folder.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=folder))
            for name in segment.media:
                shutil.copyfile(source / name, staging / name)
            write_text_atomic(staging / SEGMENT_JSON, segment_json(segment))
            verify_media(segment, staging)
            staging.rename(folder / f"v{segment.version}")
        except BaseException as exc:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            if isinstance(exc, OSError):
                raise CodedValueError(
                    f"The segment could not be written to {self.directory}: {exc.strerror or exc}.",
                    code="segment_write_failed",
                ) from exc
            raise

    def remove(self, segment_id: str) -> None:
        """Delete every version of a segment."""
        if not is_segment_id(segment_id):
            raise self._unknown(segment_id)
        with self._lock():
            folder = self.directory / segment_id
            if not folder.is_dir():
                raise self._unknown(segment_id)
            try:
                shutil.rmtree(folder)
            except OSError as exc:
                raise CodedValueError(
                    f"The segment {segment_id} could not be removed: {exc.strerror or exc}.",
                    code="segment_write_failed",
                ) from exc
