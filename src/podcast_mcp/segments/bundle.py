"""``.sharecutseg``: one segment in a zip, checked entry by entry before it reaches the library.

The zip holds ``segment.json``, the audio it names and ``MANIFEST.sha256`` (one
``<sha256>  <name>`` line per other file). An import trusts nothing in the zip: names,
sizes and hashes are checked, and nothing is read outside a private staging folder.
"""

from __future__ import annotations

import re
import stat
import tempfile
import zipfile
import zlib
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import IO

from podcast_mcp.segments.model import (
    MANIFEST_NAME,
    MAX_SEGMENT_JSON_BYTES,
    SEGMENT_JSON,
    SegmentFile,
    parse_segment,
    read_capped,
)
from podcast_mcp.segments.store import AddResult, SegmentStore, sha256_file
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.coded_error import CodedValueError

MANIFEST = MANIFEST_NAME
MAX_ENTRIES = 64
MAX_TOTAL_BYTES = 2 * 1024**3
MAX_ENTRY_BYTES = 1024**3
MAX_MANIFEST_BYTES = 64 * 1024
# FLAC barely compresses. A big entry that deflates far beyond this is a zip bomb.
MAX_RATIO = 100
_RATIO_FLOOR = 1024 * 1024
_ENTRY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MANIFEST_LINE = re.compile(r"^([0-9a-f]{64})  (\S+)$")
_CHUNK = 1 << 20


def _invalid(message: str, code: str = "segment_bundle_invalid") -> CodedValueError:
    return CodedValueError(message, code=code)


def export_segments(store: SegmentStore, ids: Sequence[str], out_path: Path) -> Path:
    """Write the newest version of the one segment in ``ids`` to ``out_path``."""
    if len(ids) != 1:
        raise _invalid(
            "A .sharecutseg file holds one segment. Export them one at a time.",
            "segment_bundle_unsupported",
        )
    segment = store.get(ids[0])
    folder = store.path(segment.id, segment.version)
    names = [SEGMENT_JSON, *sorted(segment.media)]
    manifest = "".join(f"{sha256_file(folder / name)}  {name}\n" for name in names)

    def fill(handle: IO[bytes]) -> None:
        with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                archive.write(folder / name, name)
            archive.writestr(MANIFEST, manifest)

    try:
        return atomic_write(out_path, fill, creation_mode=0o644)
    except OSError as exc:
        raise _invalid(
            f"{out_path} could not be written: {exc.strerror or exc}.", "segment_write_failed"
        ) from exc


def _checked_entries(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        raise _invalid(f"The bundle has more than {MAX_ENTRIES} files.")
    entries: dict[str, zipfile.ZipInfo] = {}
    folded: set[str] = set()
    total = 0
    for info in infos:
        name = info.filename
        if not _ENTRY_NAME.fullmatch(name) or ".." in name:
            raise _invalid(f"The bundle holds an unsafe file name: {name!r}.")
        if name.casefold() in folded:
            raise _invalid(f"The bundle lists {name} twice (names are compared ignoring case).")
        folded.add(name.casefold())
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG):
            raise _invalid(f"The bundle entry {name} is not a plain file.")
        limit = {SEGMENT_JSON: MAX_SEGMENT_JSON_BYTES, MANIFEST: MAX_MANIFEST_BYTES}.get(
            name, MAX_ENTRY_BYTES
        )
        if info.file_size > limit:
            raise _invalid(f"The bundle entry {name} is larger than {limit} bytes.")
        if (
            info.file_size > _RATIO_FLOOR
            and info.file_size > max(info.compress_size, 1) * MAX_RATIO
        ):
            raise _invalid(f"The bundle entry {name} is compressed far more than audio can be.")
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise _invalid("The bundle is larger than 2 GiB when unpacked.")
        entries[name] = info
    return entries


def _manifest_hashes(text: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for line in text.splitlines():
        match = _MANIFEST_LINE.fullmatch(line)
        if match is None or match.group(2) in hashes:
            raise _invalid(f"{MANIFEST} has a line this app cannot read.")
        hashes[match.group(2)] = match.group(1)
    return hashes


def _unpack(archive: zipfile.ZipFile, info: zipfile.ZipInfo, dest: Path, budget: int) -> int:
    """Copy one entry, stopping if it holds more than its header said. Returns bytes written."""
    written = 0
    try:
        with archive.open(info) as source, dest.open("wb") as target:
            while block := source.read(_CHUNK):
                written += len(block)
                if written > info.file_size or written > budget:
                    raise _invalid(f"The bundle entry {info.filename} is larger than it says.")
                target.write(block)
    except OSError as exc:
        raise _invalid(
            f"{info.filename} could not be unpacked: {exc.strerror or exc}.", "segment_write_failed"
        ) from exc
    return written


@contextmanager
def _staging_dir() -> Iterator[str]:
    try:
        directory = tempfile.TemporaryDirectory(prefix="sharecutseg-")
    except OSError as exc:
        raise _invalid(
            f"There is no room to unpack the bundle: {exc.strerror or exc}.", "segment_write_failed"
        ) from exc
    with directory as name:
        yield name


def import_bundle(store: SegmentStore, path: Path) -> AddResult:
    """Check a ``.sharecutseg`` file and add its segment to the library."""
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _invalid(f"{path.name} is not a segment bundle.") from exc
    with archive, _staging_dir() as staging:
        entries = _checked_entries(archive)
        if SEGMENT_JSON not in entries or MANIFEST not in entries:
            raise _invalid(f"The bundle needs {SEGMENT_JSON} and {MANIFEST}.")
        root = Path(staging)
        budget = MAX_TOTAL_BYTES
        try:
            for name, info in entries.items():
                budget -= _unpack(archive, info, root / name, budget)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise _invalid(f"{path.name} cannot be unpacked.") from exc
        manifest = read_capped(
            root / MANIFEST, MAX_MANIFEST_BYTES, what=MANIFEST, code="segment_bundle_invalid"
        )
        hashes = _manifest_hashes(manifest.decode("utf-8", errors="replace"))
        if set(hashes) != set(entries) - {MANIFEST}:
            raise _invalid(f"The files in the bundle do not match {MANIFEST}.")
        segment = _parse(root / SEGMENT_JSON)
        if set(segment.media) != set(entries) - {MANIFEST, SEGMENT_JSON}:
            raise _invalid("The bundle's files do not match the audio its segment names.")
        for name, expected in hashes.items():
            if sha256_file(root / name) != expected:
                raise _invalid(
                    f"{name} does not match its hash in {MANIFEST}.", "segment_hash_mismatch"
                )
        return store.add(root)


def _parse(path: Path) -> SegmentFile:
    try:
        return parse_segment(
            read_capped(
                path, MAX_SEGMENT_JSON_BYTES, what=SEGMENT_JSON, code="segment_bundle_invalid"
            )
        )
    except CodedValueError as exc:
        if exc.code == "segment_invalid":
            raise _invalid(str(exc)) from exc
        raise
