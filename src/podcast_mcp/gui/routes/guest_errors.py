from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import HTTPException

from podcast_mcp.services.document_sync import DocumentConflictError
from podcast_mcp.services.media import StaleWaveformKeyError, WaveformBusyError
from podcast_mcp.util.coded_error import coded_cause
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE
from podcast_mcp.util.tool_refusal import ToolRefusal, tool_refusal


def _refusal(exc: BaseException, logger: logging.Logger, operation: str) -> ToolRefusal | None:
    refusal = tool_refusal(exc, for_guest=True)
    if refusal is None:
        logger.error("guest %s failed", operation, exc_info=exc)
    return refusal


def guest_http_error(
    exc: BaseException, *, logger: logging.Logger, operation: str
) -> HTTPException:
    """Project an opted-in refusal, or log a crash and return a fixed HTTP 500."""
    refusal = _refusal(exc, logger, operation)
    if refusal is None:
        return HTTPException(status_code=500, detail="internal error")
    headers = {"X-Sharecut-Error-Code": refusal.code}
    if refusal.code == PROJECT_BUSY_CODE:
        return HTTPException(status_code=503, detail=refusal.message, headers=headers)
    cause = coded_cause(exc)
    if isinstance(cause, DocumentConflictError):
        return HTTPException(
            status_code=409,
            detail={"detail": refusal.message, "conflict": True},
            headers=headers,
        )
    if isinstance(cause, WaveformBusyError):
        return HTTPException(
            status_code=503,
            detail=refusal.message,
            headers={**headers, "Retry-After": cause.retry_after},
        )
    if isinstance(cause, StaleWaveformKeyError) or refusal.code == "job_running":
        status = 409
    elif isinstance(cause, PermissionError):
        status = 403
    elif isinstance(cause, (KeyError, LookupError, FileNotFoundError)):
        status = 404
    else:
        status = 400
    return HTTPException(status_code=status, detail=refusal.message, headers=headers)


@dataclass(frozen=True)
class _WsError:
    detail: str
    code: str
    close_code: int

    @property
    def close_reason(self) -> str:
        return self.detail.encode("utf-8")[:120].decode("utf-8", errors="ignore")


def guest_ws_error(exc: BaseException, *, logger: logging.Logger, operation: str) -> _WsError:
    """Return safe frame detail, domain code, and a bounded admission close reason."""
    refusal = _refusal(exc, logger, operation)
    if refusal is None:
        return _WsError("internal error", "internal_error", 1011)
    close_code = 1013 if refusal.code == PROJECT_BUSY_CODE else 4403
    return _WsError(refusal.message, refusal.code, close_code)
