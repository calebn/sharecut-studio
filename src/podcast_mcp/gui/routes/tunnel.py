"""Host tunnel status: what ``podcast tunnel`` last reported, for the GUI's ``tunnel.status``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.gui.routes.deps import require_host
from podcast_mcp.runtime_config import relay_configured
from podcast_mcp.services.collaboration import read_tunnel_status

router = APIRouter()


@router.get("/api/tunnel/status")
def get_tunnel_status(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Online, Connecting, Reconnecting, Offline, Off or Not set up, with the next retry time.

    Host only: the relay never proxies ``/api/tunnel``. The body carries no token.
    """
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    return read_tunnel_status(relay_configured=relay_configured())
