"""Lease signing, claim-key derivation and the enrollment proof of work."""

from __future__ import annotations

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from podcast_mcp.util.relay_protocol.enroll import (
    POW_FRESH_SEC,
    EnrollProof,
    pow_is_valid,
    solve_pow,
)
from podcast_mcp.util.relay_protocol.lease import (
    Lease,
    LeaseError,
    LeaseRefusal,
    build_key,
    derive_claim_key,
    peek_lease,
    public_key_bytes,
    sign_lease,
    verify_lease,
)

LEASE = Lease(
    kid="k1", install_id="install-1", epoch=3, exp=1_800_000_000, build="0.1.5", platform="macos"
)


@pytest.fixture
def key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


def test_sign_then_verify_round_trips_every_field(key) -> None:
    token = sign_lease(LEASE, key)

    assert verify_lease(token, {"k1": public_key_bytes(key)}) == LEASE
    assert peek_lease(token) == LEASE


def test_renew_at_is_half_life_before_expiry() -> None:
    assert LEASE.renew_at() == 1_800_000_000 - 302_400


def test_unknown_kid_is_refused(key) -> None:
    token = sign_lease(LEASE, key)

    with pytest.raises(LeaseError) as caught:
        verify_lease(token, {"k2": public_key_bytes(key)})

    assert caught.value.refusal is LeaseRefusal.UNKNOWN_KID


def test_signature_from_another_key_is_refused(key) -> None:
    other = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))
    token = sign_lease(LEASE, other)

    with pytest.raises(LeaseError) as caught:
        verify_lease(token, {"k1": public_key_bytes(key)})

    assert caught.value.refusal is LeaseRefusal.BAD_SIGNATURE


def test_tampered_claims_are_refused(key) -> None:
    forged = sign_lease(Lease("k1", "install-1", 3, 1_900_000_000, "0.1.5", "macos"), key)
    payload = forged.split(".")[0]
    genuine_sig = sign_lease(LEASE, key).split(".")[1]

    with pytest.raises(LeaseError) as caught:
        verify_lease(f"{payload}.{genuine_sig}", {"k1": public_key_bytes(key)})

    assert caught.value.refusal is LeaseRefusal.BAD_SIGNATURE


@pytest.mark.parametrize("token", ["", "abc", "a.b", "....", "e30.e30", "!!!.!!!"])
def test_malformed_tokens_are_refused(token: str, key) -> None:
    with pytest.raises(LeaseError) as caught:
        verify_lease(token, {"k1": public_key_bytes(key)})

    assert caught.value.refusal is LeaseRefusal.MALFORMED


def test_claim_key_is_stable_per_install_and_differs_between_installs() -> None:
    master = b"m" * 32

    assert derive_claim_key(master, "install-1") == derive_claim_key(master, "install-1")
    assert derive_claim_key(master, "install-1") != derive_claim_key(master, "install-2")
    assert derive_claim_key(master, "install-1") != derive_claim_key(b"n" * 32, "install-1")
    assert derive_claim_key(b"m" * 32, "install-1") == (
        "e31cf7a5abdab79aa785eb4db0f606f8f44bcfce8190056c738a57937ca421f9"
    )


@pytest.mark.parametrize(
    ("build", "expected"),
    [
        ("0.1.5", (0, 1, 5)),
        ("2", (2,)),
        ("1.2.3.4-beta", (1, 2, 3, 4)),
        ("dev", (-1,)),
        ("", (-1,)),
    ],
)
def test_build_key(build: str, expected: tuple[int, ...]) -> None:
    assert build_key(build) == expected


def test_solved_pow_verifies_and_is_bound_to_the_install() -> None:
    proof = solve_pow("install-1", 12, now=1_000)

    assert pow_is_valid("install-1", proof, bits=12, now=1_000)
    assert not pow_is_valid("install-2", proof, bits=12, now=1_000)


def test_pow_below_difficulty_is_refused() -> None:
    proof = solve_pow("install-1", 8, now=1_000)

    assert not pow_is_valid("install-1", EnrollProof(proof.ts, "zz"), bits=24, now=1_000)


def test_pow_freshness_window() -> None:
    proof = solve_pow("install-1", 4, now=1_000)

    assert pow_is_valid("install-1", proof, bits=4, now=1_000 + POW_FRESH_SEC)
    assert not pow_is_valid("install-1", proof, bits=4, now=1_000 + POW_FRESH_SEC + 1)
    assert not pow_is_valid("install-1", proof, bits=4, now=1_000 - POW_FRESH_SEC - 1)
