"""Liveness and agent-discovery routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from podcast_relay.state import RelayState
from podcast_relay.version import read_relay_git_sha, read_relay_version


def build_status_router(state: RelayState) -> APIRouter:
    router = APIRouter()

    @router.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "version": read_relay_version(),
            "git_sha": read_relay_git_sha(),
            "tunnels": len(state.tunnels),
            "shares": len(state.token_to_host),
        }

    @router.get("/llms.txt")
    def llms_txt() -> PlainTextResponse:
        """Machine-readable summary for agentic browsing (domain root)."""
        body = (
            "# Podcast MCP review shares\n\n"
            "This origin hosts opaque review links for Podcast MCP.\n\n"
            "## Shares\n\n"
            "- Guest review URLs look like `/r/{token}` "
            "(token capability set: play/view/comment/…).\n"
            "- Guest recording URLs look like `/rec/{token}` "
            "(studio lobby; not a review mix).\n"
            "- Do not invent filesystem paths; guests never receive host paths.\n"
            "- When the project host tunnel is offline, shares return 503.\n\n"
            "## Docs\n\n"
            "- https://docs.sharecut.studio/\n"
            "- https://docs.sharecut.studio/#/quickstart\n"
            "- https://docs.sharecut.studio/schemas/document-commands.schema.json\n"
            "- https://docs.sharecut.studio/llms.txt\n"
            "- https://github.com/calebn/sharecut-studio\n"
        )
        return PlainTextResponse(body, media_type="text/plain; charset=utf-8")

    return router
