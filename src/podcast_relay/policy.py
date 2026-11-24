"""Relay access policy: who may hold a lease and which leases are still honored.

``RelayPolicy`` is built once from the environment. With no signing key it is ``None`` on the app
state and the relay behaves exactly as before (host tokens only). The deny file is the one piece
that changes while the relay runs: ``DenylistWatcher`` rereads it and the tunnel route closes the
live tunnels of installs it names.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from podcast_mcp import settings
from podcast_mcp.util.relay_protocol.enroll import DEFAULT_POW_BITS, POW_FRESH_SEC, EnrollGrant
from podcast_mcp.util.relay_protocol.lease import (
    LEASE_LIFETIME_SEC,
    Lease,
    LeaseError,
    LeaseRefusal,
    build_key,
    derive_claim_key,
    load_signing_key,
    public_key_bytes,
    sign_lease,
    verify_lease,
)

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

log = logging.getLogger(__name__)

DENY_RELOAD_SEC = 5.0
# After an epoch bump, a lease of the previous epoch may still renew for this long, so a host that
# is online when the relay restarts keeps its install and shares without a new enrollment.
EPOCH_GRACE_SEC = 24 * 3600
MIN_MASTER_KEY_CHARS = 32


class RelayConfigError(ValueError):
    """The relay's environment cannot start it; the message says what to set."""


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_install_id() -> str:
    """A random 128-bit install id; only the relay assigns them."""
    return secrets.token_hex(16)


def read_deny_file(path: Path | None) -> frozenset[str]:
    """Install ids named in *path*, one per line (``#`` starts a comment). Missing means none."""
    if path is None:
        return frozenset()
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return frozenset()
    ids = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return frozenset(i for i in ids if i)


@dataclass
class RelayPolicy:
    signer: Ed25519PrivateKey
    kid: str
    public_keys: dict[str, bytes]
    master_key: bytes
    epoch: int = 1
    min_build: str = ""
    pow_bits: int = DEFAULT_POW_BITS
    deny_file: Path | None = None
    deny: frozenset[str] = field(default_factory=frozenset)
    clock: Callable[[], float] = time.time
    spent_seeds: dict[str, int] = field(default_factory=dict)
    epoch_grace_until: int = 0

    def now(self) -> int:
        return int(self.clock())

    def claim_key(self, install_id: str) -> str:
        return derive_claim_key(self.master_key, install_id)

    def build_allowed(self, build: str) -> bool:
        return build_key(build) >= build_key(self.min_build)

    def seed_spent(self, seed: str) -> bool:
        return seed in self.spent_seeds

    def spend_seed(self, seed: str) -> None:
        """Remember an accepted proof seed until its timestamp can no longer pass the freshness check."""
        now = self.now()
        self.spent_seeds = {s: at for s, at in self.spent_seeds.items() if at > now}
        self.spent_seeds[seed] = now + 2 * POW_FRESH_SEC

    def issue(self, install_id: str, *, platform: str, build: str) -> EnrollGrant:
        exp = self.now() + LEASE_LIFETIME_SEC
        lease = Lease(self.kid, install_id, self.epoch, exp, build, platform)
        return EnrollGrant(
            install_id=install_id,
            lease=sign_lease(lease, self.signer),
            claim_key=self.claim_key(install_id),
            exp=exp,
            renew_at=lease.renew_at(),
            server_time=self.now(),
        )

    def __post_init__(self) -> None:
        self.epoch_grace_until = self.now() + EPOCH_GRACE_SEC

    def _epoch_ok(self, lease: Lease, *, renewing: bool) -> bool:
        if lease.epoch == self.epoch:
            return True
        return renewing and lease.epoch == self.epoch - 1 and self.now() < self.epoch_grace_until

    def check(
        self,
        token: str,
        *,
        install_id: str | None = None,
        enforce_build: bool = True,
        renewing: bool = False,
    ) -> Lease:
        """Return the lease in *token* when this relay still honors it, else raise ``LeaseError``.

        A lease being renewed may be one epoch behind for ``EPOCH_GRACE_SEC`` after this relay
        started; a hello never may.
        """
        lease = verify_lease(token, self.public_keys)
        if lease.exp <= self.now():
            raise LeaseError(LeaseRefusal.EXPIRED)
        if not self._epoch_ok(lease, renewing=renewing):
            raise LeaseError(LeaseRefusal.WRONG_EPOCH)
        if lease.install_id in self.deny:
            raise LeaseError(LeaseRefusal.DENIED)
        if enforce_build and not self.build_allowed(lease.build):
            raise LeaseError(LeaseRefusal.BUILD_TOO_OLD)
        if install_id is not None and lease.install_id != install_id:
            raise LeaseError(LeaseRefusal.WRONG_INSTALL)
        return lease

    def previous_install(self, token: str) -> str | None:
        """The install id in a lease this relay signed, expired or not, else None."""
        try:
            return verify_lease(token, self.public_keys).install_id
        except LeaseError:
            return None

    def reload_deny(self) -> frozenset[str]:
        """Reread the deny file; return the install ids denied by this reload and not before."""
        before = self.deny
        self.deny = read_deny_file(self.deny_file)
        return self.deny - before


