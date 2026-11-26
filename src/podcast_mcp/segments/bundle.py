"""``.sharecutseg``: one segment in a zip, checked entry by entry before it reaches the library.

The zip holds ``segment.json``, the audio it names and ``MANIFEST.sha256`` (one
``<sha256>  <name>`` line per other file). An import trusts nothing in the zip: names,
sizes and hashes are checked, and nothing is read outside a private staging folder.
"""

from __future__ import annotations

import re
import shutil
import stat
import tempfile
import zipfile
import zlib
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
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
# The zip itself. Studio refuses a larger upload, so export never writes one.
MAX_BUNDLE_BYTES = 1024**3
MAX_ENTRY_BYTES = 1024**3
MAX_MANIFEST_BYTES = 64 * 1024
# FLAC barely compresses. A big entry that deflates far beyond this is a zip bomb.
MAX_RATIO = 100
_RATIO_FLOOR = 1024 * 1024
_ENTRY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MANIFEST_LINE = re.compile(r"^([0-9a-f]{64})  (\S+)$")
_CHUNK = 1 << 20


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


def _no_room(what: str) -> CodedValueError:
    return CodedValueError(
        f"There is not enough free disk space to {what}.", code="segment_no_room"
    )


def _invalid(message: str, code: str = "segment_bundle_invalid") -> CodedValueError:
    return CodedValueError(message, code=code)


def _bundle_code(code: str, prefix: str) -> str:
    """``segment_bundle_invalid`` as ``kit_bundle_invalid`` for a kit file, and so on."""
    return code if prefix == "segment" else code.replace("segment_", f"{prefix}_", 1)


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
        written = atomic_write(out_path, fill, creation_mode=0o644)
        size = written.stat().st_size
    except OSError as exc:
        raise _invalid(
            f"{out_path} could not be written: {exc.strerror or exc}.", "segment_write_failed"
        ) from exc
    try:
        with zipfile.ZipFile(written) as made:
            _checked_entries(made)
    except CodedValueError as exc:
        written.unlink(missing_ok=True)
        raise _invalid(
            f"The segment {segment.name!r} cannot be exported as one file: {exc} "
            "Use fewer or shorter clips.",
            "segment_bundle_too_large",
        ) from exc
    if size > MAX_BUNDLE_BYTES:
        written.unlink(missing_ok=True)
        raise _invalid(
            f"The segment {segment.name!r} is {size // 1024**2} MiB as a file, more than the "
            f"{MAX_BUNDLE_BYTES // 1024**2} MiB a segment file can hold. Use fewer or shorter clips.",
            "segment_bundle_too_large",
        )
    return written


def _checked_entries(
    archive: zipfile.ZipFile,
    *,
    max_entries: int = MAX_ENTRIES,
    name_ok: Callable[[str], bool] | None = None,
    json_names: Sequence[str] = (SEGMENT_JSON,),
    prefix: str = "segment",
    ratio_floor: int = _RATIO_FLOOR,
) -> dict[str, zipfile.ZipInfo]:
    """The entries of ``archive`` once every header is checked; nothing is read yet.

    ``name_ok`` and ``json_names`` let a kit file (several segments, flat names) reuse the
    checks; ``prefix`` is the code prefix of the errors.
    """
    code = _bundle_code("segment_bundle_invalid", prefix)
    infos = archive.infolist()
    if len(infos) > max_entries:
        raise _invalid(f"The bundle has more than {max_entries} files.", code)
    entries: dict[str, zipfile.ZipInfo] = {}
    folded: set[str] = set()
    total = 0
    for info in infos:
        name = info.filename
        safe = bool(_ENTRY_NAME.fullmatch(name)) and ".." not in name
        if not (name_ok(name) if name_ok else safe) or ".." in name:
            if name_ok and safe:
                raise _invalid(f"The bundle holds {name!r}, which is not part of a {prefix}.", code)
            raise _invalid(f"The bundle holds an unsafe file name: {name!r}.", code)
        if name.casefold() in folded:
            raise _invalid(
                f"The bundle lists {name} twice (names are compared ignoring case).", code
            )
        folded.add(name.casefold())
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG):
            raise _invalid(f"The bundle entry {name} is not a plain file.", code)
        limit = (
            MAX_SEGMENT_JSON_BYTES
            if name in json_names
            else MAX_MANIFEST_BYTES
            if name == MANIFEST
            else MAX_ENTRY_BYTES
        )
        if info.file_size > limit:
            raise _invalid(f"The bundle entry {name} is larger than {limit} bytes.", code)
        if info.file_size > ratio_floor and info.file_size > max(info.compress_size, 1) * MAX_RATIO:
            raise _invalid(
                f"The bundle entry {name} is compressed far more than audio can be.", code
            )
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise _invalid("The bundle is larger than 2 GiB when unpacked.", code)
        entries[name] = info
    return entries


