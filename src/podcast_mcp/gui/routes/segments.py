"""Host segment library HTTP routes: adapters over the library services."""

from __future__ import annotations

from typing import Any, NoReturn

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse

from podcast_mcp.gui.routes.deps import NO_STORE, coded_exception_error, resolve_project
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import SegmentSaveRequest
from podcast_mcp.segments.model import segment_kind
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.segments.summary import library_rows, show_segment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import parse_range, save_segment
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()

_STATUS = {"segment_unknown": 404, "segment_busy": 409, "segment_write_failed": 500}


def _refuse(exc: CodedValueError) -> NoReturn:
    raise coded_exception_error(_STATUS.get(exc.code, 400), exc, code="segment_invalid") from exc


@router.get("/api/segments")
def list_segments() -> list[dict[str, Any]]:
    return library_rows(SegmentStore())


@router.get("/api/segments/{segment_id}")
def get_segment(segment_id: str) -> dict[str, Any]:
    try:
        return show_segment(SegmentStore(), segment_id)
    except CodedValueError as exc:
        _refuse(exc)


@router.get("/api/segments/{segment_id}/audio")
def get_segment_audio(
    segment_id: str,
    clip: int = Query(0, ge=0, description="Index of the clip in the segment"),
    version: int | None = Query(None, ge=1),
) -> FileResponse:
    """One clip's own audio file (already trimmed), named by the verified segment, never the request."""
    store = SegmentStore()
    try:
        segment = store.get(segment_id, version)
        if clip >= len(segment.clips):
            raise CodedValueError(
                f"The segment {segment_id} has no clip {clip}.", code="segment_unknown"
            )
        path = store.path(segment_id, segment.version) / segment.clips[clip].audio
    except CodedValueError as exc:
        _refuse(exc)
    return FileResponse(path, media_type="audio/flac", headers=NO_STORE)


@router.post("/api/segments")
def save_segment_route(body: SegmentSaveRequest, request: Request) -> dict[str, str | int]:
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
        _refuse(exc)
    return result.wire()


@router.delete("/api/segments/{segment_id}")
def remove_segment(segment_id: str) -> dict[str, str]:
    try:
        SegmentStore().remove(segment_id)
    except CodedValueError as exc:
        _refuse(exc)
    return {"removed": segment_id}
