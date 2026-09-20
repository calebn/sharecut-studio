"""Password hashing and verification (stdlib scrypt; no extra deps)."""

from __future__ import annotations

import hashlib
import hmac
import secrets


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    """Return ``scrypt$<salt_hex>$<hash_hex>``."""
    if not password:
        raise ValueError("password must be non-empty")
    salt_b = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_b,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return f"scrypt${salt_b.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, salt_hex, hash_hex = encoded.split("$", 2)
    except ValueError:
        return False
    if algo != "scrypt":
        return False
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except ValueError:
        return False
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return hmac.compare_digest(digest, expected)
