"""Guest auth routes: Google/GitHub OIDC, magic link, password, passkeys."""

from __future__ import annotations

import logging
import os
import secrets
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from podcast_mcp.services.share_auth.oauth_credentials import oauth_providers_available
from podcast_mcp.services.share_auth.oauth_flow import (
    authorization_url,
    exchange_code,
    make_pkce_pair,
)
from podcast_mcp.services.share_auth.passkeys import (
    begin_authentication,
    begin_registration,
    finish_authentication,
    finish_registration,
)
from podcast_mcp.services.share_auth.policy import SESSION_COOKIE
from podcast_mcp.services.share_auth.store import get_identity_store

log = logging.getLogger(__name__)
router = APIRouter(tags=["auth"])

_OAUTH_STATE_COOKIE = "podcast_oauth_state"
_OAUTH_VERIFIER_COOKIE = "podcast_oauth_verifier"
_OAUTH_PROVIDER_COOKIE = "podcast_oauth_provider"
_OAUTH_NEXT_COOKIE = "podcast_oauth_next"


class PasswordLoginRequest(BaseModel):
    email: str
    password: str


class PasswordRegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str | None = None


class MagicLinkRequest(BaseModel):
    email: str
    share_token: str | None = None
    next: str | None = None


class PasskeyRegisterFinish(BaseModel):
    credential_id: str
    public_key_b64: str
    challenge: str
    attestation_object: str | None = None
    client_data_json: str | None = None


class PasskeyAuthBegin(BaseModel):
    email: str | None = None


class PasskeyAuthFinish(BaseModel):
    credential_id: str
    challenge: str
    authenticator_data: str | None = None
    client_data_json: str | None = None
    signature: str | None = None
    sign_count: int = 0


class AgentCredentialRequest(BaseModel):
    share_token: str
    ttl_hours: int | None = Field(default=24 * 30, ge=1)


def _secure_cookie() -> bool:
    return os.environ.get("PODCAST_AUTH_COOKIE_SECURE", "").strip() in {
        "1",
        "true",
        "yes",
    }


def _set_session_cookie(response: Response, raw: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        raw,
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(),
        max_age=60 * 60 * 24 * 14,
        path="/",
    )


def _set_oauth_flow_cookie(response: Response, name: str, value: str) -> None:
    response.set_cookie(
        name,
        value,
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(),
        max_age=600,
        path="/",
    )


def _clear_oauth_cookies(response: Response) -> None:
    for name in (
        _OAUTH_STATE_COOKIE,
        _OAUTH_VERIFIER_COOKIE,
        _OAUTH_PROVIDER_COOKIE,
        _OAUTH_NEXT_COOKIE,
    ):
        response.delete_cookie(name, path="/")


@router.get("/auth/providers")
def auth_providers() -> dict[str, Any]:
    return {
        "providers": oauth_providers_available(),
        "password": True,
        "magic_link": True,
        "passkeys": True,
        "note": (
            "Apple Sign In is a later follow-on. MCP SDK OAuth is not used as the document ACL."
        ),
    }


