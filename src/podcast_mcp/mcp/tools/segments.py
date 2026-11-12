"""Host MCP tools for the segment library. Guest share MCP never registers them."""

from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.models.episode import TrackRole
from podcast_mcp.segments.model import segment_kind
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.segments.summary import library_rows, show_segment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    parse_range,
    save_segment,
)
from podcast_mcp.services.document_sync import submit_segment_insert


def segment_list_tool() -> str:
    """List the segment library: the newest version of each saved intro, outro, sponsor read or sting.

    A segment whose newest version is damaged is listed as ``{"id", "version", "damaged": true,
    "problem", "code"}`` rather than hidden. Read-only; the library is per user, not per episode.
    """
    return to_json(library_rows(SegmentStore()))


def segment_show_tool(segment_id: str) -> str:
    """Show one library segment: layout, level, chapter title, clips and its version numbers.

    Errors: ``segment_unknown`` (no such id), ``segment_hash_mismatch`` (its audio changed).
    """
    return to_json(show_segment(SegmentStore(), segment_id))


def segment_save_tool(
    project_path: str,
    name: str,
    clip_ids: list[str] | None = None,
    time_range: str | None = None,
    kind: str | None = None,
    role: TrackRole | None = None,
) -> str:
    """Save clips of an episode into the library as a copy (``podcast segment save``).

    Pass ``clip_ids`` or ``time_range`` (such as ``0:00-0:22``), not both. ``kind`` is
    intro, outro, sponsor, sting or other; it is guessed from the position when omitted. The
    episode is not changed (a project still under its retired entry-file name is not renamed). The same name with new audio becomes the next version of that
    segment; identical audio is reported ``unchanged``. Returns ``{status, id, version}``.
    """
    result = save_segment(
        ProjectWorkspace.open(project_path, adopt=False),
        SegmentStore(),
        name=name,
        kind=segment_kind(kind) if kind else None,
        clip_ids=clip_ids,
        time_range=parse_range(time_range) if time_range else None,
        role=role,
    )
    return to_json(result.wire())


def segment_insert_tool(
    project_path: str,
    segment_id: str,
    at: float | str,
    version: int | None = None,
    dry_run: bool = False,
) -> str:
    """Insert a library segment into an episode at ``start``, ``end`` or a timeline second.

    ``at`` is the text ``start`` or ``end`` (any case) or a number of seconds; ``end`` is read
    when the edit runs, under the document lock.

    Later clips, chapters, review comments and pending edits move by the segment's length
    (``podcast segment insert``). The edit goes through the document plane as ``InsertSegment``:
    it is journaled, shows in Studio at once and is one undo step (``history_undo``). It is
    applied, not held as a pending proposal, because a pending proposal only exists for
    remove, mute and split edits. Use ``dry_run=true`` first: it reports the new duration and
    what would move, and changes nothing (it also probes the segment's audio, so it refuses
    what the insert would). ``version`` picks an older version; the one used is journaled.
    The result carries ``dry_run`` (true or false). Errors: ``segment_version_invalid``, ``segment_unknown``, ``segment_hash_mismatch``, ``segment_position_out_of_range``,
    ``segment_media_invalid``, ``segment_write_failed``.
    """
    return to_json(
        submit_segment_insert(
            project_path,
            segment_id,
            at,
            version=version,
            dry_run=dry_run,
            client_id="mcp:host",
        ).model_dump()
    )


def register(mcp: MCPServer) -> None:
    for fn in (segment_list_tool, segment_show_tool, segment_save_tool, segment_insert_tool):
        mcp.tool()(fn)
