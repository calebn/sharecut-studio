"""Authorization hooks for session / document / share surfaces.

Localhost / same-machine clients are always allowed. Remote peers require an
explicit grant when ``PODCAST_SESSION_AUTHZ=strict`` (or a future shared host).
Share tokens are validated separately via ``authorize_share_token``.

Owner GUI routes use the host role (``authorize_host``), which never admits
relay-tunneled share traffic (marked by the ``x-sharecut-relayed`` header),
even from a loopback peer or in non-strict mode.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from typing import Literal

ClientRole = Literal["agent", "viewer", "cli", "guest"]

_KNOWN_ROLES = frozenset({"agent", "viewer", "cli", "guest"})

HOST_ROLE_RELAYED_REASON = "host role required: relayed share traffic cannot reach owner routes"


@dataclass(frozen=True)
class AuthzDecision:
    allowed: bool
    reason: str = ""
    scope: str | None = None  # e.g. share token id / project key


def _strict() -> bool:
    return os.environ.get("PODCAST_SESSION_AUTHZ", "").lower() in (
        "1",
        "true",
        "strict",
    )


def is_loopback_host(peer_host: str | None) -> bool:
    host = (peer_host or "").strip().lower()
    return host in ("127.0.0.1", "::1", "localhost", "")


def _tokens_match(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    try:
        return secrets.compare_digest(left, right)
    except (TypeError, ValueError):
        return False


def authorize_host(
    *,
    client_id: str = "host",
    peer_host: str | None = None,
    token: str | None = None,
    relayed: bool = False,
) -> AuthzDecision:
    """Host role: gate for owner GUI routes that read or mutate owner project state.

    Relay-tunneled requests (share guests) are always denied, even from loopback
    and in non-strict mode. Otherwise non-strict allows all; strict requires a
    loopback peer or ``PODCAST_SESSION_TOKEN`` (share tokens never match).
    """
    if not client_id:
        return AuthzDecision(False, "client_id required")
    if relayed:
        return AuthzDecision(False, HOST_ROLE_RELAYED_REASON)
    if not _strict():
        return AuthzDecision(True)
    if is_loopback_host(peer_host):
        return AuthzDecision(True, "loopback")
    expected = os.environ.get("PODCAST_SESSION_TOKEN", "")
    if _tokens_match(token, expected):
        return AuthzDecision(True, "token")
    return AuthzDecision(False, "remote client requires PODCAST_SESSION_TOKEN")


def authorize_client(
    *,
    client_id: str,
    role: ClientRole | str,
    peer_host: str | None = None,
    token: str | None = None,
    display_name: str | None = None,
    allow_guest: bool = False,
    relayed: bool = False,
) -> AuthzDecision:
    """Decide whether a client may join session/document sync for a project.

    Default (non-strict): allow all - matches Phase 1-2 localhost DAW + agent.
    Strict: require loopback peer or a non-empty session token. Relayed (tunnel)
    requests are denied; this only guards owner session/document surfaces;
    guest share routes use ``authorize_share_token``.
    """
    del display_name  # reserved for future ACL / display roster
    if not client_id:
        return AuthzDecision(False, "client_id required")
    if role not in _KNOWN_ROLES:
        return AuthzDecision(False, f"unknown role: {role}")
    if role == "guest" and not allow_guest:
        return AuthzDecision(False, "guest role not allowed on this surface")
    return authorize_host(client_id=client_id, peer_host=peer_host, token=token, relayed=relayed)


def authorize_share_token(
    *,
    token: str | None,
    expected_token: str | None,
    peer_host: str | None = None,
) -> AuthzDecision:
    """Capability check for public review share routes (opaque token = access)."""
    del peer_host
    if not token or not expected_token:
        return AuthzDecision(False, "share token required")
    if not _tokens_match(token, expected_token):
        return AuthzDecision(False, "invalid share token")
    return AuthzDecision(True, "share", scope=token)
