"""Document commands, comments and atomic state over HTTP."""

from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel

from podcast_mcp.edits.range_target import RangeChangedError
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    coded_http_error,
    document_conflict_error,
    require_authz,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import DocumentCommandRequest
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.document_sync import (
    DocumentConflictError,
    DocumentSyncService,
    command_context_for_role,
    document_command_from_body,
)
from podcast_mcp.util.project_state import ProjectBusyError
from podcast_mcp.util.sqlite_tx import is_sqlite_busy
from podcast_mcp.util.write_failure import ProjectWriteFailedError

router = APIRouter()


@router.get("/api/clips/{clip_id}/bleed")
def get_clip_bleed(
    clip_id: str,
    request: Request,
    path: str = Query(...),
    track_id: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    from podcast_mcp.edits.bleed_restore_targets import BleedRestoreChangedError
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import TimelineService

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        return (
            TimelineService(ws)
            .inspect_clip_bleed(clip_id, track_id=track_id)
            .model_dump(mode="json")
        )
    except BleedRestoreChangedError as exc:
        raise coded_http_error(409, str(exc), code=exc.code) from exc


@router.get("/api/document/comments")
def get_document_comments(
    request: Request,
    path: str = Query(...),
    client_id: str = Query("viewer"),
    role: str = Query("viewer"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(request, client_id=client_id, role=role, token=token or x_podcast_token)
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    return svc.comments_snapshot()


@router.get("/api/document/state")
def get_document_state(
    request: Request,
    path: str = Query(...),
    phase: str = Query("shell", pattern="^(shell|detail|full)$"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(request, token=token or x_podcast_token)
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    return DocumentSyncService.open(project_path).document_snapshot(projection=phase)


@router.post("/api/document/command")
def post_document_command(
    body: DocumentCommandRequest,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        request,
        client_id=body.client_id,
        role=body.role,
        token=token or x_podcast_token or body.token,
    )
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    cmd = document_command_from_body(body)
    try:
        return svc.submit(
            cmd,
            structural_mode=body.structural_mode,
            range_policy="apply",
            trusted_context=command_context_for_role(cmd.role),
        )
    except DocumentConflictError as exc:
        raise document_conflict_error(exc) from exc
    except ProjectWriteFailedError as exc:
        raise coded_http_error(exc.status, str(exc), code=exc.code) from exc
    except TranscriptRefineRequiredError as exc:
        raise coded_http_error(409, str(exc), code=exc.code) from exc
    except sqlite3.OperationalError as exc:
        if is_sqlite_busy(exc):
            raise ProjectBusyError(str(project_path)) from exc
        raise
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    except PermissionError as exc:
        raise coded_exception_error(403, exc, code="document_command_not_permitted") from exc


class RangeAudioInput(BaseModel):
    model_config = {"extra": "forbid"}
    target: ExactRangeTarget
    action: Literal["play"] = "play"


@router.post("/api/range-audio")
def range_audio(
    body: RangeAudioInput,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    from podcast_mcp.gui.audio import pinned_audio_response
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        audio = PlayService(ws).play_selected_range(body.target)
        return pinned_audio_response(audio, media_type="audio/wav", filename=audio.name)
    except RangeChangedError as exc:
        raise coded_exception_error(409, exc, code="range_changed") from exc


@router.post("/api/pending-preview/warm")
def pending_preview_warm(
    request: Request,
    path: str = Query(...),
    edit_id: str | None = Query(None),
    background: bool = Query(False),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Run a pending preview's whole-episode passes ahead of the first Play around.

    Neither form holds the render lock beyond each stale stem's own render, so a render or
    approve the user starts meanwhile is not queued behind the warm. ``background`` is the
    idle pre-measure: no edit, a lower CPU priority, and a 2 s wait for that stem lock (the
    client asks again later).
    """
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.util.process import low_priority
    from podcast_mcp.util.project_state import (
        BACKGROUND_RENDER_LOCK_TIMEOUT_SEC,
        REQUEST_RENDER_LOCK_TIMEOUT_SEC,
    )

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    try:
        if background:
            with low_priority():
                return PlayService(ProjectWorkspace.open(project_path)).warm_pending_preview(
                    None, lock_timeout=BACKGROUND_RENDER_LOCK_TIMEOUT_SEC
                )
        # The edit's renders read the sources and write content-addressed files atomically,
        # so a render or approve the user starts meanwhile is not queued behind them; only
        # each stale stem's own render takes the lock.
        # Niced like the background warm: the user is editing while it runs, and a Play around
        # on the same edit shares its render rather than racing it.
        with low_priority():
            return PlayService(ProjectWorkspace.open(project_path)).warm_pending_preview(
                edit_id, lock_timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC
            )
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.get("/api/pending-preview")
def pending_preview_audio(
    request: Request,
    path: str = Query(...),
    edit_id: str = Query(...),
    mode: Literal["current", "suggested", "ab"] = Query("suggested"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    from podcast_mcp.gui.audio import pinned_audio_response
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.util.project_state import render_lock

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        # A preview already rendered (by the warm) is a file read: it waits for no render,
        # approve or other holder of the lock.
        audio = PlayService(ws).pending_preview_cached_wav(edit_id, mode=mode)
        if audio is None:
            with render_lock(ws.project), ws.transaction():
                audio = (
                    PlayService(ws).play_pending_preview(edit_id, mode=mode, dry_run=True).wav_path
                )
        return pinned_audio_response(audio, media_type="audio/wav", filename=audio.name)
    except RangeChangedError as exc:
        raise coded_exception_error(409, exc, code="range_changed") from exc
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="pending_edit_not_found") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
