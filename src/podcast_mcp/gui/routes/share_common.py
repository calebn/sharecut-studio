"""Shared HTTP helpers for token-scoped share routes."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from podcast_mcp.edits.share_registry import SHARE_KIND_REVIEW
from podcast_mcp.services.remote_mcp.limits import (
    check_host_bucket,
    rate_limit_detail,
)
from podcast_mcp.services.session_sync.authz import authorize_share_token
from podcast_mcp.services.share import lookup_share


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
        raise HTTPException(status_code=404, detail="invalid or revoked share token") from exc
    decision = authorize_share_token(token=token, expected_token=row.get("token"))
    if not decision.allowed:
        raise HTTPException(status_code=403, detail=decision.reason)
    return row


def rate_limit_share(token: str, kind: str) -> None:
    decision = check_host_bucket(token, kind)
    if not decision.allowed:
        raise HTTPException(
            status_code=429,
            detail=rate_limit_detail(decision),
            headers={"Retry-After": decision.retry_after_header},
        )
