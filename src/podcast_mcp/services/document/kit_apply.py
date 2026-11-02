"""Apply a show kit to an episode: one ``InsertSegment`` per entry, in the kit's order."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from podcast_mcp.edits.segment_insert import timeline_end
from podcast_mcp.models import EpisodeProject
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_summary import resolve_kit
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.segment_insert import preview_segment_insert_on
from podcast_mcp.services.document_sync import submit_segment_insert
from podcast_mcp.util.coded_error import CodedError, CodedValueError


def _end(project: EpisodeProject) -> float:
    return float(timeline_end(project))


class KitApplyReport(BaseModel):
    """What applying a kit did (``dry_run`` false) or would do (true); ``wire()`` is the JSON."""

    kit_id: str
    kit_version: int
    timeline_duration_before_sec: float
    timeline_duration_after_sec: float
    dry_run: bool
    entries: list[dict[str, Any]]
    undo_steps: int | None = None

    def wire(self) -> Mapping[str, Any]:
        data = self.model_dump()
        if self.undo_steps is None:
            data.pop("undo_steps")
        return data


def submit_kit_apply(
    project_path: str | Path,
    kit_id: str,
    *,
    dry_run: bool = False,
    client_id: str = "mcp-agent",
) -> KitApplyReport:
    """Apply a show kit to an episode, one ``InsertSegment`` per entry, in the kit's order.

    Refused before the first write: an unknown kit, a segment or pinned version missing from
    the library (every such entry is named), a segment whose audio changed, and any refusal
    the whole kit meets when it is run on a copy of the project first (position, media).
    Not covered by that copy: a failure of the write itself (disk, lock, document conflict).
    If one happens on entry N after earlier entries went in, the apply stops with the same
    code and a message naming entry N and how many were applied (each is its own undo step);
    retrying the whole kit would insert those again. ``start`` and ``end`` are read when each entry
    runs, so ``end`` is the end after the earlier entries have rippled. Each entry is its own
    undo step (there is no compound document command), so undoing a whole kit takes one
    ``history_undo`` per entry. A dry run is that copy run and nothing else: it writes
    nothing, not even a legacy file rename. Errors: ``kit_unknown``, ``kit_segment_missing``,
    plus those of :func:`submit_segment_insert`.
    """
    kits = KitStore()
    segments = SegmentStore()
    kit = kits.get(kit_id)
    resolved = resolve_kit(kit, segments)
    ws = ProjectWorkspace.open(project_path, adopt=False)
    trial = ws.project.model_copy(deep=True)
    before = _end(trial)
    previews: list[dict[str, Any]] = []
    for position, item in enumerate(resolved, start=1):
        try:
            report, trial = preview_segment_insert_on(
                ws,
                trial,
                item.entry.segment_id,
                item.entry.at,
                version=item.version,
                store=segments,
            )
        except CodedError as exc:
            raise _entry_error(exc, position, len(resolved), item.entry.label(), 0) from exc
        previews.append({"position": position, "note": item.entry.note, **report.wire()})
    if dry_run:
        return KitApplyReport(
            kit_id=kit.id,
            kit_version=kit.version,
            timeline_duration_before_sec=before,
            timeline_duration_after_sec=_end(trial),
            dry_run=True,
            entries=previews,
        )
    applied: list[dict[str, Any]] = []
    for position, item in enumerate(resolved, start=1):
        try:
            result = submit_segment_insert(
                project_path,
                item.entry.segment_id,
                item.entry.at,
                version=item.version,
                client_id=client_id,
            )
        except CodedError as exc:
            raise _entry_error(
                exc, position, len(resolved), item.entry.label(), len(applied)
            ) from exc
        applied.append({"position": position, "note": item.entry.note, **result.wire()})
    final = ProjectWorkspace.open(project_path, adopt=False)
    return KitApplyReport(
        kit_id=kit.id,
        kit_version=kit.version,
        timeline_duration_before_sec=before,
        timeline_duration_after_sec=_end(final.project),
        dry_run=False,
        entries=applied,
        undo_steps=len(applied),
    )


def _entry_error(
    exc: CodedError, position: int, total: int, label: str, applied: int
) -> CodedValueError:
    """The same code, with the entry named and how many entries already went in."""
    tail = (
        f" {applied} earlier entr{'y was' if applied == 1 else 'ies were'} already applied;"
        " each is its own undo step in History."
        if applied
        else " Nothing was changed."
    )
    return CodedValueError(
        f"Kit entry {position} of {total} ({label}) failed: {exc}{tail}", code=exc.code
    )
