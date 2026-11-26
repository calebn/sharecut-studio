"""Host segment library HTTP routes: adapters over the library services."""

from __future__ import annotations

import re
import shutil
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, NoReturn

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from podcast_mcp.gui.routes.deps import NO_STORE, coded_exception_error, resolve_project
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import SegmentSaveRequest
from podcast_mcp.segments.bundle import export_segments
from podcast_mcp.segments.model import segment_kind
from podcast_mcp.segments.position import parse_placement
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.segments.summary import library_rows, show_segment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    parse_range,
    preview_segment_insert,
    report_segment_drift,
    save_segment,
)
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()

STATUS = {
    "segment_unknown": 404,
    "segment_import_unknown": 404,
    "segment_busy": 409,
    "segment_upload_too_large": 413,
    "segment_bundle_too_large": 422,
    "segment_staging_full": 429,
    "segment_import_committing": 409,
    "segment_no_room": 507,
    "segment_write_failed": 500,
}


def refuse(exc: CodedValueError, statuses: Mapping[str, int] = STATUS) -> NoReturn:
    raise coded_exception_error(statuses.get(exc.code, 400), exc, code="segment_invalid") from exc


def _export_stem(segment_id: str) -> str:
    """The id without its trailing hash, limited to file-name-safe characters."""
    stem = re.sub(r"-[0-9a-f]{8}$", "", segment_id)
    return re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "segment"


@router.get("/api/segments")
def list_segments() -> list[dict[str, Any]]:
    return library_rows(SegmentStore())


@router.get("/api/segments/drift")
def segment_drift_route(path: str, request: Request) -> list[dict[str, Any]]:
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    try:
        return report_segment_drift(project_path, SegmentStore())
    except CodedValueError as exc:
        refuse(exc)


@router.get("/api/segments/{segment_id}")
def get_segment(segment_id: str) -> dict[str, Any]:
    try:
        return show_segment(SegmentStore(), segment_id)
    except CodedValueError as exc:
        refuse(exc)


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
        refuse(exc)
    return FileResponse(path, media_type="audio/flac", headers=NO_STORE)


@router.get("/api/segments/{segment_id}/export")
def export_segment(segment_id: str) -> FileResponse:
    """The newest version as one ``<name>.sharecutseg`` file, built in a private folder removed afterwards."""
    folder = Path(tempfile.mkdtemp(prefix="sharecut-export-"))
    try:
        path = export_segments(
            SegmentStore(), [segment_id], folder / f"{_export_stem(segment_id)}.sharecutseg"
        )
    except CodedValueError as exc:
        shutil.rmtree(folder, ignore_errors=True)
        refuse(exc)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=path.name,
        headers=NO_STORE,
        background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True),
    )


@router.get("/api/segments/{segment_id}/insert-preview")
def insert_preview(
    segment_id: str,
    request: Request,
    path: str,
    at: str,
    version: int | None = None,
    placement: str = "ripple",
) -> dict[str, Any]:
    """What inserting the segment at ``at`` would move: a dry run that writes nothing.

    ``placement`` is ``ripple`` (default) or ``own_lane``; anything else is
    ``segment_placement_invalid``.

    ``version`` is a bare ``int`` and not ``Query(ge=1)`` so that 0 reaches
    ``segment_version_invalid`` like the CLI and MCP instead of a 422.
    """
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    store = SegmentStore()
    try:
        report = preview_segment_insert(
            ProjectWorkspace.open(project_path, adopt=False),
            segment_id,
            at,
            version=store.resolve_version(segment_id, version),
            store=store,
            placement=parse_placement(placement),
        )
    except CodedValueError as exc:
        refuse(exc)
    return report.model_dump()


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
        refuse(exc)
    return result.wire()


@router.delete("/api/segments/{segment_id}")
def remove_segment(segment_id: str) -> dict[str, str]:
    try:
        SegmentStore().remove(segment_id)
    except CodedValueError as exc:
        refuse(exc)
    return {"removed": segment_id}
