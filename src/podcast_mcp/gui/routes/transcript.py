from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.gui.schemas import TranscriptRefineWaiveRequest
from podcast_mcp.services import ProjectWorkspace, TranscriptRefineService

router = APIRouter()


@router.post("/api/transcript/refine/waive")
def transcript_refine_waive(
    req: TranscriptRefineWaiveRequest,
    request: Request,
    token: str | None = None,
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Record an intentional host waiver for the transcript-refine gate."""
    require_authz(
        client_id="viewer",
        role="viewer",
        peer_host=peer_host(request),
        token=token or x_podcast_token,
    )
    project_path = resolve_project(req.path, request)
    if not req.reason.strip():
        raise HTTPException(status_code=400, detail="refine waive requires a non-empty reason")
    try:
        return TranscriptRefineService(ProjectWorkspace.open(project_path)).waive(
            reason=req.reason,
            source="user",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
