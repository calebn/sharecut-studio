"""The one HTTP 429 shape for a denied limiter decision (host routes and the relay proxy).

Kept apart from ``rate_limit`` because that module is imported by services that run
without the ``gui`` / ``relay`` extras, and this one needs starlette.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from starlette.responses import JSONResponse

from podcast_mcp.util.rate_limit import RateLimitDecision, rate_limit_detail

RATE_LIMITED_STATUS = 429
_RATE_LIMITED_HEADERS = {"X-Sharecut-Error-Code": "rate_limited"}


def rate_limited_error(decision: RateLimitDecision) -> HTTPException:
    """``HTTPException`` for a host route: ``{"detail": {...}}`` plus ``Retry-After``."""
    return HTTPException(
        status_code=RATE_LIMITED_STATUS,
        detail=rate_limit_detail(decision),
        headers={"Retry-After": decision.retry_after_header, **_RATE_LIMITED_HEADERS},
    )


def rate_limited_response(
    decision: RateLimitDecision, body: dict[str, Any] | None = None
) -> JSONResponse:
    """Bare JSON response: ``rate_limit_detail`` as the body unless a protocol error replaces it."""
    return JSONResponse(
        rate_limit_detail(decision) if body is None else body,
        status_code=RATE_LIMITED_STATUS,
        headers={"Retry-After": decision.retry_after_header, **_RATE_LIMITED_HEADERS},
    )
