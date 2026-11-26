"""Enrollment wire shapes and the hashcash proof a host sends with ``POST /api/relay/enroll``.

The proof binds a timestamp and a nonce to a ``seed`` the host picks for this one enrollment:
``sha256`` of the challenge must start with ``bits`` zero bits. The relay refuses a seed it has
already accepted inside the freshness window, so a proof pays for one enrollment. The relay, not
the host, assigns the install id. The proof is a speed bump for scripted enrollment, not the
defense; the relay's per-subnet and global limits are.
"""

from __future__ import annotations

import hashlib
import itertools
import re
from dataclasses import dataclass, field

DEFAULT_POW_BITS = 20
# A solve takes seconds, and the host stamps the proof with the relay's own clock, so the window
# only has to cover the solve and the round trip. Short enough that a proof cannot be stockpiled.
POW_FRESH_SEC = 120
# Hosts cannot be made to solve more work than a phone does in about a minute, whatever a relay says.
MAX_POW_BITS = 26
SEED_RE = re.compile(r"^[A-Za-z0-9]{16,64}$")

ENROLL_PATH = "/api/relay/enroll"
RENEW_PATH = "/api/relay/enroll/renew"


@dataclass(frozen=True, slots=True)
class EnrollProof:
    ts: int
    nonce: str


@dataclass(frozen=True, slots=True)
class EnrollGrant:
    """What the relay returns for an enrollment or a renewal, with its own clock for the host."""

    install_id: str
    lease: str = field(repr=False)
    claim_key: str = field(repr=False)
    exp: int
    renew_at: int
    server_time: int


def _leading_zero_bits(digest: bytes) -> int:
    value = int.from_bytes(digest, "big")
    return len(digest) * 8 - value.bit_length()


def _digest(seed: str, proof: EnrollProof) -> bytes:
    return hashlib.sha256(
        f"sharecut-enroll-v2\n{seed}\n{proof.ts}\n{proof.nonce}".encode()
    ).digest()


def solve_pow(seed: str, bits: int, *, now: int) -> EnrollProof:
    for counter in itertools.count():
        proof = EnrollProof(ts=now, nonce=format(counter, "x"))
        if _leading_zero_bits(_digest(seed, proof)) >= bits:
            return proof
    raise AssertionError("unreachable")  # pragma: no cover


def pow_is_valid(seed: str, proof: EnrollProof, *, bits: int, now: int) -> bool:
    if abs(now - proof.ts) > POW_FRESH_SEC or len(proof.nonce) > 32:
        return False
    return _leading_zero_bits(_digest(seed, proof)) >= bits
