"""Host routes that import a ``.sharecutseg`` file: upload and check, play a clip, add or cancel."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse

from podcast_mcp.gui.routes.bundle_files import stage_upload
from podcast_mcp.gui.routes.deps import NO_STORE
from podcast_mcp.gui.routes.segments import STATUS, refuse
from podcast_mcp.gui.schemas import SegmentImportCommit
from podcast_mcp.segments.bundle import (
    MAX_BUNDLE_BYTES,
    BundlePreview,
    import_bundle,
    preview_segment_bundle,
)
from podcast_mcp.segments.import_staging import ImportStaging
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.body_limits import SEGMENT_IMPORT_PREVIEW_PATH
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()

_REFUSED = {
    **STATUS,
    "segment_bundle_invalid": 422,
    "segment_hash_mismatch": 422,
    "segment_schema_unsupported": 422,
    "segment_invalid": 422,
}


def _wire(token: str, preview: BundlePreview) -> dict[str, object]:
    segment, plan = preview.segment, preview.plan
    return {
        "token": token,
        "name": segment.name,
        "kind": segment.kind,
        "duration_sec": segment.duration_sec,
        "clip_count": len(segment.clips),
        "outcome": plan.status,
        "version": plan.version,
        "existing_id": None if plan.status == "added" else plan.id,
    }


@router.post(SEGMENT_IMPORT_PREVIEW_PATH)
async def preview_import(request: Request) -> dict[str, object]:
    """Check an uploaded file (the raw request body) against the library without adding it."""
    try:
        token, preview = await stage_upload(
            request,
            ImportStaging(SegmentStore()),
            max_bytes=MAX_BUNDLE_BYTES,
            check=lambda path: preview_segment_bundle(SegmentStore(), path),
        )
    except CodedValueError as exc:
        refuse(exc, _REFUSED)
    return _wire(token, preview)


@router.get("/api/segments/import/{staged_id}/audio")
def staged_audio(staged_id: str, clip: int = Query(0, ge=0)) -> FileResponse:
    """One clip of a waiting file, for the preview's play button."""
    try:
        path = ImportStaging(SegmentStore()).clip(staged_id, clip)
    except CodedValueError as exc:
        refuse(exc, _REFUSED)
    return FileResponse(path, media_type="audio/flac", headers=NO_STORE)


@router.post("/api/segments/import")
def commit_import(body: SegmentImportCommit) -> dict[str, str | int]:
    """Add a waiting file to the library. The library re-checks every hash."""
    store = SegmentStore()
    staging = ImportStaging(store)
    staging.sweep()
    try:
        with staging.claim(body.token) as claimed:
            return import_bundle(store, claimed).wire()
    except CodedValueError as exc:
        refuse(exc, _REFUSED)


@router.delete("/api/segments/import/{staged_id}")
def cancel_import(staged_id: str) -> dict[str, str]:
    staging = ImportStaging(SegmentStore())
    staging.sweep()
    try:
        staging.cancel(staged_id)
    except CodedValueError as exc:
        refuse(exc, _REFUSED)
    return {"cancelled": staged_id}
