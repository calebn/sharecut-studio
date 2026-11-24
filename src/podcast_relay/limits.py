"""Relay-side rate limits (coarse; protect tunnel droplet before proxy)."""

from __future__ import annotations

import ipaddress

from podcast_mcp.util.rate_limit import (
    ConcurrencyGate,
    GateSpec,
    KeyedLimiter,
    LimiterSet,
    RateLimitDecision,
    RateSpec,
    env_flag,
    is_review_audio_path,
)


def relay_rate_limit_enabled() -> bool:
    return env_flag("PODCAST_RELAY_RATE_LIMIT", default=True)


class RelayLimiters(LimiterSet):
    TABLE = (
        RateSpec("token_http", "relay_token", "PODCAST_RELAY_TOKEN", 600.0, 80.0),
        RateSpec("ip_http", "relay_ip", "PODCAST_RELAY_IP", 1200.0, 120.0),
        GateSpec(
            "token_concurrent", "relay_token_concurrent", "PODCAST_RELAY_TOKEN_CONCURRENT", 24
        ),
        GateSpec("host_concurrent", "relay_host_concurrent", "PODCAST_RELAY_HOST_CONCURRENT", 96),
        GateSpec("audio_concurrent", "relay_audio_concurrent", "PODCAST_RELAY_AUDIO_CONCURRENT", 8),
        GateSpec("ws_concurrent", "relay_ws_concurrent", "PODCAST_RELAY_WS_CONCURRENT", 8),
        RateSpec("ws_msg", "relay_ws_msg", "PODCAST_RELAY_WS_MSG", 120.0, 30.0),
        RateSpec("ws_presence", "relay_ws_presence", "PODCAST_RELAY_WS_PRESENCE", 900.0, 60.0),
        RateSpec("register", "relay_register", "PODCAST_RELAY_REGISTER", 60.0, 20.0),
        # 5 per subnet per day: refill is 5/1440 per minute, so a burst of 5 then one every ~5 h.
        RateSpec(
            "enroll_subnet", "relay_enroll_subnet", "PODCAST_RELAY_ENROLL_SUBNET", 0.0035, 5.0
        ),
        RateSpec("enroll_global", "relay_enroll_global", "PODCAST_RELAY_ENROLL_GLOBAL", 10.0, 60.0),
        RateSpec("renew", "relay_renew", "PODCAST_RELAY_RENEW", 6.0, 6.0),
    )

    token_http: KeyedLimiter
    ip_http: KeyedLimiter
    token_concurrent: ConcurrencyGate
    host_concurrent: ConcurrencyGate
    audio_concurrent: ConcurrencyGate
    ws_concurrent: ConcurrencyGate
    ws_msg: KeyedLimiter
    ws_presence: KeyedLimiter
    register: KeyedLimiter
    enroll_subnet: KeyedLimiter
    enroll_global: KeyedLimiter
    renew: KeyedLimiter


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
    """Coarse relay classifier; host limiter is authoritative.

    ``RosterRequest`` (a guest's out-of-band resync request on a roster-version gap)
    shares the presence bucket: like ``Presence``, it is frequent, small and per-connection
    throttled server-side (the host ``ws_roster_request`` limiter, ``remote_mcp/limits.py``),
    not a durable command.
    """
    stripped = text.lstrip()
    return len(text) <= 2048 and (
        stripped.startswith('{"type":"Presence"') or stripped.startswith('{"type":"RosterRequest"')
    )


def check_register(host_token: str) -> RateLimitDecision:
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_register")
    return get_relay_limiters().register.allow(host_token or "anonymous")


def client_subnet(client_ip: str | None) -> str:
    """The enrollment bucket for an address: its /24 (IPv4) or /48 (IPv6); unparsable shares one."""
    try:
        address = ipaddress.ip_address((client_ip or "").strip())
    except ValueError:
        return "unknown"
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    prefix = 24 if address.version == 4 else 48
    return str(ipaddress.ip_network(f"{address}/{prefix}", strict=False))


def check_enroll(client_ip: str | None) -> RateLimitDecision:
    """Global rate first, then the client's subnet, so a refused global never spends a subnet slot."""
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_enroll_subnet")
    lim = get_relay_limiters()
    overall = lim.enroll_global.allow("all")
    if not overall.allowed:
        return overall
    return lim.enroll_subnet.allow(client_subnet(client_ip))


def check_renew(install_id: str) -> RateLimitDecision:
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_renew")
    return get_relay_limiters().renew.allow(install_id)


def check_proxy_rpm(
    *,
    token: str,
    client_ip: str | None,
    path_suffix: str,
) -> RateLimitDecision:
    """RPM checks only (no concurrency). Audio paths skip RPM."""
    if not relay_rate_limit_enabled():
        return RateLimitDecision(allowed=True, bucket="relay_token")
    if is_review_audio_path(path_suffix):
        return RateLimitDecision(allowed=True, bucket="relay_audio")
    lim = get_relay_limiters()
    tok = lim.token_http.allow(token)
    if not tok.allowed:
        return tok
    ip_key = (client_ip or "").strip() or "unknown"
    return lim.ip_http.allow(ip_key)


__all__ = [
    "check_enroll",
    "check_proxy_rpm",
    "check_register",
    "check_renew",
    "client_subnet",
    "get_relay_limiters",
    "is_presence_ws_text",
    "relay_rate_limit_enabled",
    "reset_relay_limiters_for_tests",
]
