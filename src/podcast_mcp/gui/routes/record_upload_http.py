"""Shared guest/host record keeper ingest (auth wrappers stay in their routes)."""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any, Literal

from fastapi import HTTPException, Query, Request
from starlette.responses import JSONResponse

from podcast_mcp.services.record.landing import RecordLandingError, RecordLandingService
from podcast_mcp.services.record.upload import (
    ROOM_TONE_MAX_PCM_BYTES,
    UPLOAD_KIND_ROOM_TONE,
    RecordUploadError,
    RecordUploadService,
    parse_upload_kind,
)
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.body_limits import (
    BodyTooLarge,
    payload_too_large_response,
    read_body_capped,
    record_upload_max_part_bytes,
)

log = logging.getLogger(__name__)

UploadKindParam = Annotated[
    Literal["keeper", "room_tone"] | None,
    Query(description="keeper or room_tone"),
]


def record_upload_body_limit(kind: str | None) -> int:
    part_max = record_upload_max_part_bytes()
    if parse_upload_kind(kind) == UPLOAD_KIND_ROOM_TONE:
        return min(part_max, ROOM_TONE_MAX_PCM_BYTES)
    return part_max


async def ingest_record_upload_request(
    request: Request,
    uploader: RecordUploadService,
    *,
    session_id: str,
    participant_id: str,
    take_index: int,
    segment_index: int,
    part_seq: int,
    sha256: str,
    file_sha256: str | None,
    final: bool,
    join_offset_ms: int | None = None,
    workspace: ProjectWorkspace | None = None,
    clip_scope: str | None = None,
    kind: str | None = None,
) -> dict[str, Any] | JSONResponse:
    try:
        parsed_kind = parse_upload_kind(kind)
        limit = record_upload_body_limit(parsed_kind)
    except RecordUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        data = await read_body_capped(request, limit)
    except BodyTooLarge as exc:
        return payload_too_large_response(exc.limit)
    try:
        result = await asyncio.to_thread(
            uploader.ingest_part,
            session_id=session_id,
            take_index=take_index,
            participant_id=participant_id,
            segment_index=segment_index,
            part_seq=part_seq,
            data=data,
            digest=sha256,
            file_sha256=file_sha256,
            final=final,
            join_offset_ms=join_offset_ms,
            kind=parsed_kind,
        )
    except RecordUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result.get("newly_acked") and workspace is not None:
        try:
            landed = await asyncio.to_thread(RecordLandingService(workspace).land)
            result["landed"] = True
            clips = list(landed.get("clips") or [])
            if clip_scope is not None:
                clips = [clip for clip in clips if clip.get("participant_id") == clip_scope]
            result["clips"] = clips
        except (RecordLandingError, FileNotFoundError) as exc:
            log.warning("record land after ack skipped: %s", exc)
            result["landed"] = False
        except Exception:
            log.exception("record land after ack failed")
            result["landed"] = False
    return result
