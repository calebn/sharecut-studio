"""Kits as plain data, and the check that a kit's segments are in the library."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from podcast_mcp.segments.kit import (
    MAX_KIT_ENTRIES,
    KitAddResult,
    KitEntry,
    KitFile,
    KitStore,
    kit_id_for,
    kit_wire,
)
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.coded_error import CodedValueError


@dataclass(frozen=True)
class ResolvedEntry:
    """A kit entry with the segment version it will use."""

    entry: KitEntry
    version: int


@dataclass(frozen=True)
class MissingEntry:
    position: int  # 1-based, as people count entries
    entry: KitEntry
    problem: str


def find_missing(kit: KitFile, store: SegmentStore) -> list[MissingEntry]:
    """Entries whose segment id or pinned version is not in the library. Reads no audio."""
    missing: list[MissingEntry] = []
    for position, entry in enumerate(kit.entries, start=1):
        try:
            store.resolve_version(entry.segment_id, entry.version)
        except CodedValueError as exc:
            missing.append(MissingEntry(position, entry, str(exc)))
    return missing


def missing_text(missing: list[MissingEntry]) -> str:
    parts = "; ".join(f"entry {m.position} ({m.entry.label()}): {m.problem}" for m in missing)
    return (
        f"{len(missing)} segment{'s' if len(missing) != 1 else ''} of this kit "
        f"{'are' if len(missing) != 1 else 'is'} not in the library: {parts} "
        "Import the missing segments, or save the kit again with segments you have."
    )


def resolve_kit(kit: KitFile, store: SegmentStore) -> list[ResolvedEntry]:
    """Pin each entry to a version, and check every segment's audio, before anything is written.

    Raises ``kit_segment_missing`` naming every entry whose segment or version is absent, then
    ``segment_hash_mismatch`` for the first segment whose audio changed.
    """
    missing = find_missing(kit, store)
    if missing:
        raise CodedValueError(missing_text(missing), code="kit_segment_missing")
    resolved = [
        ResolvedEntry(e, store.resolve_version(e.segment_id, e.version)) for e in kit.entries
    ]
    for item in resolved:
        store.get(item.entry.segment_id, item.version)
    return resolved


def entry_row(position: int, entry: KitEntry, store: SegmentStore) -> dict[str, Any]:
    row: dict[str, Any] = {"position": position, **entry.model_dump(mode="json")}
    try:
        row["resolved_version"] = store.resolve_version(entry.segment_id, entry.version)
        row["present"] = True
    except CodedValueError as exc:
        row["present"] = False
        row["problem"] = str(exc)
    return row


def show_kit(kits: KitStore, segments: SegmentStore, kit_id: str) -> dict[str, Any]:
    """One kit's newest version with its versions and, per entry, whether its segment is here."""
    kit = kits.get(kit_id)
    detail = kit_wire(kit, kits.versions(kit_id))
    detail["entries"] = [entry_row(i, e, segments) for i, e in enumerate(kit.entries, start=1)]
    return detail


def kit_rows(kits: KitStore, segments: SegmentStore) -> list[dict[str, Any]]:
    """The newest version of each kit, then a ``damaged`` row for each unreadable one."""
    listing = kits.scan()
    rows = [
        {
            "id": k.id,
            "name": k.name,
            "version": k.version,
            "versions": list(kits.versions(k.id)),
            "entries": len(k.entries),
            "missing": len(find_missing(k, segments)),
        }
        for k in listing.kits
    ]
    rows += [
        {"id": d.id, "damaged": True, "version": d.version, "problem": d.problem, "code": d.code}
        for d in listing.damaged
    ]
    return rows


def save_kit(
    kits: KitStore, segments: SegmentStore, name: str, entries: list[KitEntry]
) -> KitAddResult:
    """Save a kit called ``name``. Every segment (and pinned version) must be in the library.

    The one path for ``podcast kit save`` and ``kit_save_tool``. The same name with other
    entries is the next version; the same entries are ``unchanged``. Errors:
    ``kit_name_invalid``, ``kit_invalid`` (no entries, or too many), ``kit_segment_missing``.
    """
    kit_id = kit_id_for(name)
    try:
        kit = KitFile(id=kit_id, name=name.strip(), entries=entries)
    except ValidationError as exc:
        raise CodedValueError(
            f"A kit needs 1 to {MAX_KIT_ENTRIES} segments: {exc.errors()[0]['msg']}.",
            code="kit_invalid",
        ) from exc
    missing = find_missing(kit, segments)
    if missing:
        raise CodedValueError(missing_text(missing), code="kit_segment_missing")
    return kits.add(kit)
