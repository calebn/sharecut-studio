"""Host-side share / remote-MCP rate limits (semantic read vs mutate)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.util.rate_limit import (
    ConcurrencyGate,
    GateSpec,
    KeyedLimiter,
    LimiterSet,
    RateLimitDecision,
    RateSpec,
    env_flag,
    is_review_audio_path,
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
        "guest_pipeline_run",
        "guest_pipeline_job_cancel",
        "guest_export_start",
        "guest_export_job_cancel",
        "guest_speaker_split",
        "guest_speaker_job_cancel",
        "guest_speaker_move_lane_span",
        "guest_transcript_vocabulary_put",
        "guest_transcript_refine_done",
        "guest_transcript_refine_waive",
        "guest_transcript_export",
    }
)


def host_rate_limit_enabled() -> bool:
    return env_flag("PODCAST_RATE_LIMIT", default=True)


class HostLimiters(LimiterSet):
    TABLE = (
        RateSpec("read", "host_read", "PODCAST_RATE_LIMIT_READ", 300.0, 60.0),
        RateSpec("mutate", "host_mutate", "PODCAST_RATE_LIMIT_MUTATE", 60.0, 20.0),
        GateSpec(
            "audio_concurrent", "host_audio_concurrent", "PODCAST_RATE_LIMIT_AUDIO_CONCURRENT", 8
        ),
        GateSpec(
            "guest_ws_concurrent", "host_guest_ws_concurrent", "PODCAST_GUEST_WS_CONCURRENT", 8
        ),
        RateSpec(
            "guest_ws_presence", "host_guest_ws_presence", "PODCAST_GUEST_WS_PRESENCE", 900.0, 60.0
        ),
        RateSpec(
            "guest_ws_presence_token",
            "host_guest_ws_presence_token",
            "PODCAST_GUEST_WS_PRESENCE_TOKEN",
            3600.0,
            200.0,
        ),
        RateSpec(
            "ws_roster_request", "host_ws_roster_request", "PODCAST_WS_ROSTER_REQUEST", 60.0, 1.0
        ),
        RateSpec("guest_ws_record", "guest_ws_record", "PODCAST_GUEST_WS_RECORD", 600.0, 10.0),
        RateSpec(
            "guest_ws_record_token",
            "guest_ws_record_token",
            "PODCAST_GUEST_WS_RECORD_TOKEN",
            3000.0,
            50.0,
        ),
        RateSpec(
            "guest_ws_record_signal",
            "guest_ws_record_signal",
            "PODCAST_GUEST_WS_RECORD_SIGNAL",
            1800.0,
            80.0,
        ),
        RateSpec(
            "guest_ws_record_signal_token",
            "guest_ws_record_signal_token",
            "PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN",
            6000.0,
            200.0,
        ),
    )

    read: KeyedLimiter
    mutate: KeyedLimiter
    audio_concurrent: ConcurrencyGate
    guest_ws_concurrent: ConcurrencyGate
    guest_ws_presence: KeyedLimiter
    guest_ws_presence_token: KeyedLimiter
    ws_roster_request: KeyedLimiter
    guest_ws_record: KeyedLimiter
    guest_ws_record_token: KeyedLimiter
    guest_ws_record_signal: KeyedLimiter
    guest_ws_record_signal_token: KeyedLimiter


_LIMITERS: HostLimiters | None = None


def get_host_limiters() -> HostLimiters:
    global _LIMITERS
    if _LIMITERS is None:
        _LIMITERS = HostLimiters()
    return _LIMITERS


def ws_roster_request_allowed(client_key: str) -> bool:
    """Throttle ``RosterRequest`` replies per client id (``host:{client_id}`` on
    ``/api/host/ws``, ``guest:{guest client id}`` on the guest ``/daw/ws``; both survive
    a reconnect): one per second by default. A full roster is the one amplifying reply a
    client can ask for. Off with ``PODCAST_RATE_LIMIT=0``, like every host limiter."""
    if not host_rate_limit_enabled():
        return True
    return get_host_limiters().ws_roster_request.allow(client_key).allowed


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
    if method == "POST":
        return "mutate"
    if is_review_audio_path(path):
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
    "reset_host_limiters_for_tests",
]
