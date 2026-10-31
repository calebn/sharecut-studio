"""Shared FastAPI helpers for GUI route authz and project path resolution."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request, WebSocket
from fastapi.exception_handlers import http_exception_handler
from filelock import Timeout
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

from podcast_mcp.models.episode import ProjectUnreadableError
from podcast_mcp.project.io import ensure_utf8_path
from podcast_mcp.services.document_sync import DocumentConflictError
from podcast_mcp.services.media import TranscriptContextBusyError
from podcast_mcp.services.session_sync import (
    authorize_client,
    authorize_host,
)
from podcast_mcp.util.coded_error import (
    AccessDeniedError,
    CodedError,
    GuardRefusal,
    HostSetupError,
    SignInRequiredError,
)
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, busy_message
from podcast_mcp.util.proxy_paths import is_relayed_request
from podcast_mcp.util.tool_refusal import tool_refusal

ERROR_CODE_HEADER = "X-Sharecut-Error-Code"
NO_STORE = {"Cache-Control": "no-store"}
SHARE_LOGIN_PATH = "/auth/login"


class _AsciiJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return json.dumps(content, allow_nan=False, separators=(",", ":")).encode("ascii")


async def http_exception_response(request: Request, exc: StarletteHTTPException) -> Response:
    """FastAPI's HTTPException response; a lone surrogate in the detail renders as a \\udcXX escape."""
    try:
        return await http_exception_handler(request, exc)
    except UnicodeEncodeError:
        return _AsciiJSONResponse(
            {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
        )


def coded_http_error(
    status_code: int, detail: Any, *, code: str, headers: Mapping[str, str] | None = None
) -> HTTPException:
    """The one place an HTTP error gets its ``X-Sharecut-Error-Code`` header (the refusal's *code*)."""
    return HTTPException(
        status_code=status_code,
        detail=detail,
        headers={**(headers or {}), ERROR_CODE_HEADER: code},
    )


def document_conflict_error(exc: DocumentConflictError) -> HTTPException:
    """HTTP 409 for a refused document command, with its code as ``X-Sharecut-Error-Code``
    (``document_conflict``, or a stale guard's own code such as ``history_stale``).

    Shared by the host and guest document-command routes.
    """
    return coded_http_error(409, {"detail": str(exc), "conflict": True}, code=exc.code)


def coded_exception_error(status_code: int, exc: Exception, *, code: str) -> HTTPException:
    """HTTP error carrying *exc*'s message; a ``CodedError`` sends its own code, else *code*.

    *code* is the route's fallback for an exception that is not coded (a lookup that raised a
    bare ``KeyError``): name what the route refused, not the exception class.
    """
    return coded_http_error(
        status_code, str(exc), code=exc.code if isinstance(exc, CodedError) else code
    )


def bad_request_error(exc: ValueError) -> HTTPException:
    """HTTP 400 with the refusal's message; a ``CodedError`` also sends its code."""
    return coded_exception_error(400, exc, code="invalid_request")


def guard_http_error(exc: GuardRefusal) -> HTTPException:
    """HTTP 401 (sign-in needed), 403 (denied) or 404 (unknown share) for an auth guard's refusal.

    The 401 detail is a dict the sign-in page reads; the others are the message as a string.
    """
    if isinstance(exc, SignInRequiredError):
        detail = {"error": exc.code, "message": str(exc), "login_path": SHARE_LOGIN_PATH}
        return coded_http_error(401, detail, code=exc.code)
    status = 404 if isinstance(exc, KeyError) else 403
    return coded_http_error(status, str(exc), code=exc.code)


async def guard_exception_handler(request: Request, exc: Exception) -> Response:
    """App-wide: an auth guard's refusal leaves as ``guard_http_error``."""
    assert isinstance(exc, GuardRefusal)
    return await http_exception_response(request, guard_http_error(exc))


async def project_busy_exception_handler(request: Request, exc: Exception) -> Response:
    """The one busy mapping: a lock ``Timeout`` (or a busy transcript context) becomes 503 ``project_busy``.

    Installed on the FastAPI app (``app.add_exception_handler``), so routes do not catch
    ``Timeout`` themselves (#488, #1810). The text is fixed and never names the lock path.
    Starlette only calls a handler registered on a class with an instance of it; the assert
    documents that and narrows the type. Busy answers are never cached.
    """
    assert isinstance(exc, (Timeout, TranscriptContextBusyError))
    message = str(exc) if isinstance(exc, TranscriptContextBusyError) else busy_message(exc)
    return await http_exception_response(
        request, coded_http_error(503, message, code=PROJECT_BUSY_CODE, headers=NO_STORE)
    )


async def project_unreadable_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ProjectUnreadableError)
    return await http_exception_response(
        request, coded_http_error(500, str(exc), code=exc.code, headers=NO_STORE)
    )


