from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import (
    ProjectWorkspace,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    TranscriptService,
)
from podcast_mcp.util.progress import resolve_progress


def transcribe_track(project_path: str, track_id: str | None = None) -> str:
    """Transcribe a track's audio into word-level timestamps."""
    ws = ProjectWorkspace.open(project_path)
    ids = TranscriptService(ws).transcribe(track_id)
    return to_json(ids)


def get_transcript(
    project_path: str,
    combined: bool = False,
    format: str = "json",
) -> str:
    """Fetch the transcript, combined or per-track, in text or JSON format."""
    ws = ProjectWorkspace.open(project_path)
    return TranscriptService(ws).get(combined=combined, format=format)


def export_transcript(project_path: str) -> str:
    """Export the transcript as Markdown and return the file path."""
    ws = ProjectWorkspace.open(project_path)
    return str(TranscriptService(ws).export_markdown())


def precorrect_transcript_tool(
    project_path: str,
    dry_run: bool = True,
) -> str:
    """Apply automatic transcript precorrections; dry_run previews without changing words."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        TranscriptPrecorrectService(ws).precorrect(
            dry_run=dry_run,
            progress=resolve_progress(),
        )
    )


def transcript_refine_status_tool(project_path: str) -> str:
    """Report the transcript-refine gate status (blocking approve_edits while open)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).status())


def transcript_refine_brief_tool(project_path: str) -> str:
    """Return the transcript-refine brief: what to review before marking done."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).brief())


def transcript_refine_done_tool(
    project_path: str,
    notes: str | None = None,
) -> str:
    """Mark transcript refinement done, with optional notes."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).mark_done(notes=notes, source="mcp"))


def transcript_refine_waive_tool(project_path: str, reason: str) -> str:
    """Waive transcript refinement with a recorded reason."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(TranscriptRefineService(ws).waive(reason=reason, source="mcp"))


def register(mcp: MCPServer) -> None:
    """Register transcript tools on the MCP server."""
    mcp.tool()(transcribe_track)
    mcp.tool()(get_transcript)
    mcp.tool()(export_transcript)
    mcp.tool()(precorrect_transcript_tool)
    mcp.tool()(transcript_refine_status_tool)
    mcp.tool()(transcript_refine_brief_tool)
    mcp.tool()(transcript_refine_done_tool)
    mcp.tool()(transcript_refine_waive_tool)
