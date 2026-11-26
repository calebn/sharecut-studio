"""Why a tunnel connection ended: one classified failure per exception.

``classify_failure`` is the single place that turns a websocket, socket or relay
error into a ``TunnelFailure``. ``fatal`` kinds (auth, config) cannot be fixed by
retrying, so ``TunnelClient.run`` stops and the CLI exits with the hint.
"""

from __future__ import annotations

import errno
import socket
from dataclasses import dataclass
from enum import StrEnum

from podcast_mcp.util.relay_protocol.lease import LEASE_EXPIRED_CLOSE_REASON


class FailureKind(StrEnum):
    NETWORK = "network"
    TIMEOUT = "timeout"
    RELAY_CLOSED = "relay closed"
    RATE_LIMITED = "rate limited"
    AUTH = "auth"
    UNAVAILABLE = "unavailable"
    CONFIG = "config"
    ERROR = "error"


RELAY_OLDER = "relay_older"
UNAVAILABLE_FIX = "If you think this is a mistake, contact support."
UNAVAILABLE_DETAIL = "online sharing is unavailable right now"

_FATAL_HINT: dict[FailureKind, str] = {
    FailureKind.AUTH: (
        "Check the host token (--host-token, PODCAST_RELAY_HOST_TOKEN or relay.yaml) "
        "and the host id, then run podcast tunnel again."
    ),
    FailureKind.UNAVAILABLE: UNAVAILABLE_FIX,
    FailureKind.CONFIG: "Check relay_url (it must end in /tunnel), then run podcast tunnel again.",
}

_NETWORK_ERRNO_DETAIL: dict[int, str] = {
    errno.ECONNREFUSED: "relay refused the connection",
    errno.ENETUNREACH: "network unreachable",
    errno.ENETDOWN: "network is down",
    errno.EHOSTUNREACH: "relay host unreachable",
    errno.ECONNRESET: "connection reset",
    errno.ECONNABORTED: "connection aborted",
    errno.EPIPE: "connection lost",
}

_CLOSE_AUTH = 4403
_CLOSE_BAD_REQUEST = 4400
_CLOSE_RATE_LIMITED = 4429
_CLOSE_INTERNAL = 1011


@dataclass(frozen=True)
class TunnelFailure:
    kind: FailureKind
    detail: str
    retry_after_sec: float = 0.0
    # Plain-words next step that replaces the host-token hint (an enrolled host has no token).
    fix: str = ""
    # The relay no longer honors the stored lease, but a fresh enrollment can replace it.
    stale_lease: bool = False
    # Additive machine-readable cause for the GUI, which matches on it rather than on ``detail``.
    reason_code: str | None = None

    @property
    def fatal(self) -> bool:
        return self.kind in _FATAL_HINT

    @property
    def hint(self) -> str:
        return self.fix or _FATAL_HINT.get(self.kind, "")

    @property
    def reason(self) -> str:
        return f"{self.kind.value}: {self.detail}"


class TunnelError(RuntimeError):
    """A tunnel failure the client already classified (relay rejection, fatal stop)."""

    def __init__(self, failure: TunnelFailure) -> None:
        super().__init__(failure.reason)
        self.failure = failure


_STALE_LEASE_CODES = frozenset(
    {"expired", "wrong_epoch", "unknown_kid", "bad_signature", "malformed", "wrong_install"}
)
UPDATE_FIX = "Update ShareCut, then start online sharing again."
SWITCHED_OFF_FIX = "Ask whoever runs the sharing service, or use a different one."
SWITCHED_OFF_DETAIL = "online sharing is turned off for this copy of ShareCut"
LEGACY_ENDED_DETAIL = "online sharing no longer accepts this access key"
LEGACY_ENDED_FIX = (
    "Remove the access key from your settings so ShareCut can sign in on its own, "
    "then start online sharing again."
)


def unavailable() -> TunnelFailure:
    """The install was revoked: no retry helps, and the host is pointed at support."""
    return TunnelFailure(FailureKind.UNAVAILABLE, UNAVAILABLE_DETAIL)


def _lease_rejection(code: str) -> TunnelFailure:
    if code in _STALE_LEASE_CODES:
        return TunnelFailure(
            FailureKind.RELAY_CLOSED,
            "online sharing is signing this computer in again",
            stale_lease=True,
        )
    if code == "build_too_old":
        return TunnelFailure(
            FailureKind.AUTH,
            "this version of ShareCut is too old for online sharing",
            fix=UPDATE_FIX,
        )
    if code == "denied":
        return unavailable()
    return TunnelFailure(FailureKind.AUTH, SWITCHED_OFF_DETAIL, fix=SWITCHED_OFF_FIX)