@router.get("/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    store = get_identity_store()
    raw = request.cookies.get(SESSION_COOKIE)
    user = store.resolve_session(raw)
    if not user:
        bearer = request.headers.get("authorization") or ""
        if bearer.lower().startswith("bearer "):
            user = store.resolve_session(bearer.split(None, 1)[1].strip())
    if not user:
        raise HTTPException(status_code=401, detail="not signed in")
    return {"user": user}


@router.post("/auth/logout")
def auth_logout(request: Request, response: Response) -> dict[str, Any]:
    store = get_identity_store()
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        store.revoke_session(raw)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/login/{provider}")
def auth_login_start(provider: str, next: str | None = None) -> RedirectResponse:
    if provider not in {"google", "github"}:
        raise HTTPException(status_code=404, detail="unknown provider")
    state = secrets.token_urlsafe(24)
    verifier, challenge = make_pkce_pair()
    try:
        url, _cfg = authorization_url(provider, state=state, code_challenge=challenge)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    response = RedirectResponse(url, status_code=302)
    _set_oauth_flow_cookie(response, _OAUTH_STATE_COOKIE, state)
    _set_oauth_flow_cookie(response, _OAUTH_VERIFIER_COOKIE, verifier)
    _set_oauth_flow_cookie(response, _OAUTH_PROVIDER_COOKIE, provider)
    if next:
        _set_oauth_flow_cookie(response, _OAUTH_NEXT_COOKIE, next)
    return response


@router.get("/auth/callback/{provider}")
def auth_callback(
    provider: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> Response:
    if error:
        raise HTTPException(status_code=400, detail=error)
    if not code or not state:
        raise HTTPException(status_code=400, detail="missing code or state")
    if provider not in {"google", "github"}:
        raise HTTPException(status_code=404, detail="unknown provider")
    expect_state = request.cookies.get(_OAUTH_STATE_COOKIE)
    verifier = request.cookies.get(_OAUTH_VERIFIER_COOKIE)
    cookie_provider = request.cookies.get(_OAUTH_PROVIDER_COOKIE)
    nxt = request.cookies.get(_OAUTH_NEXT_COOKIE) or "/"
    if not expect_state or not verifier or state != expect_state or cookie_provider != provider:
        raise HTTPException(status_code=400, detail="invalid oauth state")
    try:
        profile = exchange_code(provider, code=code, code_verifier=verifier)
    except Exception as exc:
        log.warning("oauth exchange failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=400, detail="oauth exchange failed") from exc
    if not profile.get("sub") or not profile.get("email"):
        raise HTTPException(status_code=400, detail="provider did not return email")
    store = get_identity_store()
    user = store.upsert_user_from_oidc(
        provider=provider,
        subject=str(profile["sub"]),
        email=str(profile["email"]),
        email_verified=bool(profile.get("email_verified", True)),
        display_name=str(profile.get("display_name") or "") or None,
    )
    session = store.create_session(user["id"])
    response = RedirectResponse(nxt, status_code=302)
    _set_session_cookie(response, session)
    _clear_oauth_cookies(response)
    return response


@router.post("/auth/password/register")
def auth_password_register(body: PasswordRegisterRequest, response: Response) -> dict[str, Any]:
    store = get_identity_store()
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
    user = store.create_or_get_email_user(
        body.email,
        password=body.password,
        display_name=body.display_name,
    )
    # If the email already had a different password, create_or_get updates it -
    # acceptable for host-local identity store.
    session = store.create_session(user["id"])
    _set_session_cookie(response, session)
    return {"user": store.get_user(user["id"]), "session": session}


@router.post("/auth/password/login")
def auth_password_login(body: PasswordLoginRequest, response: Response) -> dict[str, Any]:
    store = get_identity_store()
    user = store.verify_email_password(body.email, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="invalid email or password")
    session = store.create_session(user["id"])
    _set_session_cookie(response, session)
    return {"user": user, "session": session}


@router.post("/auth/magic-link")
def auth_magic_link(body: MagicLinkRequest, request: Request) -> dict[str, Any]:
    store = get_identity_store()
    raw = store.create_magic_link(body.email, share_token=body.share_token)
    origin = str(request.base_url).rstrip("/")
    q = urlencode({"token": raw, "next": body.next or "/"})
    link = f"{origin}/auth/magic-link/consume?{q}"
    # No SMTP yet - print/log for host operators and tests.
    if os.environ.get("PODCAST_MAGIC_LINK_PRINT", "1") == "1":
        log.info("magic link for %s: %s", body.email, link)
        print(f"PODCAST_MAGIC_LINK {body.email} {link}", flush=True)
    return {
        "ok": True,
        "email": body.email.strip().lower(),
        "dev_link": link if os.environ.get("PODCAST_MAGIC_LINK_PRINT", "1") == "1" else None,
    }


@router.get("/auth/magic-link/consume")
def auth_magic_consume(token: str, response: Response, next: str = "/") -> RedirectResponse:
    store = get_identity_store()
    result = store.consume_magic_link(token)
    if not result or not result.get("user"):
        raise HTTPException(status_code=400, detail="invalid or expired magic link")
    session = store.create_session(result["user"]["id"])
    dest = next or "/"
    if result.get("share_token"):
        dest = f"/r/{result['share_token']}"
    redirect = RedirectResponse(dest, status_code=302)
    _set_session_cookie(redirect, session)
    return redirect


@router.post("/auth/passkey/register/begin")
def passkey_register_begin(request: Request) -> dict[str, Any]:
    store = get_identity_store()
    raw = request.cookies.get(SESSION_COOKIE)
    user = store.resolve_session(raw)
    if not user:
        raise HTTPException(status_code=401, detail="sign in before registering a passkey")
    return begin_registration(store, user)


@router.post("/auth/passkey/register/finish")
def passkey_register_finish(body: PasskeyRegisterFinish, request: Request) -> dict[str, Any]:
    store = get_identity_store()
    user = store.resolve_session(request.cookies.get(SESSION_COOKIE))
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    try:
        return finish_registration(
            store,
            user,
            credential_id=body.credential_id,
            public_key_b64=body.public_key_b64,
            challenge=body.challenge,
            attestation_object=body.attestation_object,
            client_data_json=body.client_data_json,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/auth/passkey/login/begin")
def passkey_login_begin(body: PasskeyAuthBegin) -> dict[str, Any]:
    return begin_authentication(get_identity_store(), email=body.email)


@router.post("/auth/passkey/login/finish")
def passkey_login_finish(body: PasskeyAuthFinish, response: Response) -> dict[str, Any]:
    store = get_identity_store()
    try:
        user = finish_authentication(
            store,
            credential_id=body.credential_id,
            challenge=body.challenge,
            authenticator_data=body.authenticator_data,
            client_data_json=body.client_data_json,
            signature=body.signature,
            sign_count=body.sign_count,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    session = store.create_session(user["id"])
    _set_session_cookie(response, session)
    return {"user": user, "session": session}


@router.post("/auth/agent-credential")
def mint_agent_credential(body: AgentCredentialRequest, request: Request) -> dict[str, Any]:
    """Mint a user-bound agent token for Restricted share MCP (same role/ACL)."""
    store = get_identity_store()
    user = store.resolve_session(request.cookies.get(SESSION_COOKIE))
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    acl = store.acl_allows(body.share_token, user["id"])
    if acl is None:
        raise HTTPException(status_code=403, detail="not on share ACL")
    raw = store.mint_agent_credential(body.share_token, user["id"], ttl_hours=body.ttl_hours)
    return {
        "token": raw,
        "share_token": body.share_token,
        "role": acl["role"],
        "authorization": f"Bearer {raw}",
        "note": (
            "Use this Bearer on /mcp/{share_token}/mcp for Restricted shares; "
            "coolname alone is insufficient."
        ),
    }


@router.get("/auth/login")
def auth_login_page() -> JSONResponse:
    """Machine-readable login options (SPA can render buttons)."""
    return JSONResponse(
        {
            "providers": oauth_providers_available(),
            "paths": {
                "google": "/auth/login/google",
                "github": "/auth/login/github",
                "password": "/auth/password/login",
                "magic_link": "/auth/magic-link",
                "passkey": "/auth/passkey/login/begin",
            },
        }
    )
