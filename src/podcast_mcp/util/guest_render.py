"""Guest render opt-in (host CPU). Default off — editor shares must not burn FFmpeg silently."""

from __future__ import annotations

from podcast_mcp import settings
from podcast_mcp.util.coded_error import CodedPermissionError

_HINT = (
    "Guest render_preview is disabled. Set PODCAST_GUEST_RENDER=1 on the host "
    "to allow edit/mcp shares to rebuild stems/premix."
)


def guest_render_enabled() -> bool:
    return settings.flag("PODCAST_GUEST_RENDER")


def require_guest_render() -> None:
    if not guest_render_enabled():
        raise CodedPermissionError(_HINT, code="share_capability_required")
