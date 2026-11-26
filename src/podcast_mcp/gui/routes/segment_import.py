"""Host routes that import a ``.sharecutseg`` file: upload and check, play a clip, add or cancel."""

from __future__ import annotations

import anyio
from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from podcast_mcp.gui.routes.deps import NO_STORE
from podcast_mcp.gui.routes.segments import STATUS, refuse
from podcast_mcp.gui.schemas import SegmentImportCommit
from podcast_mcp.segments.bundle import (
    MAX_BUNDLE_BYTES,
    BundlePreview,
    import_bundle,
    preview_segment_bundle,
)
from podcast_mcp.segments.import_staging import ImportStaging, Upload
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
_WRITE_BLOCK = 1 << 20


def _too_large() -> CodedValueError:
    return CodedValueError(
        f"This file is larger than the {MAX_BUNDLE_BYTES // 1024**2} MiB a segment file can be.",
        code="segment_upload_too_large",
    )


def _declared_length(request: Request) -> int | None:
    raw = request.headers.get("content-length")
    return int(raw) if raw is not None and raw.isdigit() else None


async def _receive(request: Request, staging: ImportStaging, upload: Upload) -> None:
    """Stream the request body into the partial file, never holding more than a block."""
    received = 0
    block = bytearray()
    with staging.open_partial(upload) as target:
        async for chunk in request.stream():
            received += len(chunk)
            if received > MAX_BUNDLE_BYTES:
                raise _too_large()
            block += chunk
            if len(block) >= _WRITE_BLOCK:
                await run_in_threadpool(staging.ensure_room, received)
                await anyio.to_thread.run_sync(target.write, bytes(block))
                block.clear()
        await run_in_threadpool(staging.ensure_room, received)
        await anyio.to_thread.run_sync(target.write, bytes(block))


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
    staging = ImportStaging(SegmentStore())
    declared = _declared_length(request)
    upload: Upload | None = None
    finished = False
    try:
        if declared is not None and declared > MAX_BUNDLE_BYTES:
            raise _too_large()
        upload = await run_in_threadpool(staging.begin, declared)
        await _receive(request, staging, upload)
        preview = await run_in_threadpool(preview_segment_bundle, SegmentStore(), upload.partial)
        if await request.is_disconnected():
            raise CodedValueError("The upload was cancelled.", code="segment_upload_cancelled")
        staging.finish(upload)
        finished = True
        return _wire(upload.token, preview)
    except CodedValueError as exc:
        refuse(exc, _REFUSED)
    except OSError as exc:
        refuse(
            CodedValueError(
                f"The file could not be stored: {exc.strerror or exc}.", code="segment_write_failed"
            ),
            _REFUSED,
        )
    finally:
        if upload is not None and not finished:
            staging.drop_partial(upload)


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
    if staging.committing(staged_id):
        refuse(
            CodedValueError(
                "This file is being added to the library right now.",
                code="segment_import_committing",
            ),
            _REFUSED,
        )
    staging.discard(staged_id)
    return {"cancelled": staged_id}
