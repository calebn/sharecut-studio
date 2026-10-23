from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from fastapi import HTTPException

from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.services.document_sync import DocumentConflictError
from podcast_mcp.services.media import StaleWaveformKeyError, WaveformBusyError
from podcast_mcp.util.coded_error import GuardRefusal, HostSetupError, coded_cause
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE
from podcast_mcp.util.tool_refusal import ToolRefusal, tool_refusal
from podcast_mcp.util.write_failure import ProjectWriteFailedError


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
        return coded_http_error(500, "internal error", code="internal_error")
    code = refusal.code
    if code == PROJECT_BUSY_CODE:
        return coded_http_error(503, refusal.message, code=code)
    cause = coded_cause(exc)
    if isinstance(cause, DocumentConflictError):
        return coded_http_error(409, {"detail": refusal.message, "conflict": True}, code=code)
    if isinstance(cause, WaveformBusyError):
        return coded_http_error(
            503, refusal.message, code=code, headers={"Retry-After": cause.retry_after}
        )
    if isinstance(cause, (StaleWaveformKeyError, ModelMissing)) or refusal.code == "job_running":
        status = 409
    elif isinstance(cause, HostSetupError):
        status = 500
    elif isinstance(cause, ProjectWriteFailedError):
        status = cause.status
    elif isinstance(cause, PermissionError):
        status = 403
    elif isinstance(cause, (KeyError, LookupError, FileNotFoundError)):
        status = 404
    else:
        status = 400
    return coded_http_error(status, refusal.message, code=code)


@contextmanager
def guest_boundary(logger: logging.Logger, operation: str) -> Iterator[None]:
    """Run a guest route's service call; anything it raises leaves as ``guest_http_error``."""
    try:
        yield
    except (HTTPException, GuardRefusal):
        raise
    except Exception as exc:
        raise guest_http_error(exc, logger=logger, operation=operation) from exc


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
