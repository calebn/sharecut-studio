"""Public review share routes - token-scoped, no absolute project paths."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, RedirectResponse, Response
from filelock import Timeout
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from podcast_mcp.edits.share_capabilities import CAP_EDIT, CAP_VIEW
from podcast_mcp.edits.share_registry import SHARE_KIND_REVIEW
from podcast_mcp.gui.assembler import VIEW_PROJECTION_QUERY_DESCRIPTION, ViewProjection
from podcast_mcp.gui.audio import pinned_audio_response
from podcast_mcp.gui.background import release_background
from podcast_mcp.gui.routes.deps import project_busy_from_timeout, project_busy_http_error
from podcast_mcp.gui.routes.guest_ws_common import (
    GUEST_MALFORMED_LIMIT,
    GuestWsGuard,
    admit_guest_ws,
    guest_ws_reject,
    guest_ws_share_row,
)
from podcast_mcp.gui.routes.session import apply_ws_client_message
from podcast_mcp.gui.routes.share_common import (
    check_share_token,
    rate_limit_share,
    share_features_manifest,
)
from podcast_mcp.gui.routes.waveform import NO_STORE as WAVEFORM_NO_STORE
from podcast_mcp.gui.routes.waveform import (
    OCTET_STREAM_RESPONSES,
    binary_response,
    waveform_call,
)
from podcast_mcp.gui.schemas import DocumentCommandRequest, ShareActionDoneRequest
from podcast_mcp.services.cross_process_sync import cross_process_lease
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.payloads import (
    COMMENT_BODY_MAX,
    document_command_from_body,
)
from podcast_mcp.services.document_sync.service import document_hub_key
from podcast_mcp.services.guest_progress import guest_progress_hub
from podcast_mcp.services.remote_mcp.limits import (
    get_host_limiters,
    host_rate_limit_enabled,
    rate_limit_detail,
    ws_roster_request_allowed,
)
from podcast_mcp.services.review_media import media_type_for_path
from podcast_mcp.services.session_sync.authz import authorize_share_token
from podcast_mcp.services.session_sync.commands import (
    GUEST_CLIENT_ID_PREFIX,
    SyncCommand,
    sanitize_display_name,
)
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.presence_delta import (
    ROSTER_REQUEST,
    is_own_presence_echo,
)
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.services.share import (
    lookup_share,
    require_share_cap,
    resolve_share_audio_redirect,
    sanitize_guest_document_event,
    sanitize_guest_session_event,
    sanitize_guest_session_snapshot,
    share_add_comment,
    share_add_reply,
    share_audio_path,
    share_audition_context_cached,
    share_audition_context_image,
    share_audition_context_image_cached,
    share_audition_context_info,
    share_daw_audio_path,
    share_daw_meta,
    share_daw_project_view,
    share_daw_waveform_snap,
    share_daw_waveform_status,
    share_daw_waveform_tiles,
    share_pending_preview_image,
    share_pending_preview_image_cached,
    share_pending_preview_wav,
    share_pending_preview_wav_cached,
    share_project_view,
    share_proxy_chunk_path,
    share_proxy_manifest,
    share_set_action_done,
    share_upload_media,
)
from podcast_mcp.services.share_auth.access import access_required
from podcast_mcp.util.ws_limits import GUEST_FRAME_MAX_BYTES

router = APIRouter()
log = logging.getLogger(__name__)

_GUEST_CLIENT_SUFFIX_RE = re.compile(r"[^A-Za-z0-9_-]")


class ShareCommentRequest(BaseModel):
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str
    timeline_start: float
    timeline_end: float | None = None
    edit_decision_id: str | None = None
    track_ids: list[str] | None = None


class ShareReplyRequest(BaseModel):
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str


def _check_token(token: str, *, kind: str = SHARE_KIND_REVIEW) -> dict[str, Any]:
    return check_share_token(token, kind=kind)


def _rate_limit(token: str, kind: str) -> None:
    rate_limit_share(token, kind)


def _audio_slot(token: str) -> BackgroundTask | None:
    """Take an audio concurrency slot; the returned task releases it after the response.

    Raises 429 when the share is at its audio concurrency cap.
    """
    if not host_rate_limit_enabled():
        return None
    lim = get_host_limiters()
    decision = lim.audio_concurrent.try_enter(token)
    if not decision.allowed:
        raise HTTPException(
            status_code=429,
            detail=rate_limit_detail(decision),
            headers={"Retry-After": decision.retry_after_header},
        )
    return BackgroundTask(lim.audio_concurrent.exit, token)


def _audio_file_response(token: str, path, **kwargs: Any):
    """Pin authorized media before returning; hold the slot until streaming ends."""
    cache_audio = kwargs.pop("cache_audio", False)
    return pinned_audio_response(path, cache=cache_audio, background=_audio_slot(token), **kwargs)


def _map_share_exc(exc: Exception) -> HTTPException:
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    if isinstance(exc, DocumentConflictError):
        return HTTPException(
            status_code=409,
            detail={"detail": str(exc), "conflict": True},
        )
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail="not found")
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail="not found")
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    busy = project_busy_http_error(exc)
    if busy is not None:
        return busy
    return HTTPException(status_code=500, detail="internal error")


@router.get("/api/review/{token}/project")
def get_review_project(token: str) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "read")
    try:
        return share_project_view(token)
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="not found") from exc


@router.get("/api/review/{token}/features")
def get_review_features(token: str, request: Request) -> dict[str, Any]:
    """Share-scoped feature manifest (relay-safe; guests cannot hit /api/features)."""
    _check_token(token)
    _rate_limit(token, "read")
    return share_features_manifest(request)


@router.get("/api/review/{token}/audio")
def get_review_audio(token: str):
    _check_token(token)
    try:
        redirect = resolve_share_audio_redirect(token)
        if redirect:
            return RedirectResponse(url=redirect, status_code=302)
        path = share_audio_path(token)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type=media_type_for_path(path),
        filename=path.name,
        content_disposition_type="inline",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


@router.get("/api/review/{token}/daw/project")
def get_daw_project(
    token: str,
    phase: ViewProjection | None = Query(
        None,
        description=VIEW_PROJECTION_QUERY_DESCRIPTION,
    ),
) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "read")
    try:
        return share_daw_project_view(token, phase=None if phase is None else phase.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.get("/api/review/{token}/daw/meta")
def get_daw_meta(token: str) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "read")
    try:
        return share_daw_meta(token)
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.get("/api/review/{token}/daw/waveform/status")
def get_daw_waveform_status(token: str) -> JSONResponse:
    """Raw-media pyramid status (``view``); same shape as the host status route."""

    def run() -> dict[str, Any]:
        _check_token(token)
        _rate_limit(token, "read")
        return share_daw_waveform_status(token)

    return JSONResponse(waveform_call(run, fallback=_map_share_exc), headers=WAVEFORM_NO_STORE)


@router.get(
    "/api/review/{token}/daw/waveform/tiles/{key}",
    response_class=Response,
    responses=OCTET_STREAM_RESPONSES,
)
def get_daw_waveform_tiles(
    token: str,
    key: str,
    ref: str = Query(..., description="track:<id> or source:<id>"),
    level: int = Query(...),
    start: int = Query(..., description="First data tile"),
    count: int = Query(1, description="Data tiles (1..max_tiles_per_request)"),
) -> Response:
    """Immutable pyramid data tiles (``view``); audio rate class. No guest PCM route.

    The audio slot is taken before any disk work, so the concurrency cap bounds it.
    """

    def run() -> Response:
        _check_token(token)
        _rate_limit(token, "audio")
        slot = _audio_slot(token)
        try:
            body = share_daw_waveform_tiles(
                token, ref=ref, key=key, level=level, start=start, count=count
            )
        except BaseException:
            release_background(slot)
            raise
        return binary_response(body, background=slot)

    return waveform_call(run, fallback=_map_share_exc)


@router.get("/api/review/{token}/daw/waveform-snap")
def get_daw_waveform_snap(
    token: str,
    track_id: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    timeline: bool = Query(False),
    focus: float | None = Query(None),
):
    _check_token(token)
    _rate_limit(token, "read")
    try:
        return share_daw_waveform_snap(
            token,
            track_id=track_id,
            start=start,
            end=end,
            timeline=timeline,
            focus=focus,
        )
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.get("/api/review/{token}/daw/audio")
def get_daw_audio(
    token: str,
    kind: str = Query("premix"),
    track_id: str | None = Query(None),
    rerender: bool = Query(False),
):
    """Guest DAW audio - kind whitelist; ``rerender`` is always rejected."""
    _check_token(token)
    if rerender:
        raise HTTPException(status_code=403, detail="rerender not allowed for shares")
    try:
        path = share_daw_audio_path(token, kind=kind, track_id=track_id)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type="audio/wav",
        filename=path.name,
        content_disposition_type="inline",
        cache_audio=True,
    )


@router.get("/api/review/{token}/daw/pending-preview")
def get_daw_pending_preview(
    token: str,
    edit_id: str = Query(...),
    mode: str = Query("suggested"),
):
    """Listen-first Current / Suggested / A/B WAV (``play`` + ``view``)."""
    _check_token(token)
    try:
        cached = share_pending_preview_wav_cached(token, edit_id=edit_id, mode=mode)
        if cached is None:
            _rate_limit(token, "mutate")
        path = share_pending_preview_wav(token, edit_id=edit_id, mode=mode)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type="audio/wav",
        filename=path.name,
        content_disposition_type="inline",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


@router.get("/api/review/{token}/daw/pending-preview-image")
def get_daw_pending_preview_image(
    token: str,
    edit_id: str = Query(...),
    mode: str = Query("suggested"),
    kind: str = Query("wave"),
):
    """Waveform or spectrogram of a listen-first extract (``play`` + ``view``)."""
    _check_token(token)
    try:
        cached = share_pending_preview_image_cached(token, edit_id=edit_id, mode=mode, kind=kind)
        if cached is None:
            _rate_limit(token, "mutate")
        path = share_pending_preview_image(token, edit_id=edit_id, mode=mode, kind=kind)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type="image/png",
        filename=path.name,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/api/review/{token}/daw/audition-context")
def get_daw_audition_context(
    token: str,
    start: float = Query(..., description="Timeline start seconds"),
    end: float = Query(..., description="Timeline end seconds"),
    visual: bool = Query(True),
) -> dict[str, Any]:
    """Windowed hear context: captions + PNG URLs (``play`` + ``view``)."""
    _check_token(token)
    try:
        if visual and not share_audition_context_cached(token, start=start, end=end):
            _rate_limit(token, "mutate")
        return share_audition_context_info(token, start=start, end=end, visual=visual)
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.get("/api/review/{token}/daw/audition-context-image")
def get_daw_audition_context_image(
    token: str,
    start: float = Query(...),
    end: float = Query(...),
    track_id: str = Query(...),
    kind: str = Query("wave"),
):
    """Waveform or spectrogram of a timeline window (``play`` + ``view``)."""
    _check_token(token)
    try:
        cached = share_audition_context_image_cached(
            token, start=start, end=end, track_id=track_id, kind=kind
        )
        if cached is None:
            _rate_limit(token, "mutate")
        path = share_audition_context_image(
            token, start=start, end=end, track_id=track_id, kind=kind
        )
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type="image/png",
        filename=path.name,
        content_disposition_type="inline",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/api/review/{token}/daw/proxy/manifest")
def get_daw_proxy_manifest(token: str) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "read")
    try:
        return share_proxy_manifest(token)
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.get("/api/review/{token}/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}")
def get_daw_proxy_chunk(token: str, track_id: str, proxy_hash: str, chunk_idx: int):
    _check_token(token)
    _rate_limit(token, "read")
    try:
        path = share_proxy_chunk_path(token, track_id, chunk_idx, proxy_hash=proxy_hash)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return _audio_file_response(
        token,
        path,
        media_type="audio/mpeg",
        filename=path.name,
        content_disposition_type="inline",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.post("/api/review/{token}/daw/render-preview", status_code=202)
def post_daw_render_preview(token: str, request: Request) -> dict[str, Any]:
    """Docs Editor (``edit``) may rebuild stems/premix on the host project.

    Opt-in via ``PODCAST_GUEST_RENDER=1``. Uses the same ``PipelineJobManager``
    lock as the host GUI so concurrent host/guest renders cannot race.
    """

    from podcast_mcp.gui.jobs import guest_render_job
    from podcast_mcp.util.guest_render import require_guest_render

    _check_token(token)
    _rate_limit(token, "mutate")
    try:
        require_guest_render()
        _row, ws = require_share_cap(token, CAP_EDIT)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:
        raise _map_share_exc(exc) from exc

    jobs = request.app.state.jobs
    try:
        job = jobs.start_render_preview(ws.path)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    projected = guest_render_job(job, ws.path)
    if projected is None:
        raise HTTPException(status_code=500, detail="Render preview job unavailable")
    return {"job": projected}


@router.get("/api/review/{token}/daw/render-preview/{job_id}")
def get_daw_render_preview(token: str, job_id: str, request: Request) -> dict[str, Any]:
    """Poll a render belonging to this edit share's project."""
    from podcast_mcp.gui.jobs import guest_render_job

    _check_token(token)
    _rate_limit(token, "read")
    try:
        _row, ws = require_share_cap(token, CAP_EDIT)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    job = guest_render_job(request.app.state.jobs.get_job(job_id), ws.path)
    if job is None:
        raise HTTPException(status_code=404, detail="Render preview job not found")
    return {"job": job}


