"""Shared FastAPI helpers for GUI route authz and project path resolution."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Request

from podcast_mcp.services.session_sync.authz import authorize_client, is_loopback_host


def peer_host(request: Request) -> str | None:
    if request.client:
        return request.client.host
    return None


def require_authz(
    *,
    client_id: str | None,
    role: str,
    peer_host: str | None,
    token: str | None,
) -> None:
    decision = authorize_client(
        client_id=client_id or "anonymous",
        role=role or "viewer",
        peer_host=peer_host,
        token=token,
    )
    if not decision.allowed:
        raise HTTPException(status_code=403, detail=decision.reason)


def resolve_project(path: str, request: Request | None = None) -> Path:
    """Resolve *path* and optionally pin to ``app.state.served_project``.

    *request* may be a FastAPI ``Request`` or Starlette ``WebSocket`` (both expose
    ``.app``). When the GUI was started with ``--project``, other paths are 403.
    """
    project_path = Path(path).expanduser().resolve()
    if not project_path.is_file():
        raise HTTPException(status_code=404, detail=f"Project not found: {project_path}")
    if request is not None:
        served = getattr(request.app.state, "served_project", None)
        if served is not None and project_path != Path(served).resolve():
            raise HTTPException(
                status_code=403,
                detail="project path not allowed for this server instance",
            )
    return project_path


def is_bind_loopback(host: str) -> bool:
    return is_loopback_host(host.strip().lower())


def ensure_non_loopback_session_auth(host: str) -> str | None:
    """Enable strict authz when binding off-loopback; return session token for URL."""
    if is_bind_loopback(host):
        return None
    if not os.environ.get("PODCAST_SESSION_AUTHZ", "").strip():
        os.environ["PODCAST_SESSION_AUTHZ"] = "strict"
    token = os.environ.get("PODCAST_SESSION_TOKEN", "").strip()
    if not token:
        token = secrets.token_urlsafe(32)
        os.environ["PODCAST_SESSION_TOKEN"] = token
    return token
