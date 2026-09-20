"""Load Google / GitHub OAuth client credentials (env preferred, then config files)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class OAuthClientConfig:
    provider: str
    client_id: str
    client_secret: str
    redirect_uri: str


def _config_dir() -> Path:
    override = os.environ.get("PODCAST_CONFIG_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "podcast_mcp"


def _default_redirect(provider: str) -> str:
    env_key = f"PODCAST_{provider.upper()}_OAUTH_REDIRECT_URI"
    explicit = os.environ.get(env_key, "").strip()
    if explicit:
        return explicit
    base = os.environ.get("PODCAST_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if base:
        return f"{base}/auth/callback/{provider}"
    # Local GUI default; production should set PODCAST_*_OAUTH_REDIRECT_URI.
    return f"http://127.0.0.1:8765/auth/callback/{provider}"


def _parse_google_json(data: dict[str, Any]) -> tuple[str, str]:
    web = data.get("web") if isinstance(data.get("web"), dict) else None
    if web:
        cid = str(web.get("client_id") or "")
        secret = str(web.get("client_secret") or "")
        if cid and secret:
            return cid, secret
    cid = str(data.get("client_id") or "")
    secret = str(data.get("client_secret") or "")
    if not cid or not secret:
        raise ValueError("google oauth JSON missing client_id/client_secret")
    return cid, secret


def load_google_oauth() -> OAuthClientConfig | None:
    cid = os.environ.get("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    secret = os.environ.get("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    if cid and secret:
        return OAuthClientConfig(
            provider="google",
            client_id=cid,
            client_secret=secret,
            redirect_uri=_default_redirect("google"),
        )
    path = Path(
        os.environ.get(
            "PODCAST_GOOGLE_OAUTH_CLIENT_FILE",
            str(_config_dir() / "google-oauth-client.json"),
        )
    ).expanduser()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        cid, secret = _parse_google_json(data)
    except ValueError:
        return None
    return OAuthClientConfig(
        provider="google",
        client_id=cid,
        client_secret=secret,
        redirect_uri=_default_redirect("google"),
    )


def load_github_oauth() -> OAuthClientConfig | None:
    cid = os.environ.get("PODCAST_GITHUB_OAUTH_CLIENT_ID", "").strip()
    secret = os.environ.get("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "").strip()
    if cid and secret:
        return OAuthClientConfig(
            provider="github",
            client_id=cid,
            client_secret=secret,
            redirect_uri=_default_redirect("github"),
        )
    path = Path(
        os.environ.get(
            "PODCAST_GITHUB_OAUTH_CLIENT_FILE",
            str(_config_dir() / "github-oauth.json"),
        )
    ).expanduser()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    cid = str(data.get("client_id") or "")
    secret = str(data.get("client_secret") or "")
    if not cid or not secret:
        return None
    return OAuthClientConfig(
        provider="github",
        client_id=cid,
        client_secret=secret,
        redirect_uri=_default_redirect("github"),
    )


def oauth_providers_available() -> dict[str, bool]:
    return {
        "google": load_google_oauth() is not None,
        "github": load_github_oauth() is not None,
    }
