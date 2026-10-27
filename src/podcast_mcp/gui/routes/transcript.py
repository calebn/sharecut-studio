from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.edits.transcript_timing import TranscriptTimingChangedError, WordTimingTarget
from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.schemas import (
    TranscriptRefineDoneRequest,
    TranscriptRefineStatusView,
    TranscriptRefineWaiveRequest,
    TranscriptReplacementPreviewRequest,
    TranscriptVocabularyPutRequest,
    TranscriptWordTimingContextRequest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.media import (
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)

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
        raise coded_exception_error(409, exc, code="vocabulary_conflict") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.get("/api/transcript/refine/status", response_model=TranscriptRefineStatusView)
def transcript_refine_status(
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Read the transcript-check gate: open, done or waived, plus the unsure-word count."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return TranscriptRefineService(ProjectWorkspace.open(project_path)).gate_status()


@router.post("/api/transcript/refine/done", response_model=TranscriptRefineStatusView)
def transcript_refine_done(
    req: TranscriptRefineDoneRequest,
    request: Request,
    token: str | None = None,
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Mark the transcript checked for the host. A repeat while done writes nothing."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    return TranscriptRefineService(ProjectWorkspace.open(project_path)).mark_checked(
        notes=req.notes, source="user"
    )


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
        raise bad_request_error(exc) from exc


@router.post("/api/transcript/replacement-preview")
def transcript_replacement_preview(
    req: TranscriptReplacementPreviewRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    try:
        return TranscriptService(
            ProjectWorkspace.open(project_path)
        ).preview_transcript_replacement(req.search, req.replacement, match_case=req.match_case)
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.post("/api/transcript/word-timing-context")
def transcript_word_timing_context(
    req: TranscriptWordTimingContextRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    try:
        return TranscriptService(ProjectWorkspace.open(project_path)).word_timing_context(
            WordTimingTarget(**req.target.model_dump()),
            expected_text=req.expected_word.text,
            expected_start=req.expected_word.start,
            expected_end=req.expected_word.end,
        )
    except TranscriptTimingChangedError as exc:
        raise coded_exception_error(409, exc, code="transcript_timing_changed") from exc
    except (KeyError, FileNotFoundError) as exc:
        raise coded_exception_error(404, exc, code="word_not_found") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
