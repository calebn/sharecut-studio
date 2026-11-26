"""Host routes that import a ``.sharecutkit`` file: upload and check, add or cancel."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from podcast_mcp.gui.routes.bundle_files import stage_upload
from podcast_mcp.gui.routes.deps import ERROR_CODE_HEADER, host_gate
from podcast_mcp.gui.routes.kits import KIT_STATUS, refuse_kit
from podcast_mcp.gui.schemas import KitImportCommit
from podcast_mcp.segments.bundle import MAX_BUNDLE_BYTES
from podcast_mcp.segments.import_staging import KIT_KIND, ImportStaging
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_bundle import (
    KitImportIncomplete,
    KitPreview,
    import_kit_bundle,
    preview_kit_bundle,
)
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.body_limits import KIT_IMPORT_PREVIEW_PATH
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()
_HOST_GATE = [Depends(host_gate)]


def _staging() -> ImportStaging:
    return ImportStaging(KitStore(), KIT_KIND)


def _wire(token: str, preview: KitPreview) -> dict[str, object]:
    counts = {"added": 0, "new_version": 0, "unchanged": 0}
    for item in preview.segments:
        counts[item.plan.status] += 1
    return {
        "token": token,
        "name": preview.kit.name,
        "kit_id": preview.kit.id,
        "outcome": preview.plan.status,
        "version": preview.plan.version,
        "entry_count": len(preview.entries),
        "counts": counts,
        "entries": [
            {
                "position": item.position,
                "name": item.planned.segment.name,
                "kind": item.planned.segment.kind,
                "duration_sec": item.planned.segment.duration_sec,
                "at": item.entry.at,
                "note": item.entry.note,
                "outcome": item.planned.plan.status,
                "version": item.planned.plan.version,
            }
            for item in preview.entries
        ],
    }


@router.post(KIT_IMPORT_PREVIEW_PATH, dependencies=_HOST_GATE)
async def preview_import(request: Request) -> dict[str, object]:
    """Check an uploaded kit file (the raw request body) against the libraries without adding it."""
    try:
        token, preview = await stage_upload(
            request,
            _staging(),
            max_bytes=MAX_BUNDLE_BYTES,
            check=lambda path: preview_kit_bundle(KitStore(), SegmentStore(), path),
        )
    except CodedValueError as exc:
        refuse_kit(exc)
    return _wire(token, preview)


@router.post("/api/kits/import", dependencies=_HOST_GATE, response_model=None)
def commit_import(body: KitImportCommit) -> dict[str, object] | JSONResponse:
    """Add a waiting kit file to the libraries. Every hash is checked again.

    A segment or kit write that fails after earlier segments landed answers the refusal with
    ``segments_added`` and keeps the file, so choosing Add again finishes the job.
    """
    staging = _staging()
    staging.sweep()
    try:
        with staging.claim(body.token) as claimed:
            return import_kit_bundle(KitStore(), SegmentStore(), claimed).wire()
    except KitImportIncomplete as exc:
        return JSONResponse(
            {
                "detail": str(exc),
                "segments_added": [result.wire() for result in exc.added],
                "segments_total": exc.total,
            },
            status_code=KIT_STATUS.get(exc.code, 400),
            headers={ERROR_CODE_HEADER: exc.code},
        )
    except CodedValueError as exc:
        refuse_kit(exc)


@router.delete("/api/kits/import/{staged_id}", dependencies=_HOST_GATE)
def cancel_import(staged_id: str) -> dict[str, str]:
    staging = _staging()
    staging.sweep()
    try:
        staging.cancel(staged_id)
    except CodedValueError as exc:
        refuse_kit(exc)
    return {"cancelled": staged_id}
