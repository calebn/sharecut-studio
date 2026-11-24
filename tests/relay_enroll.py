"""Helpers that stand up a relay with enrollment on, for relay and tunnel-client tests."""

from __future__ import annotations

import itertools
import secrets
import time
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)

from podcast_mcp.util.relay_protocol.enroll import EnrollProof, pow_is_valid, solve_pow
from podcast_relay import policy as policy_module

MASTER_KEY = "m" * 32
POW_BITS = 6


def write_signing_key(path: Path, seed: bytes = bytes(range(32))) -> Path:
    key = Ed25519PrivateKey.from_private_bytes(seed)
    path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    return path


def sequential_install_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the relay assign install-1, install-2, ... so a test can name the id it will get."""
    ids = (f"install-{n}" for n in itertools.count(1))
    monkeypatch.setattr(policy_module, "new_install_id", lambda: next(ids))


def enable_enrollment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **overrides: str) -> Path:
    """Set the relay env for enrollment; returns the deny file path. *overrides* win."""
    deny = tmp_path / "deny.txt"
    deny.write_text("")
    env = {
        "PODCAST_RELAY_SIGNING_KEY": str(write_signing_key(tmp_path / "relay-key.pem")),
        "PODCAST_RELAY_MASTER_KEY": MASTER_KEY,
        "PODCAST_RELAY_ENROLL_POW_BITS": str(POW_BITS),
        "PODCAST_RELAY_DENY_FILE": str(deny),
    }
    for name, value in {**env, **overrides}.items():
        monkeypatch.setenv(name, value)
    sequential_install_ids(monkeypatch)
    return deny


def enroll_body(
    seed: str | None = None, *, build: str = "0.1.5", bits: int = POW_BITS, now: int | None = None
) -> dict[str, Any]:
    seed = seed or secrets.token_hex(16)
    proof = solve_pow(seed, bits, now=int(time.time()) if now is None else now)
    return {
        "seed": seed,
        "platform": "macos",
        "build": build,
        "proof": {"ts": proof.ts, "nonce": proof.nonce},
    }


def foreign_proof_body(prover_seed: str, *, bits: int = POW_BITS) -> dict[str, Any]:
    """An enrollment whose proof is valid only for *prover_seed*, not for the seed it carries."""
    body = enroll_body(bits=bits)
    now = int(time.time())
    for n in itertools.count():
        proof = EnrollProof(ts=now, nonce=format(n, "x"))
        if pow_is_valid(prover_seed, proof, bits=bits, now=now) and not pow_is_valid(
            body["seed"], proof, bits=bits, now=now
        ):
            break
    body["proof"] = {"ts": proof.ts, "nonce": proof.nonce}
    return body
