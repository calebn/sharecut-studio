"""Submit typed document commands from host MCP and CLI (shared journal with the GUI)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from podcast_mcp.models import EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.commands import (
    ClientRole,
    DocumentCommand,
    DocumentCommandType,
)
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError


def submit_host_document_command(
    project_path: str | Path,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
    command_id: str | None = None,
    role: ClientRole = "agent",
) -> dict[str, Any]:
    """Apply via DocumentSyncService so the GUI sees the same command log."""
    validated = validate_payload(command_type, payload)
    ws = ProjectWorkspace.open(project_path)
    svc = DocumentSyncService(ws)
    cmd = DocumentCommand(
        type=command_type,
        payload=validated,
        client_id=client_id,
        role=role,
        client_seq=None,  # server-assigned: separate CLI/MCP processes never collide
    )
    if command_id is not None:
        if not command_id:
            raise CodedValueError("command_id must be nonempty", code="command_id_empty")
        cmd.command_id = command_id
    return svc.submit(cmd)


def host_command_result(reply: dict[str, Any]) -> dict[str, Any]:
    """The handler result inside a submit reply (``command.payload.result``)."""
    return ((reply.get("command") or {}).get("payload") or {}).get("result") or {}


def submit_host_command_result(
    project_path: str | Path,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Submit one host command and return the handler's own result."""
    return host_command_result(
        submit_host_document_command(project_path, command_type, payload, client_id=client_id)
    )


def submit_paste_segment(
    project_path: str | Path,
    insert_at: float,
    clipboard: Mapping[str, Any],
    *,
    mode: EditMode,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Paste a ``copy_segment`` clipboard at ``insert_at`` in ``mode``, as Studio Paste does.

    The only place host agents build ``PasteSegment``, so a payload change lands here once.
    """
    payload = {
        "insert_at": insert_at,
        "duration": clipboard.get("duration"),
        "extracts": clipboard.get("extracts"),
        "mode": mode.value,
    }
    return submit_host_command_result(project_path, "PasteSegment", payload, client_id=client_id)


def submit_segment_insert(
    project_path: str | Path,
    segment_id: str,
    at: object,
    *,
    version: int | None = None,
    dry_run: bool = False,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Insert a library segment (or report what an insert would move), for the CLI and MCP.

    ``at`` is ``start``, ``end`` or seconds, parsed by one function for every caller; ``end``
    is read under the document lock when the insert runs, and in the same way for a dry run.
    The version is pinned here, so the journaled command names the audio that went in even if
    a newer version is saved later. A dry run reads the project in place and writes nothing,
    not even a legacy file rename. Errors: see ``insert_saved_segment``, plus
    ``segment_version_invalid``.
    """
    from podcast_mcp.segments.position import parse_position
    from podcast_mcp.segments.store import SegmentStore
    from podcast_mcp.services.document import preview_segment_insert

    store = SegmentStore()
    position = parse_position(at)
    pinned = store.resolve_version(segment_id, version)
    if dry_run:
        return preview_segment_insert(
            ProjectWorkspace.open(project_path, adopt=False),
            segment_id,
            position,
            version=pinned,
            store=store,
        )
    result = submit_host_command_result(
        project_path,
        "InsertSegment",
        {"segment_id": segment_id, "at": position, "version": pinned},
        client_id=client_id,
    )
    return {**result, "dry_run": False}


def submit_kit_apply(
    project_path: str | Path,
    kit_id: str,
    *,
    dry_run: bool = False,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Apply a show kit to an episode, one ``InsertSegment`` per entry, in the kit's order.

    Everything that can be refused is refused before the first write: an unknown kit, a
    segment or pinned version missing from the library (every such entry is named), a segment
    whose audio changed, and any entry's own refusal (position, media), found by running the
    whole kit on a copy of the project first. ``start`` and ``end`` are read when each entry
    runs, so ``end`` is the end after the earlier entries have rippled. Each entry is its own
    undo step (there is no compound document command), so undoing a whole kit takes one
    ``history_undo`` per entry. A dry run is that copy run and nothing else: it writes
    nothing, not even a legacy file rename. Errors: ``kit_unknown``, ``kit_segment_missing``,
    plus those of :func:`submit_segment_insert`.
    """
    from podcast_mcp.segments.kit import KitStore
    from podcast_mcp.segments.kit_summary import resolve_kit
    from podcast_mcp.segments.store import SegmentStore
    from podcast_mcp.services.document import preview_segment_insert_on

    kits = KitStore()
    segments = SegmentStore()
    kit = kits.get(kit_id)
    resolved = resolve_kit(kit, segments)
    ws = ProjectWorkspace.open(project_path, adopt=False)
    trial = ws.project.model_copy(deep=True)
    before = _timeline_end(trial)
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
        except CodedValueError as exc:
            raise _entry_error(exc, position, len(resolved), item.entry.label(), 0) from exc
        previews.append({"position": position, "note": item.entry.note, **report})
    summary: dict[str, Any] = {
        "kit_id": kit.id,
        "kit_version": kit.version,
        "timeline_duration_before_sec": before,
        "timeline_duration_after_sec": _timeline_end(trial),
    }
    if dry_run:
        return {**summary, "dry_run": True, "entries": previews}
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
        except CodedValueError as exc:
            raise _entry_error(
                exc, position, len(resolved), item.entry.label(), len(applied)
            ) from exc
        applied.append({"position": position, "note": item.entry.note, **result})
    final = ProjectWorkspace.open(project_path, adopt=False)
    return {
        **summary,
        "timeline_duration_after_sec": _timeline_end(final.project),
        "dry_run": False,
        "entries": applied,
        "undo_steps": len(applied),
    }


def _timeline_end(project: Any) -> float:
    from podcast_mcp.edits.segment_insert import timeline_end

    return float(timeline_end(project))


def _entry_error(
    exc: CodedValueError, position: int, total: int, label: str, applied: int
) -> CodedValueError:
    """The same code, with the entry named and how many entries already went in."""
    tail = (
        f" {applied} earlier entr{'y was' if applied == 1 else 'ies were'} already applied;"
        " each is its own undo step in History."
        if applied
        else " Nothing was changed."
    )
    return CodedValueError(
        f"Kit entry {position} of {total} ({label}) was refused: {exc}{tail}", code=exc.code
    )
