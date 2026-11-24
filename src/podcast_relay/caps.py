"""Per-install caps the relay enforces once it has a signing key.

A tunnel authenticated by lease is an enrolled install (``Tier.LEASE``). A tunnel that still
presents the legacy host token on a relay that also signs leases is ``Tier.LEGACY``: one share,
a small monthly allowance per host token and a smaller shared one per address. The host id a
legacy host sends is its own choice, so nothing is keyed on it; the token and the address are what
it cannot change for free. A relay with no
signing key builds no ``RelayMeter`` at all, so a self-hosted relay is unmetered as before.

Bytes are counted in both directions as they cross the tunnel (guest request bodies and websocket
text going to the host, response chunks and websocket text coming back). A ``ByteBucket`` per
host connection and one for the whole relay pace the responses, so a farm of identities shares
the relay's ceiling instead of taking all of it.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum

from podcast_mcp import settings
from podcast_relay.usage import UsageLedger

MIN_BURST_BYTES = 256 * 1024


class Tier(StrEnum):
    LEASE = "lease"
    LEGACY = "legacy"


@dataclass(frozen=True)
class Allowance:
    max_shares: int
    monthly_bytes: int


@dataclass(frozen=True)
class CapsConfig:
    lease: Allowance
    legacy: Allowance
    legacy_ip_monthly_bytes: int
    legacy_max_tunnels: int
    legacy_enabled: bool
    session_bytes_per_sec: int
    global_bytes_per_sec: int
    idle_sec: float


def _count(name: str, default: int) -> int:
    return max(0, int(settings.number(name, default)))


def load_caps_config() -> CapsConfig:
    return CapsConfig(
        lease=Allowance(
            _count("PODCAST_RELAY_INSTALL_MAX_SHARES", 5),
            _count("PODCAST_RELAY_INSTALL_MONTHLY_BYTES", 20_000_000_000),
        ),
        legacy=Allowance(
            _count("PODCAST_RELAY_LEGACY_MAX_SHARES", 1),
            _count("PODCAST_RELAY_LEGACY_MONTHLY_BYTES", 2_000_000_000),
        ),
        legacy_ip_monthly_bytes=_count("PODCAST_RELAY_LEGACY_IP_MONTHLY_BYTES", 4_000_000_000),
        legacy_max_tunnels=_count("PODCAST_RELAY_LEGACY_MAX_TUNNELS", 4),
        legacy_enabled=settings.flag("PODCAST_RELAY_LEGACY_TIER", default=True),
        session_bytes_per_sec=_count("PODCAST_RELAY_SESSION_BYTES_PER_SEC", 4 * 1024 * 1024),
        global_bytes_per_sec=_count("PODCAST_RELAY_GLOBAL_BYTES_PER_SEC", 64 * 1024 * 1024),
        idle_sec=max(0.0, settings.number("PODCAST_RELAY_IDLE_SEC", 120)),
    )


class ByteBucket:
    """A token bucket that may go into debt: ``reserve`` returns how long the caller must wait."""

    def __init__(self, rate: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.rate = rate
        self.burst = max(rate, MIN_BURST_BYTES)
        self._clock = clock
        self._tokens = float(self.burst)
        self._at = clock()

    def reserve(self, nbytes: int) -> float:
        now = self._clock()
        self._tokens = min(float(self.burst), self._tokens + (now - self._at) * self.rate)
        self._at = now
        self._tokens -= nbytes
        return max(0.0, -self._tokens / self.rate)


@dataclass
class SessionMeter:
    """What one host connection may use: its monthly counters, its shares and its byte rate."""

    tier: Tier
    # Legacy tunnels that present the same host token share one group; empty for a lease.
    group: str
    max_shares: int
    max_tunnels: int
    budgets: tuple[tuple[str, int], ...]
    ledger: UsageLedger
    session_bucket: ByteBucket | None
    global_bucket: ByteBucket | None
    idle_sec: float
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    def exhausted(self) -> bool:
        return any(cap > 0 and self.ledger.used(key) >= cap for key, cap in self.budgets)

    def charge(self, nbytes: int) -> None:
        for key, _cap in self.budgets:
            self.ledger.add(key, nbytes)

    async def pace(self, nbytes: int) -> None:
        wait = max(
            (
                bucket.reserve(nbytes)
                for bucket in (self.session_bucket, self.global_bucket)
                if bucket
            ),
            default=0.0,
        )
        if wait > 0:
            await self.sleep(wait)


class RelayMeter:
    def __init__(self, config: CapsConfig, ledger: UsageLedger) -> None:
        self.config = config
        self.ledger = ledger
        self._global_bucket = (
            ByteBucket(config.global_bytes_per_sec) if config.global_bytes_per_sec else None
        )

    def session(
        self, *, install_id: str, host_token: str = "", client_ip: str = ""
    ) -> SessionMeter:
        cfg = self.config
        group = ""
        budgets: tuple[tuple[str, int], ...]
        if install_id:
            tier, allowance = Tier.LEASE, cfg.lease
            budgets = ((f"install:{install_id}", allowance.monthly_bytes),)
        else:
            tier, allowance = Tier.LEGACY, cfg.legacy
            group = f"legacy:{hashlib.sha256(host_token.encode()).hexdigest()[:16]}"
            budgets = (
                (group, allowance.monthly_bytes),
                (f"legacy-ip:{client_ip or 'unknown'}", cfg.legacy_ip_monthly_bytes),
            )
        rate = cfg.session_bytes_per_sec
        return SessionMeter(
            tier=tier,
            group=group,
            max_shares=allowance.max_shares,
            max_tunnels=0 if install_id else cfg.legacy_max_tunnels,
            budgets=budgets,
            ledger=self.ledger,
            session_bucket=ByteBucket(rate) if rate else None,
            global_bucket=self._global_bucket,
            idle_sec=cfg.idle_sec,
        )
