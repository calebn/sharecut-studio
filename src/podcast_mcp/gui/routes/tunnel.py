"""Host tunnel status: what ``podcast tunnel`` last reported, for the GUI's ``tunnel.status``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from podcast_mcp.config.runtime import relay_configured
from podcast_mcp.services.collaboration import read_tunnel_status

router = APIRouter()


@router.get("/api/tunnel/status")
def get_tunnel_status() -> dict[str, Any]:
    """Online, Connecting, Reconnecting, Offline, Off or Not set up, with the next retry time.

    Host only: the relay never proxies ``/api/tunnel``. The body carries no token.
    """
    return read_tunnel_status(relay_configured=relay_configured())
