"""Structured logging when a relayed guest WebSocket stream closes (#1350)."""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def redact_share_token(token: str) -> str:
    t = (token or "").strip()
    if len(t) < 10:
        return "***"
    return f"{t[:4]}…{t[-4:]}"


def log_guest_ws_close(
    component: str,
    site: str,
    *,
    share_token: str = "",
    stream_id: str = "",
    code: int,
    reason: str,
) -> None:
    log.info(
        "%s guest ws close site=%s token=%s stream=%s code=%s reason=%s",
        component,
        site,
        redact_share_token(share_token),
        stream_id[:12] if stream_id else "-",
        code,
        reason,
    )
