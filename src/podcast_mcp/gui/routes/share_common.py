"""Shared HTTP helpers for token-scoped share routes."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import Request

from podcast_mcp.gui.routes.guest_errors import guest_http_error
from podcast_mcp.services.collaboration import SHARE_KIND_REVIEW, lookup_share
from podcast_mcp.services.remote_mcp import (
    check_host_bucket,
    get_host_limiters,
    host_rate_limit_enabled,
)
from podcast_mcp.services.session_sync import authorize_share_token
from podcast_mcp.util.coded_error import AccessDeniedError, UnknownShareError
from podcast_mcp.util.rate_limit_http import rate_limited_error

log = logging.getLogger(__name__)


def share_features_manifest(request: Request) -> dict[str, Any]:
    """Share-scoped feature manifest (relay-safe; guests cannot hit /api/features)."""
    registry = getattr(request.app.state, "feature_registry", None)
    if registry is None:
        from podcast_mcp.extensions.loader import load_extensions

        registry = load_extensions()
    return registry.to_manifest()


def check_share_token(token: str, *, kind: str = SHARE_KIND_REVIEW) -> dict[str, Any]:
    try:
        row = lookup_share(token, kind=kind)
    except KeyError as exc:
        raise UnknownShareError("invalid or revoked share token", code="share_not_found") from exc
    except Exception as exc:
        raise guest_http_error(exc, logger=log, operation="share token lookup") from exc
    decision = authorize_share_token(token=token, expected_token=row.get("token"))
    if not decision.allowed:
        raise AccessDeniedError(decision.reason, code="share_token_mismatch")
    return row


def rate_limit_share(token: str, kind: str) -> None:
    decision = check_host_bucket(token, kind)
    if not decision.allowed:
        raise rate_limited_error(decision)


def audio_slot(token: str) -> Callable[[], None] | None:
    """Take an audio concurrency slot and return its release callback.

    Raises 429 when the share is at its audio concurrency cap.
    """
    if not host_rate_limit_enabled():
        return None
    lim = get_host_limiters()
    decision = lim.audio_concurrent.try_enter(token)
    if not decision.allowed:
        raise rate_limited_error(decision)
    return lambda: lim.audio_concurrent.exit(token)
