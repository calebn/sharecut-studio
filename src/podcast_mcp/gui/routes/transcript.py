from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.routes.deps import project_busy_error, require_host, resolve_project
from podcast_mcp.gui.schemas import TranscriptRefineWaiveRequest, TranscriptVocabularyPutRequest
from podcast_mcp.services import (
    ProjectWorkspace,
    TranscriptContextBusyError,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)
from podcast_mcp.util.project_state import TRANSCRIPT_CONTEXT_BUSY_MESSAGE

router = APIRouter()


@router.get("/api/transcript/vocabulary")
def transcript_vocabulary_get(
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return TranscriptPrecorrectService.vocabulary_status(project_path)


@router.put("/api/transcript/vocabulary")
def transcript_vocabulary_put(
    req: TranscriptVocabularyPutRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    try:
        return TranscriptPrecorrectService(ProjectWorkspace.open(project_path)).set_vocabulary(
            terms=req.terms,
            guest_names=req.guest_names,
            base_revision=req.base_revision,
        )
    except VocabularyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TranscriptContextBusyError as exc:
        raise project_busy_error(TRANSCRIPT_CONTEXT_BUSY_MESSAGE) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/transcript/refine/waive")
def transcript_refine_waive(
    req: TranscriptRefineWaiveRequest,
    request: Request,
    token: str | None = None,
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Record an intentional host waiver for the transcript-refine gate."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    try:
        return TranscriptRefineService(ProjectWorkspace.open(project_path)).waive(
            reason=req.reason,
            source="user",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