@router.post("/api/review/{token}/daw/document/command")
def post_daw_document_command(token: str, body: DocumentCommandRequest) -> dict[str, Any]:
    """Guest document commands - capability-gated Pass 1-2 / suggest set."""
    _check_token(token)
    _rate_limit(token, "mutate")
    try:
        row, ws = require_share_cap(token, CAP_VIEW)
        svc = DocumentSyncService(ws)
        cmd = document_command_from_body(body)
        # Guests always use role=guest regardless of client-supplied role.
        cmd.role = "guest"
        return sanitize_guest_document_event(
            svc.submit(
                cmd,
                capabilities=list(row.get("capabilities") or []),
                structural_mode=body.structural_mode,
            )
        )
    except Exception as exc:
        raise _map_share_exc(exc) from exc


@router.post("/api/review/{token}/daw/media/upload")
async def post_daw_media_upload(
    token: str,
    request: Request,
    filename: str = Query(..., description="Original filename (extension required)"),
    upload_id: str | None = Query(None),
    chunk_index: int = Query(0, ge=0),
    total_chunks: int = Query(1, ge=1),
):
    """Guest ``edit`` only: chunked upload into host ``raw/`` (then SetTrackMedia)."""
    from podcast_mcp.services.media_store import gui_media_chunk_max_bytes
    from podcast_mcp.util.body_limits import (
        BodyTooLarge,
        payload_too_large_response,
        read_body_capped,
    )

    _check_token(token)
    _rate_limit(token, "mutate")
    limit = gui_media_chunk_max_bytes()
    try:
        data = await read_body_capped(request, limit)
    except BodyTooLarge as exc:
        return payload_too_large_response(exc.limit)

    try:
        return share_upload_media(
            token,
            filename=filename,
            data=data,
            upload_id=upload_id,
            chunk_index=chunk_index,
            total_chunks=total_chunks,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Timeout as exc:
        raise project_busy_from_timeout(exc) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid audio: {exc}") from exc


@router.post("/api/review/{token}/comments")
def post_review_comment(token: str, req: ShareCommentRequest) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "mutate")
    try:
        comment = share_add_comment(
            token,
            body=req.body,
            author=req.author,
            timeline_start=req.timeline_start,
            timeline_end=req.timeline_end,
            edit_decision_id=req.edit_decision_id,
            track_ids=req.track_ids,
        )
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return {"comment": comment}