def load_policy() -> RelayPolicy | None:
    """Build the policy from ``PODCAST_RELAY_*``; ``None`` when no signing key is configured."""
    key_path = settings.text("PODCAST_RELAY_SIGNING_KEY")
    if not key_path:
        return None
    key = load_signing_key(Path(key_path).expanduser())
    kid = settings.value("PODCAST_RELAY_SIGNING_KID", "k1")
    public_keys = {kid: public_key_bytes(key)}
    for entry in settings.text("PODCAST_RELAY_PUBLIC_KEYS").split(","):
        other_kid, _, encoded = entry.strip().partition(":")
        if not other_kid or not encoded:
            continue
        try:
            public_keys.setdefault(other_kid, _b64d(encoded))
        except (binascii.Error, ValueError):
            log.warning("Ignoring unreadable PODCAST_RELAY_PUBLIC_KEYS entry for kid %s", other_kid)
    master = settings.text("PODCAST_RELAY_MASTER_KEY")
    if len(master) < MIN_MASTER_KEY_CHARS:
        raise RelayConfigError(
            f"PODCAST_RELAY_MASTER_KEY must be set to at least {MIN_MASTER_KEY_CHARS} characters "
            "when PODCAST_RELAY_SIGNING_KEY is set (for example `openssl rand -hex 32`). Share "
            "claims derive from it, so it must not change when the signing key does."
        )
    master_key = master.encode("utf-8")
    deny_path = settings.text("PODCAST_RELAY_DENY_FILE")
    policy = RelayPolicy(
        signer=key,
        kid=kid,
        public_keys=public_keys,
        master_key=master_key,
        epoch=int(settings.number("PODCAST_RELAY_EPOCH", 1)),
        min_build=settings.text("PODCAST_RELAY_MIN_BUILD"),
        pow_bits=int(settings.number("PODCAST_RELAY_ENROLL_POW_BITS", DEFAULT_POW_BITS)),
        deny_file=Path(deny_path).expanduser() if deny_path else None,
    )
    policy.reload_deny()
    return policy


async def watch_denylist(
    policy: RelayPolicy,
    on_denied: Callable[[frozenset[str]], object],
    *,
    interval_sec: float | None = None,
) -> None:
    """Reload the deny file every *interval_sec*; hand each newly denied id set to *on_denied*."""
    while True:
        await asyncio.sleep(DENY_RELOAD_SEC if interval_sec is None else interval_sec)
        try:
            newly = await asyncio.to_thread(policy.reload_deny)
        except Exception:
            log.exception("Could not read the relay deny file; keeping the last list")
            continue
        if newly:
            try:
                result = on_denied(newly)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                log.exception("Could not close the tunnels of newly denied installs")
