"""HMAC share claims binding coolname tokens to a host tunnel credential.

Beyond refuse-remap while a tunnel is live: claims prove the advertising host
holds the tunnel secret, and ``token → host_id`` bindings persist across
disconnect so another host cannot steal an offline share.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any


def canonical_claim_message(host_id: str, token: str, capabilities: list[str]) -> bytes:
    caps = ",".join(sorted(str(c) for c in capabilities))
    return f"v1\n{host_id}\n{token}\n{caps}".encode()


def sign_share_claim(
    secret: str,
    *,
    host_id: str,
    token: str,
    capabilities: list[str],
) -> str:
    """Return hex HMAC-SHA256 of the canonical claim message."""
    return hmac.new(
        secret.encode("utf-8"),
        canonical_claim_message(host_id, token, capabilities),
        hashlib.sha256,
    ).hexdigest()


def verify_share_claim(
    secret: str,
    *,
    host_id: str,
    token: str,
    capabilities: list[str],
    claim: str,
) -> bool:
    if not secret or not claim:
        return False
    expected = sign_share_claim(
        secret,
        host_id=host_id,
        token=token,
        capabilities=capabilities,
    )
    # compare_digest raises ValueError on length mismatch; treat as reject.
    if len(expected) != len(claim):
        return False
    return secrets.compare_digest(expected, claim)


def parse_host_token_map(raw: str) -> tuple[set[str], dict[str, str]]:
    """Parse ``PODCAST_RELAY_HOST_TOKENS``.

    Entries may be bare secrets (shared allowlist) or ``host_id:secret``
    (per-host binding). Returns ``(shared_secrets, host_id → secret)``.
    """
    shared: set[str] = set()
    by_host: dict[str, str] = {}
    for part in raw.split(","):
        entry = part.strip()
        if not entry:
            continue
        if ":" in entry:
            host_id, _, secret = entry.partition(":")
            host_id = host_id.strip()
            secret = secret.strip()
            if host_id and secret:
                by_host[host_id] = secret
                continue
        shared.add(entry)
    return shared, by_host


def resolve_tunnel_secret(
    presented: str,
    *,
    shared_secrets: set[str],
    host_secrets: dict[str, str],
    host_id: str,
) -> str | None:
    """Return the secret to use for claims if *presented* authenticates this host."""
    if not presented:
        return None
    bound = host_secrets.get(host_id)
    if bound is not None:
        if secrets.compare_digest(presented, bound):
            return bound
        return None
    for secret in shared_secrets:
        if len(presented) == len(secret) and secrets.compare_digest(presented, secret):
            return secret
    # Also allow matching a host-bound secret by value when host_id was not in map
    # (legacy CSV secret used as host_token with arbitrary host_id).
    for secret in host_secrets.values():
        if len(presented) == len(secret) and secrets.compare_digest(presented, secret):
            return secret
    return None


def attach_share_claims(
    shares: list[dict[str, Any]],
    *,
    host_id: str,
    secret: str,
) -> list[dict[str, Any]]:
    """Return share rows with ``claim`` and ``host_id`` fields for the relay."""
    out: list[dict[str, Any]] = []
    for row in shares:
        if not isinstance(row, dict):
            continue
        token = str(row.get("token") or "")
        if not token:
            continue
        caps = [str(c) for c in (row.get("capabilities") or [])]
        claim = sign_share_claim(secret, host_id=host_id, token=token, capabilities=caps)
        out.append(
            {**row, "token": token, "capabilities": caps, "host_id": host_id, "claim": claim}
        )
    return out