@router.post("/api/review/{token}/comments/{comment_id}/replies")
def post_review_reply(token: str, comment_id: str, req: ShareReplyRequest) -> dict[str, Any]:
    _check_token(token)
    _rate_limit(token, "mutate")
    try:
        result = share_add_reply(token, comment_id, body=req.body, author=req.author)
    except Exception as exc:
        raise _map_share_exc(exc) from exc
    return result


@router.post("/api/review/{token}/comments/{comment_id}/actions/{action_id}/done")
def post_review_action_done(
    token: str,
    comment_id: str,
    action_id: str,
    req: ShareActionDoneRequest,
) -> dict[str, Any]:
    """HTTP twin for MCP ``guest_set_action_done`` (requires ``action`` cap)."""
    _check_token(token)
    _rate_limit(token, "mutate")
    try:
        return share_set_action_done(
            token,
            comment_id,
            action_id,
            done=req.done,
            by=req.by,
        )
    except Exception as exc:
        raise _map_share_exc(exc) from exc


def _guest_client_id(token: str, client_id: str | None) -> str:
    suffix = _GUEST_CLIENT_SUFFIX_RE.sub("", client_id or "")[:16]
    if not suffix:
        suffix = secrets.token_hex(4)
    return f"{GUEST_CLIENT_ID_PREFIX}{token[:8]}-{suffix}"


