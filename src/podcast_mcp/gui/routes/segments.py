"""Host-only HTTP adapters over the segment library (#1777). Never on the guest allowlist.

The library is per user and lives on the host's machine, so a share guest never reaches it. Each
route calls the service the CLI and the host MCP tools call, so the codes are the same.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from podcast_mcp.gui.routes.deps import (
    NO_STORE,
    coded_exception_error,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import SegmentSaveRequest
from podcast_mcp.segments.model import segment_kind
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.segments.summary import library_rows, show_segment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import parse_range, save_segment
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()

_STATUS = {"segment_unknown": 404, "segment_busy": 409}
_AUDIO_TYPE = "audio/flac"


def _refused(exc: CodedValueError) -> HTTPException:
    return coded_exception_error(_STATUS.get(exc.code, 400), exc, code="segment_invalid")


@router.get("/api/segments")
def list_segments() -> list[dict[str, Any]]:
    """The newest version of each segment, then a ``damaged`` row for each unreadable one."""
    try:
        return library_rows(SegmentStore())
    except CodedValueError as exc:
        raise _refused(exc) from exc


@router.get("/api/segments/{segment_id}")
def get_segment(segment_id: str) -> dict[str, Any]:
    try:
        return show_segment(SegmentStore(), segment_id)
    except CodedValueError as exc:
        raise _refused(exc) from exc


@router.get("/api/segments/{segment_id}/audio")
def segment_audio(
    segment_id: str,
    clip: int = Query(0, ge=0, description="Which clip of the segment to play"),
    version: int | None = Query(None, ge=1),
) -> FileResponse:
    """One clip's audio for a preview. The segment is read with its hashes checked first."""
    store = SegmentStore()
    try:
        segment = store.get(segment_id, version)
        if clip >= len(segment.clips):
            raise CodedValueError(
                f"The segment {segment_id} has no clip {clip}.", code="segment_unknown"
            )
        folder = store.path(segment_id, segment.version)
    except CodedValueError as exc:
        raise _refused(exc) from exc
    return FileResponse(
        folder / segment.clips[clip].audio, media_type=_AUDIO_TYPE, headers=NO_STORE
    )


@router.post("/api/segments")
def save_segment_route(body: SegmentSaveRequest, request: Request) -> dict[str, Any]:
    """Copy clips or a range of an episode into the library. The episode is not changed."""
    project_path = resolve_project(body.path, request)
    pin_served_if_allowed(request, project_path)
    try:
        result = save_segment(
            ProjectWorkspace.open(project_path, adopt=False),
            SegmentStore(),
            name=body.name,
            kind=segment_kind(body.kind) if body.kind else None,
            clip_ids=body.clip_ids,
            time_range=parse_range(body.time_range) if body.time_range else None,
            role=body.role,
        )
    except CodedValueError as exc:
        raise _refused(exc) from exc
    return result.wire()


@router.delete("/api/segments/{segment_id}")
def remove_segment(segment_id: str) -> dict[str, str]:
    """Delete every version of a segment, damaged or not. Its episodes keep their copies."""
    try:
        SegmentStore().remove(segment_id)
    except CodedValueError as exc:
        raise _refused(exc) from exc
    return {"removed": segment_id}
