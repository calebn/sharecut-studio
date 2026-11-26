"""What the segment and kit file routes share: the streamed upload and the file download."""

from __future__ import annotations

import re
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import anyio
from fastapi import Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from podcast_mcp.gui.routes.deps import NO_STORE
from podcast_mcp.segments.import_staging import ImportStaging, Upload
from podcast_mcp.util.coded_error import CodedValueError

_WRITE_BLOCK = 1 << 20

T = TypeVar("T")


def too_large(staging: ImportStaging, max_bytes: int) -> CodedValueError:
    return CodedValueError(
        f"This file is larger than the {max_bytes // 1024**2} MiB a {staging.kind.name} "
        "file can be.",
        code=staging.kind.code("upload_too_large"),
    )


def declared_length(request: Request) -> int | None:
    raw = request.headers.get("content-length")
    return int(raw) if raw is not None and raw.isascii() and raw.isdigit() else None


async def receive(
    request: Request, staging: ImportStaging, upload: Upload, *, max_bytes: int
) -> None:
    """Stream the request body into the partial file, never holding more than a block."""
    received = 0
    block = bytearray()
    with staging.open_partial(upload) as target:
        async for chunk in request.stream():
            received += len(chunk)
            if received > max_bytes:
                raise too_large(staging, max_bytes)
            block += chunk
            if len(block) >= _WRITE_BLOCK:
                await run_in_threadpool(staging.ensure_room, received)
                await anyio.to_thread.run_sync(target.write, bytes(block))
                block.clear()
        await run_in_threadpool(staging.ensure_room, received)
        await anyio.to_thread.run_sync(target.write, bytes(block))


async def stage_upload(
    request: Request,
    staging: ImportStaging,
    *,
    max_bytes: int,
    check: Callable[[Path], T],
) -> tuple[str, T]:
    """Stream the body into staging, run ``check`` on it and keep it; return its token and what ``check`` found.

    A refusal or a failed write leaves nothing staged. Raises ``CodedValueError`` only.
    """
    declared = declared_length(request)
    upload: Upload | None = None
    finished = False
    try:
        if declared is not None and declared > max_bytes:
            raise too_large(staging, max_bytes)
        upload = await run_in_threadpool(staging.begin, declared)
        await receive(request, staging, upload, max_bytes=max_bytes)
        found = await run_in_threadpool(check, upload.partial)
        if await request.is_disconnected():
            raise CodedValueError(
                "The upload was cancelled.", code=staging.kind.code("upload_cancelled")
            )
        staging.finish(upload)
        finished = True
        return upload.token, found
    except OSError as exc:
        raise CodedValueError(
            f"The file could not be stored: {exc.strerror or exc}.",
            code=staging.kind.code("write_failed"),
        ) from exc
    finally:
        if upload is not None and not finished:
            staging.drop_partial(upload)


def export_stem(item_id: str, fallback: str) -> str:
    """The id without its trailing hash, limited to file-name-safe characters."""
    stem = re.sub(r"-[0-9a-f]{8}$", "", item_id)
    return re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or fallback


def export_response(filename: str, build: Callable[[Path], Path]) -> FileResponse:
    """``build`` writes the file in a private folder, removed once the response is sent or the build refused."""
    folder = Path(tempfile.mkdtemp(prefix="sharecut-export-"))
    try:
        path = build(folder / filename)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return FileResponse(
        path,
        media_type="application/zip",
        filename=path.name,
        headers=NO_STORE,
        background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True),
    )
