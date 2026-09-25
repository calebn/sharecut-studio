"""Host-side share / remote-MCP rate limits (semantic read vs mutate)."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from podcast_mcp.util.rate_limit import (
    ConcurrencyGate,
    KeyedLimiter,
    RateLimitDecision,
    env_flag,
    env_float,
    env_int,
    rate_limit_detail,
)

_MUTATE_TOOLS: frozenset[str] = frozenset(
    {
        "guest_add_comment",
        "guest_add_reply",
        "guest_set_action_done",
        "guest_submit_document_command",
        "guest_render_preview",
        "guest_pending_preview",
        "guest_audition_context",
        "guest_upload_media",
    }
)

_DEFAULT_READ_RPM = 300.0
_DEFAULT_READ_BURST = 60.0
_DEFAULT_MUTATE_RPM = 60.0
_DEFAULT_MUTATE_BURST = 20.0
_DEFAULT_AUDIO_CONCURRENT = 8
_DEFAULT_GUEST_WS_CONCURRENT = 8
_DEFAULT_GUEST_WS_PRESENCE_RPM = 900.0
_DEFAULT_GUEST_WS_PRESENCE_BURST = 60.0
_DEFAULT_GUEST_WS_PRESENCE_TOKEN_RPM = 3600.0
_DEFAULT_GUEST_WS_PRESENCE_TOKEN_BURST = 200.0
_DEFAULT_GUEST_WS_RECORD_RPM = 600.0
_DEFAULT_GUEST_WS_RECORD_BURST = 10.0
_DEFAULT_GUEST_WS_RECORD_TOKEN_RPM = 3000.0
_DEFAULT_GUEST_WS_RECORD_TOKEN_BURST = 50.0
_DEFAULT_GUEST_WS_RECORD_SIGNAL_RPM = 1800.0
_DEFAULT_GUEST_WS_RECORD_SIGNAL_BURST = 80.0
_DEFAULT_GUEST_WS_RECORD_SIGNAL_TOKEN_RPM = 6000.0
_DEFAULT_GUEST_WS_RECORD_SIGNAL_TOKEN_BURST = 200.0


def host_rate_limit_enabled() -> bool:
    return env_flag("PODCAST_RATE_LIMIT", default=True)


class HostLimiters:
    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        limiter_clock = clock or time.monotonic
        self.read = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RATE_LIMIT_READ_RPM", _DEFAULT_READ_RPM),
            burst=env_float("PODCAST_RATE_LIMIT_READ_BURST", _DEFAULT_READ_BURST),
            bucket_name="host_read",
            clock=limiter_clock,
        )
        self.mutate = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RATE_LIMIT_MUTATE_RPM", _DEFAULT_MUTATE_RPM),
            burst=env_float("PODCAST_RATE_LIMIT_MUTATE_BURST", _DEFAULT_MUTATE_BURST),
            bucket_name="host_mutate",
            clock=limiter_clock,
        )
        self.audio_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_RATE_LIMIT_AUDIO_CONCURRENT", _DEFAULT_AUDIO_CONCURRENT),
            bucket_name="host_audio_concurrent",
        )
        self.guest_ws_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_GUEST_WS_CONCURRENT", _DEFAULT_GUEST_WS_CONCURRENT),
            bucket_name="host_guest_ws_concurrent",
        )
        self.guest_ws_presence = KeyedLimiter(
            rate_per_min=env_float("PODCAST_GUEST_WS_PRESENCE_RPM", _DEFAULT_GUEST_WS_PRESENCE_RPM),
            burst=env_float("PODCAST_GUEST_WS_PRESENCE_BURST", _DEFAULT_GUEST_WS_PRESENCE_BURST),
            bucket_name="host_guest_ws_presence",
        )
        self.guest_ws_presence_token = KeyedLimiter(
            rate_per_min=env_float(
                "PODCAST_GUEST_WS_PRESENCE_TOKEN_RPM",
                _DEFAULT_GUEST_WS_PRESENCE_TOKEN_RPM,
            ),
            burst=env_float(
                "PODCAST_GUEST_WS_PRESENCE_TOKEN_BURST",
                _DEFAULT_GUEST_WS_PRESENCE_TOKEN_BURST,
            ),
            bucket_name="host_guest_ws_presence_token",
        )
        self.guest_ws_record = KeyedLimiter(
            rate_per_min=env_float("PODCAST_GUEST_WS_RECORD_RPM", _DEFAULT_GUEST_WS_RECORD_RPM),
            burst=env_float("PODCAST_GUEST_WS_RECORD_BURST", _DEFAULT_GUEST_WS_RECORD_BURST),
            bucket_name="guest_ws_record",
        )
        self.guest_ws_record_token = KeyedLimiter(
            rate_per_min=env_float(
                "PODCAST_GUEST_WS_RECORD_TOKEN_RPM",
                _DEFAULT_GUEST_WS_RECORD_TOKEN_RPM,
            ),
            burst=env_float(
                "PODCAST_GUEST_WS_RECORD_TOKEN_BURST",
                _DEFAULT_GUEST_WS_RECORD_TOKEN_BURST,
            ),
            bucket_name="guest_ws_record_token",
        )
        self.guest_ws_record_signal = KeyedLimiter(
            rate_per_min=env_float(
                "PODCAST_GUEST_WS_RECORD_SIGNAL_RPM",
                _DEFAULT_GUEST_WS_RECORD_SIGNAL_RPM,
            ),
            burst=env_float(
                "PODCAST_GUEST_WS_RECORD_SIGNAL_BURST",
                _DEFAULT_GUEST_WS_RECORD_SIGNAL_BURST,
            ),
            bucket_name="guest_ws_record_signal",
        )
        self.guest_ws_record_signal_token = KeyedLimiter(
            rate_per_min=env_float(
                "PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_RPM",
                _DEFAULT_GUEST_WS_RECORD_SIGNAL_TOKEN_RPM,
            ),
            burst=env_float(
                "PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_BURST",
                _DEFAULT_GUEST_WS_RECORD_SIGNAL_TOKEN_BURST,
            ),
            bucket_name="guest_ws_record_signal_token",
        )

    def reset(self) -> None:
        self.read.reset()
        self.mutate.reset()
        self.audio_concurrent.reset()
        self.guest_ws_concurrent.reset()
        self.guest_ws_presence.reset()
        self.guest_ws_presence_token.reset()
        self.guest_ws_record.reset()
        self.guest_ws_record_token.reset()
        self.guest_ws_record_signal.reset()
        self.guest_ws_record_signal_token.reset()


_LIMITERS: HostLimiters | None = None


def get_host_limiters() -> HostLimiters:
    global _LIMITERS
    if _LIMITERS is None:
        _LIMITERS = HostLimiters()
    return _LIMITERS


def reset_host_limiters_for_tests(*, clock: Callable[[], float] | None = None) -> None:
    global _LIMITERS
    if _LIMITERS is not None:
        _LIMITERS.reset()
    _LIMITERS = HostLimiters(clock=clock) if clock is not None else None


def classify_mcp_rpc(method: str | None, tool_name: str | None = None) -> str:
    """Return ``read`` or ``mutate`` for a JSON-RPC MCP request."""
    m = (method or "").strip()
    if m in {"initialize", "ping", "tools/list"}:
        return "read"
    if m == "tools/call":
        name = (tool_name or "").strip()
        if name in _MUTATE_TOOLS:
            return "mutate"
        return "read"
    return "read"


def classify_review_request(http_method: str, path: str) -> str:
    """Return ``read``, ``mutate``, or ``audio`` for a review-share route."""
    method = http_method.upper()
    p = path
    if method == "POST":
        return "mutate"
    if (
        "/audio" in p
        or "/pending-preview" in p
        or "/audition-context" in p
        or "/daw/waveform/tiles/" in p
    ):
        return "audio"
    return "read"


def check_host_bucket(token: str, kind: str) -> RateLimitDecision:
    if not host_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket=f"host_{kind}")
    lim = get_host_limiters()
    if kind == "mutate":
        return lim.mutate.allow(token)
    if kind == "audio":
        return RateLimitDecision(allowed=True, bucket="host_audio")
    return lim.read.allow(token)


def mcp_rate_limit_error(req_id: Any, decision: RateLimitDecision) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {
            "code": -32029,
            "message": (
                f"rate limit exceeded ({decision.bucket}); "
                f"retry after {decision.retry_after_header}s"
            ),
            "data": rate_limit_detail(decision),
        },
    }


__all__ = [
    "check_host_bucket",
    "classify_mcp_rpc",
    "classify_review_request",
    "get_host_limiters",
    "host_rate_limit_enabled",
    "mcp_rate_limit_error",
    "rate_limit_detail",
    "reset_host_limiters_for_tests",
]
