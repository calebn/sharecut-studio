"""Guest render opt-in (host CPU). Default off — editor shares must not burn FFmpeg silently."""

from __future__ import annotations

import os

_HINT = (
    "Guest render_preview is disabled. Set PODCAST_GUEST_RENDER=1 on the host "
    "to allow edit/mcp shares to rebuild stems/premix."
)


def guest_render_enabled() -> bool:
    raw = os.environ.get("PODCAST_GUEST_RENDER", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def require_guest_render() -> None:
    if not guest_render_enabled():
        raise PermissionError(_HINT)
