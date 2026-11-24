"""Signed install leases: the credential an enrolled host presents in the tunnel ``hello``.

A lease is ``base64url(json claims) "." base64url(Ed25519 signature)``. The relay holds only
public keys (by ``kid``), so it verifies a lease with no database and a rotated ``kid`` kills
every lease signed under the old one. The host never verifies a lease; it reads ``exp`` with
``peek_lease`` to schedule a renewal, so ``cryptography`` is imported only where keys are used.

``claim_key`` is the share-claim HMAC secret for one install: ``HMAC(master, install_id)``. It does
not depend on the lease, so renewing a lease never invalidates a claim the host already signed.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

LEASE_LIFETIME_SEC = 7 * 24 * 3600
# The reason on the 4403 close that ends a live tunnel when its lease expires.
LEASE_EXPIRED_CLOSE_REASON = "lease expired"
# A lease is renewed at half its life, so one missed renewal still leaves half a life of retries.
RENEW_FRACTION = 0.5

INSTALL_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_BUILD_RE = re.compile(r"^\d+(\.\d+){0,3}")
_CLAIM_KEY_LABEL = b"sharecut-claim-key-v1\n"


class LeaseRefusal(StrEnum):
    MALFORMED = "malformed"
    BAD_SIGNATURE = "bad_signature"
    UNKNOWN_KID = "unknown_kid"
    EXPIRED = "expired"
    WRONG_EPOCH = "wrong_epoch"
    DENIED = "denied"
    BUILD_TOO_OLD = "build_too_old"
    WRONG_INSTALL = "wrong_install"


class LeaseError(ValueError):
    def __init__(self, refusal: LeaseRefusal) -> None:
        super().__init__(refusal.value)
        self.refusal = refusal


@dataclass(frozen=True, slots=True)
class Lease:
    kid: str
    install_id: str
    epoch: int
    exp: int
    build: str
    platform: str

    def renew_at(self) -> int:
        return self.exp - int(LEASE_LIFETIME_SEC * (1 - RENEW_FRACTION))

    def claims(self) -> dict[str, str | int]:
        return {
            "kid": self.kid,
            "install_id": self.install_id,
            "epoch": self.epoch,
            "exp": self.exp,
            "build": self.build,
            "platform": self.platform,
        }


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise LeaseError(LeaseRefusal.MALFORMED) from exc


def _parse_claims(payload: bytes) -> Lease:
    try:
        data = json.loads(payload)
        epoch, exp = data["epoch"], data["exp"]
        lease = Lease(
            kid=data["kid"],
            install_id=data["install_id"],
            epoch=epoch,
            exp=exp,
            build=data["build"],
            platform=data["platform"],
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise LeaseError(LeaseRefusal.MALFORMED) from exc
    ints_ok = all(type(v) is int for v in (epoch, exp))
    strs_ok = all(isinstance(v, str) for v in (lease.kid, lease.build, lease.platform))
    if not (ints_ok and strs_ok and INSTALL_ID_RE.match(str(lease.install_id))):
        raise LeaseError(LeaseRefusal.MALFORMED)
    return lease


def split_lease(token: str) -> tuple[bytes, bytes]:
    payload_b64, dot, sig_b64 = token.partition(".")
    if not dot or not payload_b64 or not sig_b64:
        raise LeaseError(LeaseRefusal.MALFORMED)
    return _b64d(payload_b64), _b64d(sig_b64)


def peek_lease(token: str) -> Lease:
    """Read the claims without checking the signature (the host only schedules renewals from it)."""
    payload, _ = split_lease(token)
    return _parse_claims(payload)


def sign_lease(lease: Lease, key: Ed25519PrivateKey) -> str:
    payload = json.dumps(lease.claims(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"{_b64e(payload)}.{_b64e(key.sign(payload))}"


def verify_lease(token: str, public_keys: Mapping[str, bytes]) -> Lease:
    """Return the claims when *token* is signed by the public key its ``kid`` names.

    Expiry, epoch, denial and build are policy, not signature, so ``RelayPolicy`` checks them.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    payload, signature = split_lease(token)
    lease = _parse_claims(payload)
    raw_key = public_keys.get(lease.kid)
    if raw_key is None:
        raise LeaseError(LeaseRefusal.UNKNOWN_KID)
    try:
        Ed25519PublicKey.from_public_bytes(raw_key).verify(signature, payload)
    except (InvalidSignature, ValueError) as exc:
        raise LeaseError(LeaseRefusal.BAD_SIGNATURE) from exc
    return lease


def load_signing_key(path: Path) -> Ed25519PrivateKey:
    """Read an unencrypted PKCS8 PEM Ed25519 key (``openssl genpkey -algorithm ed25519``)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    key = load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError(f"{path} is not an Ed25519 private key")
    return key


def public_key_bytes(key: Ed25519PrivateKey) -> bytes:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def derive_claim_key(master_key: bytes, install_id: str) -> str:
    """The share-claim secret for *install_id*, identical on the relay and (once told) the host."""
    digest = hmac.new(master_key, _CLAIM_KEY_LABEL + install_id.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()


def build_key(build: str) -> tuple[int, ...]:
    """Order a dotted numeric build (``0.1.5``); anything unparsable sorts before every build."""
    found = _BUILD_RE.match(build)
    return tuple(int(part) for part in found.group(0).split(".")) if found else (-1,)
