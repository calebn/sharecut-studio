"""Host tunnel status: what ``podcast tunnel`` last reported, for the GUI's ``tunnel.status``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from podcast_mcp.config.distribution import runtime_distribution_metadata
from podcast_mcp.config.runtime import relay_configured
from podcast_mcp.services.collaboration import read_tunnel_status

router = APIRouter()


@router.get("/api/tunnel/status")
def get_tunnel_status() -> dict[str, Any]:
    """Online, Limited, Connecting, Reconnecting, Offline, Off or Not set up, with the next retry time.

    Host only: the relay never proxies ``/api/tunnel``. The body carries no token. ``support_url``
    is where a host whose online sharing is unavailable can report it (the Help dialog's link).
    """
    return {
        **read_tunnel_status(relay_configured=relay_configured()),
        "support_url": runtime_distribution_metadata().support_url,
    }