def _guest_label(name: str | None, token: str) -> str:
    cleaned = sanitize_display_name(name, guest=True)
    return cleaned or f"Guest {token[:6]}"


def guest_restricted_origin_allowed(origin: str | None) -> bool:
    """Allow loopback / missing Origin (tests, tunnel) or the public share origin."""
    from podcast_mcp.gui.middleware_host_binding import origin_is_loopback
    from podcast_mcp.services.share_page import share_public_origin

    if origin_is_loopback(origin):
        return True
    parsed = urlparse(str(origin or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False
    allowed = share_public_origin().rstrip("/")
    candidate = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    return candidate.casefold() == allowed.casefold()


def _restricted_principal_ok(websocket: WebSocket, token: str) -> bool:
    from podcast_mcp.services.share_auth.policy import resolve_principal_from_headers

    principal = resolve_principal_from_headers(
        websocket.headers,
        websocket.cookies,
        share_token=token,
    )
    return principal is not None and principal.acl_role is not None


def _share_still_valid(token: str, *, restricted: bool, websocket: WebSocket) -> bool:
    try:
        lookup_share(token, kind="review")
        require_share_cap(token, CAP_VIEW)
    except (KeyError, PermissionError, FileNotFoundError):
        return False
    return (not restricted) or _restricted_principal_ok(websocket, token)


def _share_token_present(token: str) -> bool:
    try:
        lookup_share(token, kind="review")
    except (KeyError, FileNotFoundError):
        return False
    return True


def _share_progress_still_valid(token: str, *, restricted: bool, websocket: WebSocket) -> bool:
    if not _share_token_present(token):
        return False
    return (not restricted) or _restricted_principal_ok(websocket, token)


def _guest_session_frame(event: dict[str, Any], *, guest_client_id: str) -> dict[str, Any]:
    """Sanitize and tag one session-plane event (a hub event, or a direct ``RosterRequest``
    reply) for the guest wire: adds ``plane`` / the guest's assigned ``client_id``."""
    return sanitize_guest_session_event({**event, "plane": "session", "client_id": guest_client_id})


@dataclass
class GuestFrameResult:
    """One inbound guest frame's outcome: the next ``seq``, the malformed-frame count, an
    optional close reason, and an optional reply to send only to this connection."""

    seq: int
    malformed: int
    close_reason: str | None
    reply: dict[str, Any] | None = None


def _handle_guest_presence_frame(
    text: str,
    *,
    session_svc: SessionSyncService,
    guest_client_id: str,
    label: str,
    seq: int,
    token: str,
    websocket: WebSocket,
    malformed: int,
) -> GuestFrameResult:
    """Parse one guest inbound frame (``Presence`` or ``RosterRequest``)."""
    if len(text) > GUEST_FRAME_MAX_BYTES:
        log.info("guest presence rejected size token=%s", token[:8])
        return GuestFrameResult(seq, malformed + 1, None)
    try:
        msg = json.loads(text)
    except ValueError:
        log.info("guest presence rejected malformed token=%s", token[:8])
        return GuestFrameResult(seq, malformed + 1, None)
    if not isinstance(msg, dict) or msg.get("type") not in ("Presence", ROSTER_REQUEST):
        log.info("guest presence rejected type token=%s", token[:8])
        return GuestFrameResult(seq, malformed + 1, None)
    if host_rate_limit_enabled():
        lim = get_host_limiters()
        conn_key = f"{token}:{id(websocket)}"
        if not lim.guest_ws_presence.allow(conn_key).allowed:
            log.info("guest presence rejected rate token=%s", token[:8])
            return GuestFrameResult(seq, malformed, None)
        if not lim.guest_ws_presence_token.allow(token).allowed:
            log.info("guest presence rejected token-rate token=%s", token[:8])
            return GuestFrameResult(seq, malformed, None)
    if msg.get("type") == ROSTER_REQUEST:
        # Keyed by the assigned guest client id (stable across reconnects, like the host
        # socket's ``host:{client_id}``), so a reconnect does not reset the budget.
        if not ws_roster_request_allowed(f"guest:{guest_client_id}"):
            return GuestFrameResult(seq, malformed, None)
        reply = _guest_session_frame(session_svc.roster_event(), guest_client_id=guest_client_id)
        return GuestFrameResult(seq, malformed, None, reply=reply)
    try:
        _, seq = apply_ws_client_message(
            session_svc,
            msg,
            client_id=guest_client_id,
            role="viewer",
            label=label,
            seq=seq,
        )
    except (ValueError, TypeError, KeyError):
        log.info("guest presence rejected validation token=%s", token[:8])
        return GuestFrameResult(seq, malformed + 1, None)
    if malformed > GUEST_MALFORMED_LIMIT:
        return GuestFrameResult(seq, malformed, "too many malformed frames")
    return GuestFrameResult(seq, malformed, None)


async def _pump_guest_progress(
    token: str,
    guard: GuestWsGuard,
    q: asyncio.Queue[dict[str, Any]],
) -> None:
    try:
        while True:
            event = await q.get()
            await guard.send_json(event)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("guest progress pump failed token=%s", token[:8])
        with contextlib.suppress(Exception):
            await guard.close(1011, "progress pump failed")
        raise


async def _admit_review_ws(websocket: WebSocket, token: str) -> bool | None:
    """Review-socket preamble: token, authz, restricted origin/principal.

    Returns the share's ``restricted`` flag, or ``None`` after a reject close
    (callers must test ``is None`` — ``False`` means an open share).
    """
    row = await guest_ws_share_row(websocket, token, kind=SHARE_KIND_REVIEW)
    if row is None:
        return None
    decision = authorize_share_token(token=token, expected_token=row.get("token"))
    if not decision.allowed:
        await guest_ws_reject(websocket, 4403, decision.reason or "forbidden")
        return None
    restricted = access_required(row)
    if restricted:
        if not guest_restricted_origin_allowed(websocket.headers.get("origin")):
            await guest_ws_reject(websocket, 4403, "Origin not allowed")
            return None
        if not _restricted_principal_ok(websocket, token):
            await guest_ws_reject(websocket, 4401, "authentication required")
            return None
    return restricted


@router.websocket("/api/review/{token}/progress/ws")
async def progress_ws(websocket: WebSocket, token: str) -> None:
    """Progress plane only — valid review token, no ``view`` capability required."""
    restricted = await _admit_review_ws(websocket, token)
    if restricted is None:
        return
    conn = await admit_guest_ws(websocket, token, log_label="guest progress ws")
    if conn is None:
        return
    hub = guest_progress_hub()
    q: asyncio.Queue[dict[str, Any]] | None = None
    try:
        guard = await conn.start(
            lambda: _share_progress_still_valid(token, restricted=restricted, websocket=websocket)
        )
        q = hub.subscribe(token, asyncio.get_running_loop())
        conn.spawn(_pump_guest_progress(token, guard, q))
        while True:
            try:
                text = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            if len(text) > GUEST_FRAME_MAX_BYTES:
                await guard.close(4400, "frame too large")
                break
            if not guard.share_ok_on_frame():
                await guard.close(4403, "share revoked or expired")
                break
    finally:
        try:
            if q is not None:
                hub.unsubscribe(token, q)
            await conn.stop_tasks()
        finally:
            conn.release()


@router.websocket("/api/review/{token}/daw/ws")
async def daw_ws(
    websocket: WebSocket,
    token: str,
    client_id: str | None = Query(None),
    name: str | None = Query(None),
) -> None:
    """Guest Sharecut Studio dual-plane fanout (Presence inbound; share-token auth)."""
    restricted = await _admit_review_ws(websocket, token)
    if restricted is None:
        return
    origin = websocket.headers.get("origin")
    if not restricted and origin:
        log.debug("guest ws origin token=%s origin=%s", token[:8], origin)
    try:
        _row, ws_proj = require_share_cap(token, CAP_VIEW)
    except PermissionError as exc:
        await guest_ws_reject(websocket, 4403, str(exc))
        return
    except (KeyError, FileNotFoundError):
        await guest_ws_reject(websocket, 4403, "share not found")
        return

    conn = await admit_guest_ws(websocket, token, log_label="guest ws")
    if conn is None:
        return

    hub = get_hub()
    session_key = str(ws_proj.project.workspace_path())
    doc_key = document_hub_key(ws_proj.project)
    q_session = None
    q_doc = None
    q_progress = None
    progress_hub = guest_progress_hub()
    session_svc: SessionSyncService | None = None
    guest_client_id: str | None = None
    conn_gen: int | None = None

    try:
        guard = await conn.start(
            lambda: _share_still_valid(token, restricted=restricted, websocket=websocket)
        )
        loop = asyncio.get_running_loop()
        q_session = hub.subscribe(session_key, loop)
        q_doc = hub.subscribe(doc_key, loop)
        q_progress = progress_hub.subscribe(token, loop)
        # After subscribe, before the hello snapshots (#695): a foreign write in between
        # is in the snapshots or published by the watcher.
        async with cross_process_lease(ws_proj):
            session_svc = SessionSyncService(ws_proj.project)
            doc_svc = DocumentSyncService(ws_proj)
            guest_client_id = _guest_client_id(token, client_id)
            conn_gen = session_svc.claim_client(guest_client_id)
            label = _guest_label(name, token)
            session_svc.submit(
                SyncCommand(
                    type="PresenceHeartbeat",
                    payload={
                        "label": label,
                        "playhead_sec": None,
                        "meta": {"display_name": label},
                    },
                    client_id=guest_client_id,
                    role="viewer",
                    client_seq=1,
                )
            )
            seq = 2
            await guard.send_json(
                {
                    "type": "Snapshot",
                    "plane": "session",
                    "client_id": guest_client_id,
                    "snapshot": sanitize_guest_session_snapshot(session_svc.snapshot()),
                }
            )
            await guard.send_json(
                sanitize_guest_document_event(
                    {
                        "type": "Snapshot",
                        "plane": "document",
                        "snapshot": doc_svc.document_snapshot(projection="shell"),
                    }
                )
            )

            async def _pump_session() -> None:
                assert q_session is not None and guest_client_id is not None
                try:
                    while True:
                        event = await q_session.get()
                        if is_own_presence_echo(event, guest_client_id):
                            continue
                        await guard.send_json(
                            _guest_session_frame(event, guest_client_id=guest_client_id)
                        )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("guest session pump failed token=%s", token[:8])
                    with contextlib.suppress(Exception):
                        await guard.close(1011, "presence pump failed")
                    raise

            async def _pump_document() -> None:
                assert q_doc is not None
                try:
                    while True:
                        event = await q_doc.get()
                        await guard.send_json(sanitize_guest_document_event(event))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("guest document pump failed token=%s", token[:8])
                    with contextlib.suppress(Exception):
                        await guard.close(1011, "document pump failed")
                    raise

            conn.spawn(_pump_session())
            conn.spawn(_pump_document())
            conn.spawn(_pump_guest_progress(token, guard, q_progress))
            while True:
                try:
                    text = await websocket.receive_text()
                except WebSocketDisconnect:
                    break
                if not guard.share_ok_on_frame():
                    await guard.close(4403, "share revoked or expired")
                    break
                result = _handle_guest_presence_frame(
                    text,
                    session_svc=session_svc,
                    guest_client_id=guest_client_id,
                    label=label,
                    seq=seq,
                    token=token,
                    websocket=websocket,
                    malformed=guard.malformed,
                )
                seq, guard.malformed = result.seq, result.malformed
                if result.reply is not None:
                    # Sent directly, not via the hub queue: order vs hub frames is not
                    # guaranteed; clients drop a full Presence older than their roster
                    # version (presenceFrames.ts).
                    await guard.send_json(result.reply)
                if guard.malformed > GUEST_MALFORMED_LIMIT:
                    await guard.close(4400, "too many malformed frames")
                    break
                if result.close_reason:
                    await guard.close(4400, result.close_reason)
                    break
    finally:
        try:
            if q_session is not None:
                hub.unsubscribe(session_key, q_session)
            if q_doc is not None:
                hub.unsubscribe(doc_key, q_doc)
            if q_progress is not None:
                progress_hub.unsubscribe(token, q_progress)
            await conn.stop_tasks()
        finally:
            try:
                if session_svc is not None and guest_client_id is not None:
                    session_svc.remove_client(guest_client_id, generation=conn_gen)
            finally:
                conn.release()
