"""Unit coverage for podcast_relay.share_claims helpers."""

from __future__ import annotations

import pytest

from podcast_relay.share_claims import (
    attach_share_claims,
    parse_host_token_map,
    resolve_tunnel_secret,
    sign_share_claim,
    verify_share_claim,
)


def test_verify_share_claim_rejects_empty_and_length_mismatch() -> None:
    claim = sign_share_claim("sec", host_id="h", token="t", capabilities=["a"])
    assert verify_share_claim("", host_id="h", token="t", capabilities=["a"], claim=claim) is False
    assert verify_share_claim("sec", host_id="h", token="t", capabilities=["a"], claim="") is False
    assert (
        verify_share_claim("sec", host_id="h", token="t", capabilities=["a"], claim=claim[:8])
        is False
    )
    assert (
        verify_share_claim("sec", host_id="h", token="t", capabilities=["a"], claim=claim) is True
    )


def test_parse_host_token_map_mixed_entries() -> None:
    shared, by_host = parse_host_token_map(" shared , host-a:sec-a , :orphan , bare , host-b: ")
    assert shared == {"shared", "bare", ":orphan", "host-b:"}
    assert by_host == {"host-a": "sec-a"}


def test_resolve_tunnel_secret_bound_shared_and_legacy() -> None:
    assert resolve_tunnel_secret("", shared_secrets={"s"}, host_secrets={}, host_id="h") is None
    assert (
        resolve_tunnel_secret(
            "wrong", shared_secrets=set(), host_secrets={"h": "bound"}, host_id="h"
        )
        is None
    )
    assert (
        resolve_tunnel_secret(
            "bound", shared_secrets=set(), host_secrets={"h": "bound"}, host_id="h"
        )
        == "bound"
    )
    assert (
        resolve_tunnel_secret("shared", shared_secrets={"shared"}, host_secrets={}, host_id="h")
        == "shared"
    )
    assert (
        resolve_tunnel_secret(
            "legacy",
            shared_secrets=set(),
            host_secrets={"other": "legacy"},
            host_id="unknown",
        )
        == "legacy"
    )
    assert (
        resolve_tunnel_secret(
            "nope", shared_secrets={"shared"}, host_secrets={"h": "bound"}, host_id="x"
        )
        is None
    )


def test_attach_share_claims_skips_invalid_rows() -> None:
    rows = attach_share_claims(
        [
            "skip",
            {"token": "", "capabilities": ["x"]},
            {"token": "tok", "capabilities": ["b", "a"]},
        ],
        host_id="host-1",
        secret="sec",
    )
    assert len(rows) == 1
    assert rows[0]["token"] == "tok"
    assert rows[0]["capabilities"] == ["b", "a"]
    assert rows[0]["host_id"] == "host-1"
    assert rows[0]["claim"]


def test_relay_package_getattr() -> None:
    import podcast_relay

    assert podcast_relay.PROTOCOL_VERSION == 1
    assert callable(podcast_relay.create_relay_app)
    missing = "missing_attr"
    with pytest.raises(AttributeError, match=missing):
        getattr(podcast_relay, missing)
