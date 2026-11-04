"""The library as plain data: what ``podcast segment list/show`` and the MCP tools return."""

from __future__ import annotations

from typing import Any

from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.segments.store import DamagedSegment, SegmentStore


def damaged_fix(store: SegmentStore, damaged: DamagedSegment) -> str:
    """What to do about a damaged newest version; the one text `segment list` and doctor print.

    Importing the segment again stores a new version and keeps the older ones, so it is
    always first. `segment remove` deletes every version, so it is offered only when no
    older version exists to be lost.
    """
    importing = "Import the segment again (this keeps older versions)"
    if len(store.versions(damaged.id)) > 1:
        return f"{importing}."
    return (
        f"{importing}, or remove it with `podcast segment remove {damaged.id}` "
        "(it has no older version)."
    )


def segment_detail(segment: SegmentFile, versions: list[int]) -> dict[str, Any]:
    return {**segment.model_dump(mode="json"), "versions": versions}


def show_segment(store: SegmentStore, segment_id: str) -> dict[str, Any]:
    """One segment's newest version with its version numbers. Raises ``segment_unknown``."""
    segment = store.get(segment_id)
    return segment_detail(segment, list(store.versions(segment_id)))


def library_rows(store: SegmentStore, *, deep: bool = True) -> list[dict[str, Any]]:
    """The newest version of each segment, then a ``damaged`` row for each unreadable one."""
    listing = store.scan(deep=deep)
    rows = [segment_detail(s, list(store.versions(s.id))) for s in listing.segments]
    rows += [
        {"id": d.id, "damaged": True, "version": d.version, "problem": d.problem, "code": d.code}
        for d in listing.damaged
    ]
    return rows
