"""Stream a stored zip of local files, with its exact length known before the first byte.

CPython's ``zipfile`` writes the archive, so the framing is not ours to maintain. Over a sink
that cannot seek it writes a data descriptor after each entry, which lets one member stream
through at a time. :func:`stored_zip_length` is a pure function of the names and sizes that
predicts the length that layout produces. :func:`stored_zip_chunks` checks itself against it
and fails before the last chunk if CPython ever lays an archive out differently.
"""

from __future__ import annotations

import io
import os
import time
import zipfile
from collections.abc import Generator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from podcast_mcp.util.pinned_media import open_pinned_media

if TYPE_CHECKING:
    from _typeshed import ReadableBuffer

_EARLIEST_DATE = (1980, 1, 1, 0, 0, 0)
_LATEST_SECONDS = 4_300_000_000
_FILE_MODE = 0o644 << 16


@dataclass(frozen=True)
class ZipMember:
    """One file to store. *path* is resolved and already authorized by the caller."""

    name: str
    path: Path
    size: int
    mtime_ns: int

    def __post_init__(self) -> None:
        segments = self.name.split("/")
        if "\\" in self.name or any(segment in ("", ".", "..") for segment in segments):
            raise ValueError(f"zip member name is not a plain relative path: {self.name!r}")


class ZipMemberChanged(OSError):
    """A member no longer matches its planned size or mtime, or read short or long."""


class _Sink(io.RawIOBase):
    def __init__(self) -> None:
        self._pending = bytearray()
        self._position = 0

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def tell(self) -> int:
        return self._position

    def write(self, data: ReadableBuffer, /) -> int:
        view = memoryview(data)
        self._pending += view
        self._position += view.nbytes
        return view.nbytes

    def take(self) -> bytes:
        taken = bytes(self._pending)
        self._pending.clear()
        return taken


def _forces_zip64(size: int) -> bool:
    return size > zipfile.ZIP64_LIMIT // 2


def stored_zip_length(members: Sequence[ZipMember]) -> int:
    """Exact byte length of ``stored_zip_chunks(members)``. Raises ``ValueError`` on duplicate names."""
    names = [member.name for member in members]
    if len(set(names)) != len(names):
        raise ValueError("duplicate zip member name")
    limit = zipfile.ZIP64_LIMIT
    offset = directory = 0
    for member in members:
        name_bytes = len(member.name.encode())
        header_offset = offset
        zip64 = _forces_zip64(member.size)
        offset += 30 + name_bytes + (20 if zip64 else 0) + member.size + (24 if zip64 else 16)
        fields = 2 * (member.size > limit) + (header_offset > limit)
        directory += 46 + name_bytes + (4 + 8 * fields if fields else 0)
    needs_end_record64 = (
        len(members) > zipfile.ZIP_FILECOUNT_LIMIT or offset > limit or directory > limit
    )
    return offset + directory + 22 + (76 if needs_end_record64 else 0)


def _entry_date(mtime_ns: int) -> tuple[int, int, int, int, int, int]:
    moment = time.localtime(min(max(mtime_ns // 1_000_000_000, 0), _LATEST_SECONDS))
    if moment.tm_year < _EARLIEST_DATE[0]:
        return _EARLIEST_DATE
    return (
        moment.tm_year,
        moment.tm_mon,
        moment.tm_mday,
        moment.tm_hour,
        moment.tm_min,
        moment.tm_sec,
    )


def _entry(member: ZipMember) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(member.name, date_time=_entry_date(member.mtime_ns))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = _FILE_MODE
    return info


def _require_planned(source: BinaryIO, member: ZipMember, what: str) -> None:
    stat = os.fstat(source.fileno())
    if (stat.st_size, stat.st_mtime_ns) != (member.size, member.mtime_ns):
        raise ZipMemberChanged(f"{member.name} {what}")


def stored_zip_chunks(
    members: Sequence[ZipMember], *, chunk_size: int = 1 << 20
) -> Generator[bytes]:
    """Stream a stored zip of *members* in order, one member open at a time.

    Each member opens through ``open_pinned_media`` and is checked against its planned
    ``(size, mtime_ns)`` before and after it is read. Raises ``ZipMemberChanged`` on a mismatch, a short read or a long
    read, and ``RuntimeError`` before the last chunk if the total differs from
    ``stored_zip_length``. The generator closes the open member when it is closed or fails.
    """
    expected = stored_zip_length(members)
    sink = _Sink()
    sent = 0
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as archive:
        for member in members:
            with (
                open_pinned_media(member.path) as source,
                archive.open(_entry(member), "w", force_zip64=_forces_zip64(member.size)) as target,
            ):
                _require_planned(source, member, "changed after it was listed")
                remaining = member.size
                while remaining:
                    data = source.read(min(chunk_size, remaining))
                    if not data:
                        raise ZipMemberChanged(f"{member.name} ended early")
                    remaining -= len(data)
                    target.write(data)
                    piece = sink.take()
                    sent += len(piece)
                    yield piece
                if source.read(1):
                    raise ZipMemberChanged(f"{member.name} grew while it was read")
                _require_planned(source, member, "changed while it was read")
            piece = sink.take()
            if piece:
                sent += len(piece)
                yield piece
    tail = sink.take()
    if sent + len(tail) != expected:
        raise RuntimeError("zip layout differs from the predicted length")
    yield tail
