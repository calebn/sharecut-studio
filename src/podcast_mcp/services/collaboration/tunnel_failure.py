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


class FailureKind(StrEnum):
    NETWORK = "network"
    TIMEOUT = "timeout"
    RELAY_CLOSED = "relay closed"
    RATE_LIMITED = "rate limited"
    AUTH = "auth"
    CONFIG = "config"
    ERROR = "error"


_FATAL_HINT: dict[FailureKind, str] = {
    FailureKind.AUTH: (
        "Check the host token (--host-token, PODCAST_RELAY_HOST_TOKEN or relay.yaml) "
        "and the host id, then run podcast tunnel again."
    ),
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

    @property
    def fatal(self) -> bool:
        return self.kind in _FATAL_HINT

    @property
    def hint(self) -> str:
        return _FATAL_HINT.get(self.kind, "")

    @property
    def reason(self) -> str:
        return f"{self.kind.value}: {self.detail}"


class TunnelError(RuntimeError):
    """A tunnel failure the client already classified (relay rejection, fatal stop)."""

    def __init__(self, failure: TunnelFailure) -> None:
        super().__init__(failure.reason)
        self.failure = failure


def relay_rejection(detail: str, *, retry_after_sec: float = 0.0) -> TunnelFailure:
    """Classify an ``error`` frame the relay sent in place of a hello acknowledgement."""
    lowered = detail.lower()
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
