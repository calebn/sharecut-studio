"""Security headers the relay puts on responses it proxies from a host to a guest.

The host chooses the body, so the relay is the only party that can bound what a shared page may
do. Report-Only is the default because the guest app has not been proven under enforcement;
``PODCAST_RELAY_CSP_ENFORCE`` flips the same policy to enforced.
"""

from __future__ import annotations

from podcast_mcp import settings

REPORT_ONLY = "Content-Security-Policy-Report-Only"
ENFORCED = "Content-Security-Policy"


def csp_enforced() -> bool:
    return settings.flag("PODCAST_RELAY_CSP_ENFORCE")


def guest_csp(origin: str) -> str:
    """The policy for a page served from *origin* (``scheme://host``); sockets use its ws twin."""
    socket_origin = origin.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return "; ".join(
        (
            "form-action 'none'",
            f"connect-src 'self' {socket_origin}",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        )
    )


def is_html(content_type: str | None) -> bool:
    return (content_type or "").split(";", 1)[0].strip().lower() == "text/html"


def proxied_security_headers(content_type: str | None, origin: str) -> dict[str, str]:
    headers = {"X-Content-Type-Options": "nosniff"}
    if is_html(content_type):
        headers[ENFORCED if csp_enforced() else REPORT_ONLY] = guest_csp(origin)
    return headers