def relay_rejection(detail: str, *, retry_after_sec: float = 0.0) -> TunnelFailure:
    """Classify an ``error`` frame the relay sent in place of a hello acknowledgement."""
    lowered = detail.lower()
    if lowered.startswith("lease_refused:"):
        return _lease_rejection(lowered.partition(":")[2])
    if lowered == "legacy_tier_ended":
        return TunnelFailure(FailureKind.AUTH, LEGACY_ENDED_DETAIL, fix=LEGACY_ENDED_FIX)
    if "host_token" in lowered:
        return TunnelFailure(FailureKind.AUTH, "relay rejected the host token or host id")
    if "rate limit" in lowered:
        return TunnelFailure(
            FailureKind.RATE_LIMITED,
            "relay is rate limiting tunnel registration",
            retry_after_sec=retry_after_sec,
        )
    if "expected hello" in lowered:
        return TunnelFailure(FailureKind.CONFIG, "relay did not understand the tunnel handshake")
    return TunnelFailure(FailureKind.ERROR, f"relay refused the handshake ({detail[:80]})")


def _from_close_frame(code: int | None, reason: str) -> TunnelFailure:
    if code == _CLOSE_AUTH and reason == "install denied":
        return _lease_rejection("denied")
    if code == _CLOSE_AUTH and reason == LEASE_EXPIRED_CLOSE_REASON:
        return _lease_rejection("expired")
    if code == _CLOSE_AUTH:
        return TunnelFailure(FailureKind.AUTH, "relay rejected the host token or host id")
    if code == _CLOSE_BAD_REQUEST:
        return TunnelFailure(FailureKind.CONFIG, "relay did not understand the tunnel handshake")
    if code == _CLOSE_RATE_LIMITED:
        return TunnelFailure(FailureKind.RATE_LIMITED, "relay is rate limiting this host")
    if code == _CLOSE_INTERNAL and "ping timeout" in reason:
        return TunnelFailure(FailureKind.TIMEOUT, "relay stopped answering keepalive pings")
    if code is None:
        return TunnelFailure(FailureKind.NETWORK, "connection lost")
    suffix = f", {reason}" if reason else ""
    return TunnelFailure(FailureKind.RELAY_CLOSED, f"close code {code}{suffix}")


def _from_os_error(exc: OSError) -> TunnelFailure:
    if isinstance(exc, socket.gaierror):
        return TunnelFailure(FailureKind.NETWORK, "cannot resolve the relay host")
    detail = _NETWORK_ERRNO_DETAIL.get(exc.errno or 0) or str(exc) or "connection lost"
    return TunnelFailure(FailureKind.NETWORK, detail)


def classify_failure(exc: BaseException) -> TunnelFailure:
    """Map any connect or session error to a ``TunnelFailure``."""
    import httpx
    from websockets.exceptions import (
        ConnectionClosed,
        InvalidHandshake,
        InvalidStatus,
        InvalidURI,
    )

    if isinstance(exc, TunnelError):
        return exc.failure
    if isinstance(exc, ConnectionClosed):
        frame = exc.rcvd or exc.sent
        return _from_close_frame(
            frame.code if frame else None,
            (frame.reason if frame else "") or "",
        )
    if isinstance(exc, httpx.TimeoutException):
        return TunnelFailure(FailureKind.TIMEOUT, "relay did not answer in time")
    if isinstance(exc, httpx.TransportError):
        return TunnelFailure(FailureKind.NETWORK, "connection lost")
    if isinstance(exc, InvalidURI):
        return TunnelFailure(FailureKind.CONFIG, "relay_url is not a valid websocket URL")
    if isinstance(exc, InvalidStatus):
        status = exc.response.status_code
        if status in (401, 403):
            return TunnelFailure(FailureKind.AUTH, f"relay refused the connection (HTTP {status})")
        if status == 404:
            return TunnelFailure(FailureKind.CONFIG, "relay has no tunnel endpoint at relay_url")
        return TunnelFailure(FailureKind.RELAY_CLOSED, f"relay unavailable (HTTP {status})")
    if isinstance(exc, InvalidHandshake):
        return TunnelFailure(FailureKind.RELAY_CLOSED, "websocket handshake failed")
    if isinstance(exc, TimeoutError):
        return TunnelFailure(FailureKind.TIMEOUT, "relay did not answer in time")
    if isinstance(exc, OSError):
        return _from_os_error(exc)
    return TunnelFailure(FailureKind.ERROR, f"{type(exc).__name__}: {exc}"[:200])
