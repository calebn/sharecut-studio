"""OAuth authorization-code + PKCE helpers for Google and GitHub."""

from __future__ import annotations

import base64
import hashlib
import secrets
from typing import Any
from urllib.parse import urlencode

from podcast_mcp.services.share_auth.oauth_credentials import (
    OAuthClientConfig,
    load_github_oauth,
    load_google_oauth,
)

_GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_CODE_EXCHANGE_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
_GITHUB_AUTH = "https://github.com/login/oauth/authorize"
_GITHUB_CODE_EXCHANGE_URL = "https://github.com/login/oauth/access_token"
_GITHUB_USER = "https://api.github.com/user"
_GITHUB_EMAILS = "https://api.github.com/user/emails"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for S256."""
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def authorization_url(
    provider: str, *, state: str, code_challenge: str
) -> tuple[str, OAuthClientConfig]:
    if provider == "google":
        cfg = load_google_oauth()
        if cfg is None:
            raise RuntimeError("Google OAuth is not configured")
        params = {
            "client_id": cfg.client_id,
            "redirect_uri": cfg.redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "access_type": "online",
            "prompt": "select_account",
        }
        return f"{_GOOGLE_AUTH}?{urlencode(params)}", cfg
    if provider == "github":
        cfg = load_github_oauth()
        if cfg is None:
            raise RuntimeError("GitHub OAuth is not configured")
        params = {
            "client_id": cfg.client_id,
            "redirect_uri": cfg.redirect_uri,
            "scope": "read:user user:email",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{_GITHUB_AUTH}?{urlencode(params)}", cfg
    raise ValueError(f"unsupported provider {provider!r}")


def exchange_code(
    provider: str,
    *,
    code: str,
    code_verifier: str,
    http_post=None,
    http_get=None,
) -> dict[str, Any]:
    """Exchange auth code → profile ``{sub, email, email_verified, display_name}``.

    ``http_post`` / ``http_get`` are injectable for tests (``(url, **kwargs) -> dict``).
    """
    post = http_post or _default_post
    get = http_get or _default_get

    if provider == "google":
        cfg = load_google_oauth()
        if cfg is None:
            raise RuntimeError("Google OAuth is not configured")
        token = post(
            _GOOGLE_CODE_EXCHANGE_URL,
            data={
                "code": code,
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "redirect_uri": cfg.redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": code_verifier,
            },
        )
        access = token.get("access_token")
        if not access:
            raise RuntimeError("Google token exchange failed")
        info = get(_GOOGLE_USERINFO, headers={"Authorization": f"Bearer {access}"})
        return {
            "sub": str(info.get("sub") or ""),
            "email": str(info.get("email") or ""),
            "email_verified": bool(info.get("email_verified", True)),
            "display_name": str(info.get("name") or info.get("email") or ""),
        }

    if provider == "github":
        cfg = load_github_oauth()
        if cfg is None:
            raise RuntimeError("GitHub OAuth is not configured")
        token = post(
            _GITHUB_CODE_EXCHANGE_URL,
            data={
                "code": code,
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "redirect_uri": cfg.redirect_uri,
                "code_verifier": code_verifier,
            },
            headers={"Accept": "application/json"},
        )
        access = token.get("access_token")
        if not access:
            raise RuntimeError("GitHub token exchange failed")
        headers = {
            "Authorization": f"Bearer {access}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "podcast-mcp",
        }
        user = get(_GITHUB_USER, headers=headers)
        email = str(user.get("email") or "")
        verified = False
        if not email:
            emails = get(_GITHUB_EMAILS, headers=headers)
            if isinstance(emails, list):
                primary = next(
                    (e for e in emails if e.get("primary") and e.get("verified")),
                    None,
                )
                pick = primary or next(
                    (e for e in emails if e.get("verified")),
                    emails[0] if emails else None,
                )
                if pick:
                    email = str(pick.get("email") or "")
                    verified = bool(pick.get("verified"))
        else:
            verified = True
        return {
            "sub": str(user.get("id") or ""),
            "email": email,
            "email_verified": verified,
            "display_name": str(user.get("name") or user.get("login") or email),
        }

    raise ValueError(f"unsupported provider {provider!r}")


def _default_post(url: str, **kwargs: Any) -> dict[str, Any]:  # pragma: no cover
    import httpx

    with httpx.Client(timeout=30.0) as client:
        r = client.post(url, **kwargs)
        r.raise_for_status()
        return r.json()


def _default_get(url: str, **kwargs: Any) -> Any:  # pragma: no cover
    import httpx

    with httpx.Client(timeout=30.0) as client:
        r = client.get(url, **kwargs)
        r.raise_for_status()
        return r.json()
