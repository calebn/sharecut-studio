"""``.sharecutkit``: a kit and its segments in one zip, checked entry by entry.

The zip holds ``kit.json``, ``MANIFEST.sha256`` and, for each segment the kit names, that
segment's ``segment.json`` and audio as flat entries prefixed ``segNN__``. The checks are the
``.sharecutseg`` ones (names, sizes, hashes, zip-bomb ratio) with a larger entry cap, and the
errors carry the ``kit_`` codes.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import zipfile
import zlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Literal

from podcast_mcp.segments import bundle
from podcast_mcp.segments.bundle import (
    MANIFEST,
    MAX_BUNDLE_BYTES,
    MAX_MANIFEST_BYTES,
    _checked_entries,
    _invalid,
    _manifest_hashes,
    _staging_dir,
    _unpack,
)
from podcast_mcp.segments.kit import (
    KIT_JSON,
    MAX_KIT_ENTRIES,
    KitAddResult,
    KitEntry,
    KitFile,
    KitStore,
    kit_id_for,
    kit_json,
    parse_kit,
)
from podcast_mcp.segments.kit_summary import find_missing, missing_text
from podcast_mcp.segments.model import (
    MAX_SEGMENT_JSON_BYTES,
    SEGMENT_JSON,
    SegmentFile,
    parse_segment,
    segment_id_for,
)
from podcast_mcp.segments.store import AddResult, SegmentStore, sha256_file
from podcast_mcp.util.atomic_file import atomic_write, publish_completed_file
from podcast_mcp.util.coded_error import CodedValueError

# 32 segments, each a segment.json and a few audio files (the manifest holds ~330 lines).
BUNDLE_MAX_FILES = 2 + MAX_KIT_ENTRIES * 9
MEMBER_MAX_FILES = 9
_KIT_RATIO_FLOOR = 64 * 1024
_MEMBER = re.compile(r"^seg([0-9]{2})__([A-Za-z0-9][A-Za-z0-9._-]{0,127})$")
_PREFIX = "kit"

ConflictPolicy = Literal["skip", "new-version"]
CONFLICT_POLICIES: tuple[ConflictPolicy, ...] = ("skip", "new-version")


def conflict_policy(value: str) -> ConflictPolicy:
    for policy in CONFLICT_POLICIES:
        if policy == value:
            return policy
    raise CodedValueError(
        f"{value!r} is not a conflict policy. Use skip or new-version.",
        code="kit_on_conflict_invalid",
    )


def _name_ok(name: str) -> bool:
    return name in (KIT_JSON, MANIFEST) or bool(_MEMBER.fullmatch(name))


def _member_name(index: int, name: str) -> str:
    return f"seg{index:02d}__{name}"


def _bundle_error(message: str, code: str = "kit_bundle_invalid") -> CodedValueError:
    return _invalid(message, code)


@dataclass(frozen=True)
class KitImportResult:
    kit: KitAddResult
    segments: Sequence[AddResult]

    def wire(self) -> dict[str, Any]:
        return {"kit": self.kit.wire(), "segments": [s.wire() for s in self.segments]}


def export_kit(kits: KitStore, segments: SegmentStore, kit_id: str, out_path: Path) -> Path:
    """Write the newest version of a kit and the segment versions it uses to ``out_path``.

    The file is built beside ``out_path`` and checked as an import checks it (entry count,
    sizes, ratio, total size); only then does it replace ``out_path``, so a refused export
    leaves an existing file there alone and the app never writes a file its own import refuses.
    """
    kit = kits.get(kit_id)
    missing = find_missing(kit, segments)
    if missing:
        raise CodedValueError(missing_text(missing), code="kit_segment_missing")
    members: list[tuple[SegmentFile, Path]] = []
    seen: set[tuple[str, int]] = set()
    for entry in kit.entries:
        segment = segments.get(entry.segment_id, entry.version)
        if (segment.id, segment.version) not in seen:
            seen.add((segment.id, segment.version))
            members.append((segment, segments.path(segment.id, segment.version)))
    for segment, _ in members:
        if len(segment.media) + 1 > MEMBER_MAX_FILES:
            raise _bundle_error(
                f"The segment {segment.name!r} has more audio files than a kit file can hold "
                f"({MEMBER_MAX_FILES - 1}). Use fewer clips.",
                "kit_bundle_too_large",
            )
    files: list[tuple[str, Path | str]] = [(KIT_JSON, kit_json(kit))]
    for index, (segment, folder) in enumerate(members, start=1):
        for name in [SEGMENT_JSON, *sorted(segment.media)]:
            files.append((_member_name(index, name), folder / name))
    manifest = "".join(
        f"{sha256_file(source) if isinstance(source, Path) else _text_sha(source)}  {name}\n"
        for name, source in files
    )

    def fill(handle: IO[bytes]) -> None:
        with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, source in files:
                if isinstance(source, Path):
                    archive.write(source, name)
                else:
                    archive.writestr(name, source)
            archive.writestr(MANIFEST, manifest)

    part = out_path.with_name(f".{out_path.name}.{secrets.token_hex(8)}.part")
    try:
        written = atomic_write(part, fill, creation_mode=0o644)
        size = written.stat().st_size
    except OSError as exc:
        raise _bundle_error(
            f"{out_path} could not be written: {exc.strerror or exc}.", "kit_write_failed"
        ) from exc
    try:
        with zipfile.ZipFile(written) as made:
            _checked_entries(
                made,
                max_entries=BUNDLE_MAX_FILES,
                name_ok=_name_ok,
                json_names=[KIT_JSON, *(n for n, _ in files if n.endswith(f"__{SEGMENT_JSON}"))],
                prefix=_PREFIX,
                ratio_floor=_KIT_RATIO_FLOOR,
            )
    except CodedValueError as exc:
        written.unlink(missing_ok=True)
        raise _bundle_error(
            f"The kit {kit.name!r} cannot be exported as one file: {exc} "
            "Use fewer or shorter clips.",
            "kit_bundle_too_large",
        ) from exc
    if size > MAX_BUNDLE_BYTES:
        written.unlink(missing_ok=True)
        raise _bundle_error(
            f"The kit {kit.name!r} is {size // 1024**2} MiB as a file, more than the "
            f"{MAX_BUNDLE_BYTES // 1024**2} MiB a kit file can hold. Use fewer or shorter clips.",
            "kit_bundle_too_large",
        )
    try:
        return publish_completed_file(written, out_path)
    except OSError as exc:
        raise _bundle_error(
            f"{out_path} could not be written: {exc.strerror or exc}.", "kit_write_failed"
        ) from exc


def _text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _as_kit_error(exc: CodedValueError) -> CodedValueError:
    """A member segment's refusal, said in the kit's codes."""
    mapped = {
        "segment_invalid": "kit_bundle_invalid",
        "segment_bundle_invalid": "kit_bundle_invalid",
        "segment_schema_unsupported": "kit_schema_unsupported",
        "segment_hash_mismatch": "kit_hash_mismatch",
        "segment_busy": "kit_busy",
        "segment_no_room": "kit_no_room",
        "segment_write_failed": "kit_write_failed",
    }.get(exc.code)
    return CodedValueError(str(exc), code=mapped) if mapped else exc


def _read_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    """One small entry, read straight from the zip (never more than ``limit`` bytes)."""
    try:
        with archive.open(info) as source:
            data = source.read(limit + 1)
    except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
        raise _bundle_error(f"{info.filename} cannot be unpacked.") from exc
    if len(data) > limit:
        raise _bundle_error(f"The bundle entry {info.filename} is larger than it says.")
    return data


def _check_small(name: str, data: bytes, hashes: dict[str, str]) -> None:
    if hashlib.sha256(data).hexdigest() != hashes[name]:
        raise _bundle_error(f"{name} does not match its hash in {MANIFEST}.", "kit_hash_mismatch")


class KitImportIncomplete(CodedValueError):
    """A kit import that stopped after some of its segments were added.

    ``code`` is the refusal that stopped it (``kit_busy``, ``kit_no_room``, ``kit_write_failed``,
    ...). ``added`` holds the segments this import put in the library; the kit was not saved,
    so importing the same file again finishes the job and adds nothing twice.
    """

    def __init__(self, message: str, *, code: str, added: Sequence[AddResult], total: int) -> None:
        super().__init__(message, code=code)
        self.added = list(added)
        self.total = total


@dataclass(frozen=True)
class _Verified:
    kit: KitFile
    members: list[_Member]
    mapped: list[tuple[str, int]]


@dataclass(frozen=True)
class PlannedSegment:
    segment: SegmentFile
    plan: AddResult


@dataclass(frozen=True)
class PlannedEntry:
    position: int
    entry: KitEntry
    planned: PlannedSegment


@dataclass(frozen=True)
class KitPreview:
    """A checked kit file: what each segment and the kit would become, nothing written."""

    kit: KitFile
    segments: Sequence[PlannedSegment]
    entries: Sequence[PlannedEntry]
    plan: KitAddResult


def _verify_kit_bundle(path: Path, root: Path) -> _Verified:
    """Check every entry, name and hash of ``path`` and unpack its segments under ``root``.

    Order: headers, then ``kit.json``, the manifest and every ``segment.json`` are read
    straight from the zip and checked against each other (every member must be named by a
    kit entry, every entry must find its member); only then is audio unpacked, with a budget
    of the declared sizes, and hashed. Nothing outside ``root`` is written. The import and
    the Studio preview both run this, so a file the preview accepts is a file the import accepts.
    """
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _bundle_error(f"{path.name} is not a kit bundle.") from exc
    with archive:
        json_names = [
            info.filename
            for info in archive.infolist()
            if (m := _MEMBER.fullmatch(info.filename)) and m.group(2) == SEGMENT_JSON
        ]
        entries = _checked_entries(
            archive,
            max_entries=BUNDLE_MAX_FILES,
            name_ok=_name_ok,
            json_names=[KIT_JSON, *json_names],
            prefix=_PREFIX,
            ratio_floor=_KIT_RATIO_FLOOR,
        )
        if KIT_JSON not in entries or MANIFEST not in entries:
            raise _bundle_error(f"The bundle needs {KIT_JSON} and {MANIFEST}.")
        manifest = _read_entry(archive, entries[MANIFEST], MAX_MANIFEST_BYTES)
        hashes = _manifest_hashes(manifest.decode("utf-8", errors="replace"), "kit_bundle_invalid")
        if set(hashes) != set(entries) - {MANIFEST}:
            raise _bundle_error(f"The files in the bundle do not match {MANIFEST}.")
        kit_raw = _read_entry(archive, entries[KIT_JSON], MAX_SEGMENT_JSON_BYTES)
        _check_small(KIT_JSON, kit_raw, hashes)
        kit = _checked_kit(kit_raw)
        members = _read_members(archive, entries, hashes)
        mapped = _check_kit_against_members(kit, members)
        stray = [m.index for m in members if (m.segment.id, m.segment.version) not in set(mapped)]
        if stray:
            raise _bundle_error(f"The bundle holds segment {stray[0]} that no kit entry names.")
        budget = sum(info.file_size for info in entries.values())
        if bundle.free_bytes(root) < budget:
            raise _bundle_error(
                "There is not enough free disk space to check this file.", "kit_no_room"
            )
        try:
            for name, info in entries.items():
                if (match := _MEMBER.fullmatch(name)) is None:
                    continue
                dest = root / f"seg{match.group(1)}" / match.group(2)
                dest.parent.mkdir(exist_ok=True)
                budget -= _unpack(archive, info, dest, budget, _PREFIX)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise _bundle_error(f"{path.name} cannot be unpacked.") from exc
    for name, expected in hashes.items():
        if (match := _MEMBER.fullmatch(name)) is None:
            continue
        source = root / f"seg{match.group(1)}" / match.group(2)
        if sha256_file(source) != expected:
            raise _bundle_error(
                f"{name} does not match its hash in {MANIFEST}.", "kit_hash_mismatch"
            )
    return _Verified(kit, members, mapped)


def _rewritten(verified: _Verified, results: dict[tuple[str, int], AddResult]) -> KitFile:
    """The kit with each entry pointed at the segment version this library has (or will have)."""
    return verified.kit.model_copy(
        update={
            "entries": [
                entry.model_copy(
                    update={
                        "segment_id": results[verified.mapped[i]].id,
                        "version": results[verified.mapped[i]].version if entry.version else None,
                    }
                )
                for i, entry in enumerate(verified.kit.entries)
            ]
        }
    )


def _incomplete(exc: CodedValueError, results: Sequence[AddResult], total: int) -> CodedValueError:
    landed = [r for r in results if r.status != "unchanged"]
    if not landed:
        return exc
    return KitImportIncomplete(
        f"{exc} {len(landed)} of {total} segments were added to your library before this "
        "stopped, and the kit was not saved. Try again to finish.",
        code=exc.code,
        added=landed,
        total=total,
    )


def import_kit_bundle(
    kits: KitStore,
    segments: SegmentStore,
    path: Path,
    *,
    on_conflict: ConflictPolicy = "new-version",
) -> KitImportResult:
    """Check a ``.sharecutkit`` file, add its missing segments, then add the kit.

    The library is written only after :func:`_verify_kit_bundle` holds. Segments land with
    the library's own dedupe (``unchanged`` / ``new_version``). The kit is stored as the next
    version when its id exists with other entries (``new-version``) or left alone (``skip``).
    Importing the same file again changes nothing. A pinned version in the file is rewritten
    to the version the segment has in this library. When a segment or the kit cannot be
    written after earlier segments landed, :class:`KitImportIncomplete` names those segments
    and the same file can be imported again to finish.
    """
    conflict_policy(on_conflict)
    with _staging_dir(_PREFIX) as staging:
        root = Path(staging)
        verified = _verify_kit_bundle(path, root)
        added: dict[tuple[str, int], AddResult] = {}
        results: list[AddResult] = []
        for member in verified.members:
            try:
                result = segments.add(root / f"seg{member.index}")
            except CodedValueError as exc:
                raise _incomplete(_as_kit_error(exc), results, len(verified.members)) from exc
            added[(member.segment.id, member.segment.version)] = result
            results.append(result)
        try:
            kit_result = kits.add(_rewritten(verified, added), keep_existing=on_conflict == "skip")
        except CodedValueError as exc:
            raise _incomplete(exc, results, len(verified.members)) from exc
        return KitImportResult(kit_result, results)


def _plan_segments(segments: SegmentStore, members: Sequence[_Member]) -> list[AddResult]:
    """What adding each member in order would do, each seeing the ones planned before it."""
    plans: list[AddResult] = []
    by_content: dict[str, AddResult] = {}
    newest: dict[str, int] = {}
    for member in members:
        try:
            plan = segments.plan_add(member.segment)
        except CodedValueError as exc:
            raise _as_kit_error(exc) from exc
        if plan.status != "unchanged":
            earlier = by_content.get(member.segment.content_sha256)
            if earlier is not None:
                plan = AddResult("unchanged", earlier.id, earlier.version)
            else:
                version = max(plan.version, newest.get(plan.id, 0) + 1)
                plan = AddResult("new_version" if version > 1 else "added", plan.id, version)
                by_content[member.segment.content_sha256] = plan
                newest[plan.id] = version
        plans.append(plan)
    return plans


def preview_kit_bundle(
    kits: KitStore,
    segments: SegmentStore,
    path: Path,
    *,
    on_conflict: ConflictPolicy = "new-version",
) -> KitPreview:
    """What :func:`import_kit_bundle` would do with ``path``: every check runs, nothing is written."""
    conflict_policy(on_conflict)
    with _staging_dir(_PREFIX) as staging:
        verified = _verify_kit_bundle(path, Path(staging))
    plans = _plan_segments(segments, verified.members)
    planned = [PlannedSegment(m.segment, p) for m, p in zip(verified.members, plans, strict=True)]
    by_key = {
        (m.segment.id, m.segment.version): p for m, p in zip(verified.members, plans, strict=True)
    }
    stored = _rewritten(verified, by_key)
    by_member = {
        (m.segment.id, m.segment.version): item
        for m, item in zip(verified.members, planned, strict=True)
    }
    entries = [
        PlannedEntry(position, entry, by_member[verified.mapped[position - 1]])
        for position, entry in enumerate(verified.kit.entries, start=1)
    ]
    plan = kits.plan(stored, keep_existing=on_conflict == "skip")
    return KitPreview(verified.kit, planned, entries, plan)


def _checked_kit(raw: bytes) -> KitFile:
    kit = parse_kit(raw)
    if kit.id != kit_id_for(kit.name):
        raise CodedValueError(
            f"The kit id {kit.id!r} does not match its name {kit.name!r}.", code="kit_invalid"
        )
    return kit


@dataclass(frozen=True)
class _Member:
    index: str
    segment: SegmentFile


def _read_members(
    archive: zipfile.ZipFile, entries: dict[str, zipfile.ZipInfo], hashes: dict[str, str]
) -> list[_Member]:
    """Each segment in the bundle, parsed and checked from its ``segment.json`` alone."""
    files: dict[str, set[str]] = {}
    for name in entries:
        if match := _MEMBER.fullmatch(name):
            files.setdefault(match.group(1), set()).add(match.group(2))
    if len(files) > MAX_KIT_ENTRIES:
        raise _bundle_error(f"The bundle holds more than {MAX_KIT_ENTRIES} segments.")
    members: list[_Member] = []
    seen: set[tuple[str, int]] = set()
    for index in sorted(files):
        if SEGMENT_JSON not in files[index] or len(files[index]) > MEMBER_MAX_FILES:
            raise _bundle_error(
                f"Segment {index} needs {SEGMENT_JSON} and at most {MEMBER_MAX_FILES - 1} audio files."
            )
        name = _member_name(int(index), SEGMENT_JSON)
        raw = _read_entry(archive, entries[name], MAX_SEGMENT_JSON_BYTES)
        _check_small(name, raw, hashes)
        try:
            segment = parse_segment(raw)
        except CodedValueError as exc:
            raise _as_kit_error(exc) from exc
        if segment.id != segment_id_for(segment.name):
            raise _bundle_error(
                f"The segment id {segment.id!r} does not match its name {segment.name!r}."
            )
        if files[index] != set(segment.media) | {SEGMENT_JSON}:
            raise _bundle_error(
                f"The files of segment {index} do not match the audio its segment.json names."
            )
        key = (segment.id, segment.version)
        if key in seen:
            raise _bundle_error(
                f"Segment {index} repeats {segment.id} version {segment.version} in the bundle."
            )
        seen.add(key)
        members.append(_Member(index, segment))
    return members


def _check_kit_against_members(kit: KitFile, members: list[_Member]) -> list[tuple[str, int]]:
    """For each kit entry, the bundled (id, version) it means. Every entry must have one."""
    present = {(m.segment.id, m.segment.version) for m in members}
    resolved: list[tuple[str, int]] = []
    for position, entry in enumerate(kit.entries, start=1):
        if entry.version is not None:
            key = (entry.segment_id, entry.version)
        else:
            versions = [v for i, v in present if i == entry.segment_id]
            key = (entry.segment_id, max(versions)) if versions else (entry.segment_id, 0)
        if key not in present:
            raise _bundle_error(
                f"Entry {position} of the kit names {entry.label()}, which is not in the file."
            )
        resolved.append(key)
    return resolved
