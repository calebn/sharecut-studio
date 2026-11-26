"""Host-side enrollment: get a lease from the relay, keep it fresh, remember it between launches.

A host with no ``host_token`` asks the relay for a lease on first use (``POST /api/relay/enroll``
with a hashcash proof). The relay assigns the install id, and the host stores it beside the
lease. The host renews the lease at half its life by presenting the old one. The install id,
lease and per-install claim key are stored in one private file under the state root. Every failure is
raised as a ``TunnelError`` carrying a classified ``TunnelFailure`` with plain-words copy, so the
tunnel's reconnect loop treats it like any other failed try.
"""

from __future__ import annotations

import asyncio
import logging
import random
import secrets
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from podcast_mcp import __version__
from podcast_mcp.config.runtime import (
    RelayConfig,
    default_relay_config_path,
    note_relay_does_not_enroll,
)
from podcast_mcp.services.collaboration.tunnel_failure import (
    UPDATE_FIX,
    FailureKind,
    TunnelError,
    TunnelFailure,
    classify_failure,
    unavailable,
)
from podcast_mcp.util import host_platform
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.relay_protocol.enroll import (
    ENROLL_PATH,
    MAX_POW_BITS,
    RENEW_PATH,
    EnrollGrant,
    solve_pow,
)
from podcast_mcp.util.relay_protocol.lease import LeaseError, LeaseRefusal, peek_lease

log = logging.getLogger(__name__)

LEASE_FILENAME = "relay_lease.json"
REQUEST_TIMEOUT_SEC = 20.0
# Never sleep longer than this between renewal checks, so a laptop that slept through a renew
# time notices within the hour.
MAX_RENEW_WAIT_SEC = 3600.0
MAX_BACKOFF_SEC = 60.0
# A lease this close to expiry is renewed now rather than trusted for one more connect.
EXPIRY_MARGIN_SEC = 60.0


@dataclass(frozen=True, slots=True)
class Credentials:
    install_id: str
    lease: str = field(repr=False)
    claim_key: str = field(repr=False)
    exp: int
    renew_at: int
    # Relay time minus this computer's clock when the lease was issued, so a skewed clock still
    # reads exp and renew_at correctly at the next launch.
    clock_offset: float = 0.0


def http_origin(relay_url: str) -> str:
    """``https://host[:port]`` for a ``wss://host[:port]/tunnel`` URL (``ws`` maps to ``http``)."""
    parsed = urlparse(relay_url)
    scheme = "https" if parsed.scheme == "wss" else "http"
    return f"{scheme}://{parsed.netloc}"


def default_lease_path() -> Path:
    """Next to ``relay.yaml``, like the host id file, so one config root holds both."""
    return default_relay_config_path().with_name(LEASE_FILENAME)


