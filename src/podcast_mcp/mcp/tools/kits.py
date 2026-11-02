"""Host MCP tools for show kits. Guest share MCP never registers them."""

from __future__ import annotations

from typing import Any

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_summary import entry_from_mapping, kit_rows, save_kit, show_kit
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document import submit_kit_apply


def kit_list_tool() -> str:
    """List the show kits: the newest version of each, with how many of its segments are missing.

    A kit whose newest version is damaged is listed as ``{"id", "version", "damaged": true,
    "problem", "code"}``. Read-only; kits are per user, like the segment library.
    """
    return to_json(kit_rows(KitStore(), SegmentStore()))


def kit_show_tool(kit_id: str) -> str:
    """Show one kit: its segments in order, where each goes, and whether each is in the library.

    Errors: ``kit_unknown``, ``kit_unreadable``.
    """
    return to_json(show_kit(KitStore(), SegmentStore(), kit_id))


def kit_save_tool(name: str, entries: list[dict[str, Any]]) -> str:
    """Save a show kit (``podcast kit save``): library segments in order, each with where it goes.

    Each entry is ``{"segment_id", "at", "version"?, "note"?}``; ``at`` is ``start``, ``end``
    or a number of seconds (read when the kit is applied), ``version`` pins a segment version
    (omitted = the newest when the kit is applied; not a whole number from 1 is
    ``segment_version_invalid``, as on the CLI). The same name with other entries becomes
    the next version; the same entries are reported ``unchanged``. Returns
    ``{status, id, version}``. Errors: ``kit_name_invalid``, ``kit_invalid``,
    ``kit_segment_missing`` (names every entry whose segment is not in the library).
    """
    parsed = [entry_from_mapping(raw) for raw in entries]
    return to_json(save_kit(KitStore(), SegmentStore(), name, parsed).wire())


def kit_apply_tool(project_path: str, kit_id: str, dry_run: bool = False) -> str:
    """Put every segment of a kit on an episode, in order (``podcast kit apply``).

    Each entry is an ``InsertSegment`` on the document plane (journaled, shown in Studio, later
    content ripples), so ``end`` means the end after the earlier entries. There is no compound
    command: every entry is its own undo step, ``undo_steps`` in the result says how many.
    Use ``dry_run=true`` first: it runs the whole kit on a copy, reports each entry's effect
    and the new duration, and changes nothing (not even a legacy project rename). An unknown
    kit, a segment or pinned version missing from the library, changed segment audio and any
    refusal the copy run finds are reported before anything is written. A failure of the
    write itself (disk, lock, conflict) can still stop the apply after earlier entries went
    in; the error then names the entry and how many were applied, and each applied entry is
    its own undo step. Errors: ``kit_unknown``, ``kit_segment_missing``,
    ``segment_hash_mismatch``, ``segment_position_out_of_range``, ``segment_media_invalid``,
    ``segment_write_failed``.
    """
    return to_json(
        submit_kit_apply(project_path, kit_id, dry_run=dry_run, client_id="mcp:host").wire()
    )


def register(mcp: MCPServer) -> None:
    for fn in (kit_list_tool, kit_show_tool, kit_save_tool, kit_apply_tool):
        mcp.tool()(fn)
