"""Authorize principals for Restricted / require_sign_in shares."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request

from podcast_mcp.services.share_auth.access import access_required
from podcast_mcp.services.share_auth.store import ShareIdentityStore, get_identity_store

SESSION_COOKIE = "podcast_share_session"


@dataclass(frozen=True)
class SharePrincipal:
    user: dict[str, Any]
    source: str  # session | agent
    acl_role: str | None = None


def extract_bearer_from_headers(headers: Mapping[str, str]) -> str | None:
    auth = headers.get("authorization") or headers.get("Authorization")
    if not auth:
        return None
    parts = auth.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def extract_bearer(request: Request) -> str | None:
    return extract_bearer_from_headers(request.headers)


def resolve_principal_from_headers(
    headers: Mapping[str, str],
    cookies: Mapping[str, str],
    *,
    share_token: str,
    store: ShareIdentityStore | None = None,
) -> SharePrincipal | None:
    """Resolve session cookie or agent Bearer from raw headers/cookies."""
    ident = store or get_identity_store()
    agent_raw = extract_bearer_from_headers(headers)
    if agent_raw and agent_raw.startswith("pmcp_agent_"):
        cred = ident.resolve_agent_credential(agent_raw)
        if cred and cred["share_token"] == share_token:
            acl = ident.acl_allows(share_token, cred["user"]["id"])
            return SharePrincipal(
                user=cred["user"],
                source="agent",
                acl_role=acl["role"] if acl else None,
            )
        return None

    session_raw = agent_raw
    if not session_raw:
        session_raw = cookies.get(SESSION_COOKIE)
    if not session_raw:
        return None
    user = ident.resolve_session(session_raw)
    if not user:
        return None
    acl = ident.acl_allows(share_token, user["id"])
    return SharePrincipal(
        user=user,
        source="session",
        acl_role=acl["role"] if acl else None,
    )


def resolve_principal(
    request: Request,
    *,
    share_token: str,
    store: ShareIdentityStore | None = None,
) -> SharePrincipal | None:
    """Resolve session cookie or agent Bearer; None if anonymous."""
    return resolve_principal_from_headers(
        request.headers,
        request.cookies,
        share_token=share_token,
        store=store,
    )


def require_share_access(
    request: Request,
    share_row: dict[str, Any],
    *,
    store: ShareIdentityStore | None = None,
) -> SharePrincipal | None:
    """Enforce ACL when the share requires sign-in; allow anonymous otherwise.

    Returns the principal when authenticated; ``None`` for anonymous link access.
    Raises HTTP 401/403 when identity is required but missing or not on the ACL.
    """
    if not access_required(share_row):
        return resolve_principal(
            request, share_token=str(share_row.get("token") or ""), store=store
        )

    token = str(share_row.get("token") or "")
    principal = resolve_principal(request, share_token=token, store=store)
    if principal is None:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "authentication_required",
                "message": "This share requires sign-in",
                "login_path": "/auth/login",
            },
        )
    if principal.acl_role is None:
        raise HTTPException(
            status_code=403,
            detail="authenticated user is not on this share ACL",
        )
    return principal