def _manifest_hashes(text: str, code: str = "segment_bundle_invalid") -> dict[str, str]:
    hashes: dict[str, str] = {}
    for line in text.splitlines():
        match = _MANIFEST_LINE.fullmatch(line)
        if match is None or match.group(2) in hashes:
            raise _invalid(f"{MANIFEST} has a line this app cannot read.", code)
        hashes[match.group(2)] = match.group(1)
    return hashes


def _unpack(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    dest: Path,
    budget: int,
    prefix: str = "segment",
) -> int:
    """Copy one entry, stopping if it holds more than its header said. Returns bytes written."""
    written = 0
    try:
        with archive.open(info) as source, dest.open("wb") as target:
            while block := source.read(_CHUNK):
                written += len(block)
                if written > info.file_size or written > budget:
                    raise _invalid(
                        f"The bundle entry {info.filename} is larger than it says.",
                        _bundle_code("segment_bundle_invalid", prefix),
                    )
                target.write(block)
    except OSError as exc:
        raise _invalid(
            f"{info.filename} could not be unpacked: {exc.strerror or exc}.",
            _bundle_code("segment_write_failed", prefix),
        ) from exc
    return written


@dataclass(frozen=True)
class BundlePreview:
    """A checked bundle: its segment and the outcome of adding it."""

    segment: SegmentFile
    plan: AddResult


@contextmanager
def _staging_dir(prefix: str = "segment") -> Iterator[str]:
    try:
        directory = tempfile.TemporaryDirectory(prefix=f"sharecut{prefix[:3]}-")
    except OSError as exc:
        raise _invalid(
            f"There is no room to unpack the bundle: {exc.strerror or exc}.",
            _bundle_code("segment_write_failed", prefix),
        ) from exc
    with directory as name:
        yield name


def _verify_bundle(path: Path, root: Path) -> SegmentFile:
    """Unpack ``path`` into ``root`` and check every entry, name and hash; return its segment.

    Both the import and the Studio preview run this, so a file the preview accepts is a file
    the import accepts.
    """
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _invalid("This file is not a segment bundle.") from exc
    with archive:
        entries = _checked_entries(archive)
        if SEGMENT_JSON not in entries or MANIFEST not in entries:
            raise _invalid(f"The bundle needs {SEGMENT_JSON} and {MANIFEST}.")
        budget = MAX_TOTAL_BYTES
        if free_bytes(root) < sum(info.file_size for info in entries.values()):
            raise _no_room("check this file")
        try:
            for name, info in entries.items():
                budget -= _unpack(archive, info, root / name, budget)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise _invalid("This segment bundle cannot be unpacked.") from exc
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
    return segment


def import_bundle(store: SegmentStore, path: Path) -> AddResult:
    """Check a ``.sharecutseg`` file and add its segment to the library."""
    with _staging_dir() as staging:
        _verify_bundle(path, Path(staging))
        return store.add(Path(staging))


def preview_segment_bundle(store: SegmentStore, path: Path) -> BundlePreview:
    """What :func:`import_bundle` would do with ``path``: every check runs, the library is not written."""
    with _staging_dir() as staging:
        segment = _verify_bundle(path, Path(staging))
    return BundlePreview(segment, store.plan_add(segment))


def staged_clip(path: Path, index: int, dest: Path) -> Path:
    """Copy clip ``index`` of an already checked bundle to ``dest``. Raises ``segment_unknown`` past the last clip."""
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo(SEGMENT_JSON)
            if info.file_size > MAX_SEGMENT_JSON_BYTES:
                raise _invalid(f"The bundle entry {SEGMENT_JSON} is too large.")
            segment = parse_segment(archive.read(info))
            if not 0 <= index < len(segment.clips):
                raise CodedValueError(f"The segment has no clip {index}.", code="segment_unknown")
            _unpack(archive, archive.getinfo(segment.clips[index].audio), dest, MAX_TOTAL_BYTES)
    except (OSError, KeyError, zipfile.BadZipFile, zlib.error, EOFError) as exc:
        raise _invalid(f"{path.name} cannot be read.") from exc
    return dest


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