def _is_host(request: Request) -> bool:
    return authorize_host(
        peer_host=peer_host(request),
        token=request.query_params.get("token") or request.headers.get("X-Podcast-Token"),
        relayed=is_relayed_request(request.headers),
    ).allowed


async def host_setup_exception_handler(request: Request, exc: Exception) -> Response:
    """App-wide fallback: a host file or folder that is not private becomes HTTP 500 with the refusal.

    Covers every ``HostSetupError``: the share registry and the review artifacts folder.

    The host reads the message with its path and fix; any other caller (a relayed share guest)
    reads the refusal's guest message, like every refusal a guest sees (``util/tool_refusal.py``).
    """
    assert isinstance(exc, HostSetupError)
    host = _is_host(request)
    refusal = tool_refusal(exc, for_guest=not host)
    assert refusal is not None
    return await http_exception_response(
        request, coded_http_error(500, refusal.message, code=refusal.code)
    )


async def model_missing_exception_handler(request: Request, exc: Exception) -> Response:
    """App-wide: an action that needs a model that is not installed becomes 409 ``model_needed``.

    The host reads the model's fields to offer the download; any other caller (a relayed share
    guest) reads only the guest copy, with no model, command or size.
    """
    assert isinstance(exc, ModelMissing)
    host = _is_host(request)
    refusal = tool_refusal(exc, for_guest=not host)
    assert refusal is not None
    detail = {"detail": refusal.message, **(refusal.extra or {})} if host else refusal.message
    return await http_exception_response(
        request, coded_http_error(409, detail, code=refusal.code, headers=NO_STORE)
    )


def peer_host(request: Request) -> str | None:
    if request.client:
        return request.client.host
    return None


def require_authz(
    request: Request,
    *,
    client_id: str | None = None,
    role: str | None = None,
    token: str | None = None,
) -> None:
    """Session-sync gate for a viewer, agent or editor client; raises ``AccessDeniedError`` when denied."""
    decision = authorize_client(
        client_id=client_id or "anonymous",
        role=role or "viewer",
        peer_host=peer_host(request),
        token=token,
        relayed=is_relayed_request(request.headers),
    )
    if not decision.allowed:
        raise AccessDeniedError(decision.reason, code="authz_denied")


def require_host(
    request: Request,
    *,
    token: str | None = None,
    x_podcast_token: str | None = None,
    client_id: str = "host",
) -> None:
    """Host-role gate for owner GUI routes (#393); raises ``AccessDeniedError`` when denied."""
    decision = authorize_host(
        client_id=client_id,
        peer_host=peer_host(request),
        token=token or x_podcast_token,
        relayed=is_relayed_request(request.headers),
    )
    if not decision.allowed:
        raise AccessDeniedError(decision.reason, code="authz_denied")


def refuse_relayed(request: Request) -> None:
    """Deny a relay-tunneled request on an owner route that a ticket, not a token, opens."""
    if is_relayed_request(request.headers):
        decision = authorize_host(relayed=True)
        raise AccessDeniedError(decision.reason, code="authz_denied")


def resolve_project(path: str, request: Request | WebSocket | None = None) -> Path:
    """Resolve *path* and optionally pin to ``app.state.served_project``.

    *request* may be a FastAPI ``Request`` or Starlette ``WebSocket`` (both expose
    ``.app``). When the GUI was started with ``--project``, other paths are 403.
    """
    try:
        project_path = Path(path).expanduser().resolve()
        exists = project_path.is_file()
    except ValueError as exc:
        raise coded_http_error(
            400, f"project path is not valid UTF-8: {path!a}", code="project_path_invalid"
        ) from exc
    if not exists:
        raise coded_http_error(404, f"Project not found: {project_path}", code="project_not_found")
    try:
        ensure_utf8_path(project_path)
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="project_path_invalid") from exc
    if request is not None:
        served = getattr(request.app.state, "served_project", None)
        if served is not None and project_path != Path(served).resolve():
            raise coded_http_error(
                403,
                "project path not allowed for this server instance",
                code="project_path_not_allowed",
            )
    return project_path