class LeaseStore:
    """One private JSON file holding the install id, lease and claim key a relay assigned.

    The OS keychain would be the stronger home, but this repo has no keychain helper and no
    keyring dependency; the file sits beside ``relay.yaml`` with mode 0600. A lease is revocable
    and capped, so a copied file is worth one install.
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or default_lease_path()

    def load(self, *, origin: str) -> Credentials | None:
        try:
            data = load_json_object(self._path)
        except ValueError:
            return None
        if data is None or data.get("origin") != origin:
            return None
        try:
            return Credentials(
                install_id=str(data["install_id"]),
                lease=str(data["lease"]),
                claim_key=str(data["claim_key"]),
                exp=int(data["exp"]),
                renew_at=int(data["renew_at"]),
                clock_offset=float(data.get("clock_offset", 0.0)),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def save(self, *, origin: str, credentials: Credentials) -> None:
        write_json_atomic(
            self._path,
            {
                "origin": origin,
                "install_id": credentials.install_id,
                "lease": credentials.lease,
                "claim_key": credentials.claim_key,
                "exp": credentials.exp,
                "renew_at": credentials.renew_at,
                "clock_offset": credentials.clock_offset,
            },
        )

    def clear(self) -> None:
        self._path.unlink(missing_ok=True)


def _failure(
    kind: FailureKind, detail: str, *, retry_after_sec: float = 0.0, fix: str = ""
) -> TunnelError:
    return TunnelError(TunnelFailure(kind, detail, retry_after_sec=retry_after_sec, fix=fix))


def _refusal(status: int, body: Mapping[str, Any], retry_after: str | None) -> TunnelError:
    """The classified failure for a non-200 reply from ``/api/relay/enroll``."""
    code = str(body.get("detail") or "")
    if status == 404:
        return _failure(
            FailureKind.CONFIG,
            "online sharing is not available at this address",
            fix="Check the sharing address in your settings, or add the access key you were given.",
        )
    if status == 403:
        return TunnelError(unavailable())
    if status == 426:
        return _failure(
            FailureKind.AUTH,
            "this version of ShareCut is too old for online sharing",
            fix=UPDATE_FIX,
        )
    if status == 429:
        try:
            wait = float(retry_after or body.get("retry_after_sec") or 0.0)
        except ValueError:
            wait = 0.0
        return _failure(
            FailureKind.RATE_LIMITED,
            "too many sign-ups from this network, trying again later",
            retry_after_sec=wait,
        )
    if status >= 500 or code == "proof_invalid":
        return _failure(FailureKind.RELAY_CLOSED, f"online sharing is unavailable (HTTP {status})")
    return _failure(FailureKind.ERROR, f"online sharing sign-up was refused (HTTP {status})")


def _json_object(response: Any) -> Mapping[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _grant(body: Mapping[str, Any]) -> EnrollGrant:
    try:
        return EnrollGrant(
            install_id=str(body["install_id"]),
            lease=str(body["lease"]),
            claim_key=str(body["claim_key"]),
            exp=int(body["exp"]),
            renew_at=int(body["renew_at"]),
            server_time=int(body["now"]),
        )
    except (KeyError, TypeError, ValueError):
        raise _failure(
            FailureKind.ERROR, "online sharing sent an unreadable sign-up reply"
        ) from None


class Enrollment:
    """Returns usable ``Credentials`` for one host, enrolling or renewing as needed."""

    def __init__(
        self,
        cfg: RelayConfig,
        *,
        store: LeaseStore | None = None,
        clock: Callable[[], float] = time.time,
        build: str = __version__,
        platform_name: str | None = None,
    ) -> None:
        self._relay_url = cfg.relay_url
        self._origin = http_origin(cfg.relay_url)
        self._store = store or LeaseStore()
        self._clock = clock
        self._build = build
        self._platform = platform_name or host_platform.current().name
        self._lock = asyncio.Lock()
        self._stale = False
        self._offset: float | None = None

    def mark_stale(self) -> None:
        """The relay refused the stored lease: renew or re-enroll next, never reuse it as is."""
        self._stale = True

    async def credentials(self, *, strict: bool = False) -> Credentials:
        """Usable credentials; a lease that still works is returned when its renewal fails.

        ``strict`` raises that failure instead, so the renewal loop can back off.
        """
        async with self._lock:
            stored = self._store.load(origin=self._origin)
            if self._offset is None and stored is not None:
                self._offset = stored.clock_offset
            now = self._relay_now()
            fresh = now < stored.renew_at and self._build_matches(stored) if stored else False
            if stored is not None and fresh and not self._stale:
                return stored
            if stored is not None and now < stored.exp - EXPIRY_MARGIN_SEC:
                try:
                    return self._remember(await self._renew(stored))
                except TunnelError as exc:
                    if exc.failure.fatal and not exc.failure.stale_lease:
                        raise
                    if not exc.failure.stale_lease:
                        if strict:
                            raise
                        return stored
            return self._remember(await self._enroll(stored))

    def _relay_now(self) -> float:
        """This computer's clock moved onto the relay's, as last seen; the relay judges expiry."""
        return self._clock() + (self._offset or 0.0)

    def _build_matches(self, stored: Credentials) -> bool:
        """A lease records the build that enrolled it; an update renews so min_build sees the new one."""
        try:
            return peek_lease(stored.lease).build == self._build
        except LeaseError:
            return False

    async def keep_fresh(
        self,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        """Renew at half life for as long as the tunnel runs.

        A failed renewal retries after 1 s, doubling to 60 s, never sooner than the relay's
        Retry-After, and spread by up to a quarter so hosts that failed together do not return together.
        """
        delay = 1.0
        while True:
            try:
                credentials = await self.credentials(strict=True)
                delay = 1.0
                wait = min(MAX_RENEW_WAIT_SEC, max(1.0, credentials.renew_at - self._relay_now()))
            except (TunnelError, OSError, ValueError) as exc:
                log.warning("Online sharing could not renew its sign-in: %s", type(exc).__name__)
                told = exc.failure.retry_after_sec if isinstance(exc, TunnelError) else 0.0
                wait = max(delay, told) * (1.0 + 0.25 * jitter())
                delay = min(MAX_BACKOFF_SEC, delay * 2.0)
            await sleep(wait)

    def _remember(self, grant: EnrollGrant) -> Credentials:
        self._stale = False
        self._offset = grant.server_time - self._clock()
        credentials = Credentials(
            grant.install_id,
            grant.lease,
            grant.claim_key,
            grant.exp,
            grant.renew_at,
            self._offset,
        )
        try:
            self._store.save(origin=self._origin, credentials=credentials)
        except OSError:
            log.warning("Could not save the online sharing sign-in; it will be redone next launch")
        return credentials

    async def _post(self, client: Any, path: str, payload: dict[str, Any]) -> Mapping[str, Any]:
        response = await client.post(self._origin + path, json=payload)
        body = _json_object(response)
        if response.status_code != 200:
            raise _refusal(response.status_code, body, response.headers.get("retry-after"))
        return body

    async def _renew(self, stored: Credentials) -> EnrollGrant:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SEC) as client:
                response = await client.post(
                    self._origin + RENEW_PATH, json={"lease": stored.lease, "build": self._build}
                )
        except httpx.HTTPError as exc:
            raise TunnelError(classify_failure(exc)) from exc
        body = _json_object(response)
        if response.status_code == 401:
            if body.get("detail") == f"lease_refused:{LeaseRefusal.DENIED.value}":
                raise TunnelError(unavailable())
            raise TunnelError(TunnelFailure(FailureKind.AUTH, "sign-in refused", stale_lease=True))
        if response.status_code != 200:
            raise _refusal(response.status_code, body, response.headers.get("retry-after"))
        return _grant(body)

    async def _enroll(self, previous: Credentials | None) -> EnrollGrant:
        """Enroll; a lease the relay once signed is shown so the install keeps its id."""
        import httpx

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SEC) as client:
                response = await client.get(self._origin + ENROLL_PATH)
                if response.status_code == 404:
                    note_relay_does_not_enroll(self._relay_url)
                if response.status_code != 200:
                    raise _refusal(response.status_code, _json_object(response), None)
                info = _json_object(response)
                bits = max(0, min(int(info.get("pow_bits", 0)), MAX_POW_BITS))
                if isinstance(info.get("now"), int):
                    self._offset = info["now"] - self._clock()
                seed = secrets.token_hex(16)
                proof = await asyncio.to_thread(solve_pow, seed, bits, now=int(self._relay_now()))
                body = await self._post(
                    client,
                    ENROLL_PATH,
                    {
                        "seed": seed,
                        "platform": self._platform,
                        "build": self._build,
                        "proof": {"ts": proof.ts, "nonce": proof.nonce},
                        **({"previous": previous.lease} if previous else {}),
                    },
                )
        except httpx.HTTPError as exc:
            raise TunnelError(classify_failure(exc)) from exc
        return _grant(body)
