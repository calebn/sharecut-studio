"""``.sharecutkit``: a kit and its segments in one zip, checked entry by entry.

The zip holds ``kit.json``, ``MANIFEST.sha256`` and, for each segment the kit names, that
segment's ``segment.json`` and audio as flat entries prefixed ``segNN__``. The checks are the
``.sharecutseg`` ones (names, sizes, hashes, zip-bomb ratio) with a larger entry cap, and the
errors carry the ``kit_`` codes.
"""

from __future__ import annotations

import hashlib
import re
import zipfile
import zlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Literal

from podcast_mcp.segments.bundle import (
    MANIFEST,
    MAX_MANIFEST_BYTES,
    MAX_TOTAL_BYTES,
    _checked_entries,
    _invalid,
    _manifest_hashes,
    _parse,
    _staging_dir,
    _unpack,
)
from podcast_mcp.segments.kit import (
    KIT_JSON,
    MAX_KIT_ENTRIES,
    KitAddResult,
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
    read_capped,
)
from podcast_mcp.segments.store import AddResult, SegmentStore, sha256_file
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.coded_error import CodedValueError

KIT_MAX_ENTRIES = 512
_MEMBER = re.compile(r"^seg(\d{2})__([A-Za-z0-9][A-Za-z0-9._-]{0,127})$")
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
    """Write the newest version of a kit and the segment versions it uses to ``out_path``."""
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

    try:
        return atomic_write(out_path, fill, creation_mode=0o644)
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
    }.get(exc.code)
    return CodedValueError(str(exc), code=mapped) if mapped else exc


def import_kit_bundle(
    kits: KitStore,
    segments: SegmentStore,
    path: Path,
    *,
    on_conflict: ConflictPolicy = "new-version",
) -> KitImportResult:
    """Check a ``.sharecutkit`` file, add its missing segments, then add the kit.

    Segments land with the library's own dedupe (``unchanged`` / ``new_version``). The kit
    is stored as the next version when its id exists with other entries (``new-version``) or
    left alone (``skip``). Importing the same file again changes nothing. A pinned version
    in the file is rewritten to the version the segment has in this library.
    """
    conflict_policy(on_conflict)
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _bundle_error(f"{path.name} is not a kit bundle.") from exc
    with archive, _staging_dir(_PREFIX) as staging:
        json_names = [
            info.filename
            for info in archive.infolist()
            if (m := _MEMBER.fullmatch(info.filename)) and m.group(2) == SEGMENT_JSON
        ]
        entries = _checked_entries(
            archive,
            max_entries=KIT_MAX_ENTRIES,
            name_ok=_name_ok,
            json_names=[KIT_JSON, *json_names],
            prefix=_PREFIX,
        )
        if KIT_JSON not in entries or MANIFEST not in entries:
            raise _bundle_error(f"The bundle needs {KIT_JSON} and {MANIFEST}.")
        root = Path(staging)
        budget = MAX_TOTAL_BYTES
        try:
            for name, info in entries.items():
                dest = root / name
                if match := _MEMBER.fullmatch(name):
                    dest = root / f"seg{match.group(1)}" / match.group(2)
                    dest.parent.mkdir(exist_ok=True)
                budget -= _unpack(archive, info, dest, budget, _PREFIX)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise _bundle_error(f"{path.name} cannot be unpacked.") from exc
        manifest = read_capped(
            root / MANIFEST, MAX_MANIFEST_BYTES, what=MANIFEST, code="kit_bundle_invalid"
        )
        hashes = _manifest_hashes(manifest.decode("utf-8", errors="replace"), "kit_bundle_invalid")
        if set(hashes) != set(entries) - {MANIFEST}:
            raise _bundle_error(f"The files in the bundle do not match {MANIFEST}.")
        kit = _parse_kit_file(root / KIT_JSON)
        members = _members(root, entries)
        for name, expected in hashes.items():
            source = root / name
            if (match := _MEMBER.fullmatch(name)) is not None:
                source = root / f"seg{match.group(1)}" / match.group(2)
            if sha256_file(source) != expected:
                raise _bundle_error(
                    f"{name} does not match its hash in {MANIFEST}.", "kit_hash_mismatch"
                )
        mapped = _check_kit_against_members(kit, members)
        added: dict[tuple[str, int], AddResult] = {}
        results: list[AddResult] = []
        for segment, folder in members:
            try:
                result = segments.add(folder)
            except CodedValueError as exc:
                raise _as_kit_error(exc) from exc
            added[(segment.id, segment.version)] = result
            results.append(result)
        stored = kit.model_copy(
            update={
                "entries": [
                    entry.model_copy(
                        update={
                            "segment_id": added[mapped[i]].id,
                            "version": added[mapped[i]].version if entry.version else None,
                        }
                    )
                    for i, entry in enumerate(kit.entries)
                ]
            }
        )
        return KitImportResult(kits.add(stored, keep_existing=on_conflict == "skip"), results)


def _parse_kit_file(path: Path) -> KitFile:
    kit = parse_kit(
        read_capped(path, MAX_SEGMENT_JSON_BYTES, what=KIT_JSON, code="kit_bundle_invalid")
    )
    if kit.id != kit_id_for(kit.name):
        raise CodedValueError(
            f"The kit id {kit.id!r} does not match its name {kit.name!r}.", code="kit_invalid"
        )
    return kit


def _members(root: Path, entries: dict[str, zipfile.ZipInfo]) -> list[tuple[SegmentFile, Path]]:
    """Each segment folder in the bundle, parsed, in file order."""
    indexes = sorted({m.group(1) for name in entries if (m := _MEMBER.fullmatch(name))})
    if len(indexes) > MAX_KIT_ENTRIES:
        raise _bundle_error(f"The bundle holds more than {MAX_KIT_ENTRIES} segments.")
    members: list[tuple[SegmentFile, Path]] = []
    for index in indexes:
        folder = root / f"seg{index}"
        try:
            segment = _parse(folder / SEGMENT_JSON)
        except CodedValueError as exc:
            raise _as_kit_error(exc) from exc
        have = {p.name for p in folder.iterdir()}
        if have != set(segment.media) | {SEGMENT_JSON}:
            raise _bundle_error(
                f"The files of segment {index} do not match the audio its segment.json names."
            )
        members.append((segment, folder))
    return members


def _check_kit_against_members(
    kit: KitFile, members: list[tuple[SegmentFile, Path]]
) -> list[tuple[str, int]]:
    """For each kit entry, the bundled (id, version) it means. Every entry must have one."""
    present = {(s.id, s.version) for s, _ in members}
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
