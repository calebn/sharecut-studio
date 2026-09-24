"""Host media upload into episode ``raw/`` (bytes only; mutations via document commands)."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.media_store import (
    gui_media_chunk_max_bytes,
    gui_media_max_bytes,
    write_upload_chunk,
)
from podcast_mcp.util.body_limits import BodyTooLarge, payload_too_large_response, read_body_capped

router = APIRouter()


@router.post("/api/media/upload")
async def upload_media(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    filename: str = Query(..., description="Original filename (extension required)"),
    upload_id: str | None = Query(None),
    chunk_index: int = Query(0, ge=0),
    total_chunks: int = Query(1, ge=1),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    limit = gui_media_chunk_max_bytes() if total_chunks > 1 else gui_media_max_bytes()
    try:
        data = await read_body_capped(request, limit)
    except BodyTooLarge as exc:
        return payload_too_large_response(exc.limit)

    ws = ProjectWorkspace.open(project_path)
    try:
        result = write_upload_chunk(
            ws.project.workspace_path(),
            filename=filename,
            data=data,
            upload_id=upload_id,
            chunk_index=chunk_index,
            total_chunks=total_chunks,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid audio: {exc}") from exc
    return result
