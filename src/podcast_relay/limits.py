"""Relay-side rate limits (coarse; protect tunnel droplet before proxy)."""

from __future__ import annotations

from podcast_mcp.util.rate_limit import (
    ConcurrencyGate,
    KeyedLimiter,
    RateLimitDecision,
    env_flag,
    env_float,
    env_int,
    rate_limit_detail,
)

# Generous defaults (plan).
_DEFAULT_TOKEN_RPM = 600.0
_DEFAULT_TOKEN_BURST = 80.0
_DEFAULT_IP_RPM = 1200.0
_DEFAULT_IP_BURST = 120.0
_DEFAULT_TOKEN_CONCURRENT = 24
_DEFAULT_HOST_CONCURRENT = 96
_DEFAULT_AUDIO_CONCURRENT = 8
_DEFAULT_WS_CONCURRENT = 8
_DEFAULT_WS_MSG_RPM = 120.0
_DEFAULT_WS_MSG_BURST = 30.0
_DEFAULT_WS_PRESENCE_RPM = 900.0
_DEFAULT_WS_PRESENCE_BURST = 60.0
_DEFAULT_REGISTER_RPM = 60.0
_DEFAULT_REGISTER_BURST = 20.0


def relay_rate_limit_enabled() -> bool:
    return env_flag("PODCAST_RELAY_RATE_LIMIT", default=True)


class RelayLimiters:
    def __init__(self) -> None:
        self.token_http = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RELAY_TOKEN_RPM", _DEFAULT_TOKEN_RPM),
            burst=env_float("PODCAST_RELAY_TOKEN_BURST", _DEFAULT_TOKEN_BURST),
            bucket_name="relay_token",
        )
        self.ip_http = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RELAY_IP_RPM", _DEFAULT_IP_RPM),
            burst=env_float("PODCAST_RELAY_IP_BURST", _DEFAULT_IP_BURST),
            bucket_name="relay_ip",
        )
        self.token_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_RELAY_TOKEN_CONCURRENT", _DEFAULT_TOKEN_CONCURRENT),
            bucket_name="relay_token_concurrent",
        )
        self.host_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_RELAY_HOST_CONCURRENT", _DEFAULT_HOST_CONCURRENT),
            bucket_name="relay_host_concurrent",
        )
        self.audio_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_RELAY_AUDIO_CONCURRENT", _DEFAULT_AUDIO_CONCURRENT),
            bucket_name="relay_audio_concurrent",
        )
        self.ws_concurrent = ConcurrencyGate(
            limit=env_int("PODCAST_RELAY_WS_CONCURRENT", _DEFAULT_WS_CONCURRENT),
            bucket_name="relay_ws_concurrent",
        )
        self.ws_msg = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RELAY_WS_MSG_RPM", _DEFAULT_WS_MSG_RPM),
            burst=env_float("PODCAST_RELAY_WS_MSG_BURST", _DEFAULT_WS_MSG_BURST),
            bucket_name="relay_ws_msg",
        )
        self.ws_presence = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RELAY_WS_PRESENCE_RPM", _DEFAULT_WS_PRESENCE_RPM),
            burst=env_float("PODCAST_RELAY_WS_PRESENCE_BURST", _DEFAULT_WS_PRESENCE_BURST),
            bucket_name="relay_ws_presence",
        )
        self.register = KeyedLimiter(
            rate_per_min=env_float("PODCAST_RELAY_REGISTER_RPM", _DEFAULT_REGISTER_RPM),
            burst=env_float("PODCAST_RELAY_REGISTER_BURST", _DEFAULT_REGISTER_BURST),
            bucket_name="relay_register",
        )

    def reset(self) -> None:
        self.token_http.reset()
        self.ip_http.reset()
        self.token_concurrent.reset()
        self.host_concurrent.reset()
        self.audio_concurrent.reset()
        self.ws_concurrent.reset()
        self.ws_msg.reset()
        self.ws_presence.reset()
        self.register.reset()


_LIMITERS: RelayLimiters | None = None


def get_relay_limiters() -> RelayLimiters:
    global _LIMITERS
    if _LIMITERS is None:
        _LIMITERS = RelayLimiters()
    return _LIMITERS


def reset_relay_limiters_for_tests() -> None:
    global _LIMITERS
    if _LIMITERS is not None:
        _LIMITERS.reset()
    _LIMITERS = None


def is_presence_ws_text(text: str) -> bool:
    """Coarse relay classifier; host limiter is authoritative."""
    return len(text) <= 2048 and text.lstrip().startswith('{"type":"Presence"')


def is_audio_path(path_suffix: str) -> bool:
    p = path_suffix.lower().split("?", 1)[0]
    return (
        p.endswith("/audio")
        or "/daw/audio" in p
        or "/daw/pending-preview" in p
        or "/daw/audition-context" in p
    )


def check_register(host_token: str) -> RateLimitDecision:
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_register")
    return get_relay_limiters().register.allow(host_token or "anonymous")


def check_proxy_rpm(
    *,
    token: str,
    client_ip: str | None,
    path_suffix: str,
) -> RateLimitDecision:
    """RPM checks only (no concurrency). Audio paths skip RPM."""
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_token")
    if is_audio_path(path_suffix):
        return RateLimitDecision(allowed=True, bucket="relay_audio")
    lim = get_relay_limiters()
    tok = lim.token_http.allow(token)
    if not tok.allowed:
        return tok
    ip_key = (client_ip or "").strip() or "unknown"
    return lim.ip_http.allow(ip_key)


__all__ = [
    "check_proxy_rpm",
    "check_register",
    "get_relay_limiters",
    "is_audio_path",
    "is_presence_ws_text",
    "rate_limit_detail",
    "relay_rate_limit_enabled",
    "reset_relay_limiters_for_tests",
]
