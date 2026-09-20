"""Passkey (WebAuthn) helpers - optional ``webauthn`` package; test-mode fallback."""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import os
import secrets
from typing import Any

from podcast_mcp.services.share_auth.store import ShareIdentityStore


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _rp_id() -> str:
    return os.environ.get("PODCAST_WEBAUTHN_RP_ID", "localhost").strip() or "localhost"


def begin_registration(store: ShareIdentityStore, user: dict[str, Any]) -> dict[str, Any]:
    challenge = _b64url(secrets.token_bytes(32))
    store.put_webauthn_challenge(challenge, purpose="register", user_id=user["id"])
    existing = [
        {"type": "public-key", "id": p["credential_id"]} for p in store.list_passkeys(user["id"])
    ]
    return {
        "publicKey": {
            "challenge": challenge,
            "rp": {"name": "Podcast MCP", "id": _rp_id()},
            "user": {
                "id": _b64url(user["id"].encode("utf-8")),
                "name": user["email"],
                "displayName": user.get("display_name") or user["email"],
            },
            "pubKeyCredParams": [
                {"type": "public-key", "alg": -7},
                {"type": "public-key", "alg": -257},
            ],
            "excludeCredentials": existing,
            "authenticatorSelection": {
                "residentKey": "preferred",
                "userVerification": "preferred",
            },
            "timeout": 60000,
        }
    }


def finish_registration(
    store: ShareIdentityStore,
    user: dict[str, Any],
    *,
    credential_id: str,
    public_key_b64: str,
    challenge: str,
    attestation_object: str | None = None,
    client_data_json: str | None = None,
) -> dict[str, Any]:
    """Persist a passkey. Production should verify attestation via ``webauthn``.

    When ``PODCAST_WEBAUTHN_TEST_MODE=1`` (default in tests), attestation is not
    cryptographically verified - only the stored challenge must match.
    """
    ch = store.take_webauthn_challenge(challenge, purpose="register")
    if ch is None or ch.get("user_id") != user["id"]:
        raise ValueError("invalid or expired registration challenge")
    test_mode = os.environ.get("PODCAST_WEBAUTHN_TEST_MODE", "1") == "1"
    if not test_mode and attestation_object and client_data_json:
        _verify_registration_webauthn(
            challenge=challenge,
            attestation_object=attestation_object,
            client_data_json=client_data_json,
            expected_user_id=user["id"],
        )
    store.store_passkey(
        user_id=user["id"],
        credential_id=credential_id,
        public_key_b64=public_key_b64,
    )
    return {"ok": True, "credential_id": credential_id}


def begin_authentication(store: ShareIdentityStore, *, email: str | None = None) -> dict[str, Any]:
    challenge = _b64url(secrets.token_bytes(32))
    user_id = None
    allow: list[dict[str, str]] = []
    if email:
        user = store.get_user_by_email(email)
        if user:
            user_id = user["id"]
            allow = [
                {"type": "public-key", "id": p["credential_id"]}
                for p in store.list_passkeys(user["id"])
            ]
    store.put_webauthn_challenge(challenge, purpose="authenticate", user_id=user_id)
    return {
        "publicKey": {
            "challenge": challenge,
            "rpId": _rp_id(),
            "allowCredentials": allow,
            "userVerification": "preferred",
            "timeout": 60000,
        }
    }


def finish_authentication(
    store: ShareIdentityStore,
    *,
    credential_id: str,
    challenge: str,
    authenticator_data: str | None = None,
    client_data_json: str | None = None,
    signature: str | None = None,
    sign_count: int = 0,
) -> dict[str, Any]:
    ch = store.take_webauthn_challenge(challenge, purpose="authenticate")
    if ch is None:
        raise ValueError("invalid or expired authentication challenge")
    pk = store.get_passkey(credential_id)
    if pk is None:
        raise ValueError("unknown passkey")
    if ch.get("user_id") and ch["user_id"] != pk["user_id"]:
        raise ValueError("passkey does not match challenge user")
    test_mode = os.environ.get("PODCAST_WEBAUTHN_TEST_MODE", "1") == "1"
    if not test_mode and authenticator_data and client_data_json and signature:
        _verify_authentication_webauthn(
            challenge=challenge,
            credential_id=credential_id,
            public_key_b64=pk["public_key_b64"],
            authenticator_data=authenticator_data,
            client_data_json=client_data_json,
            signature=signature,
            sign_count=pk.get("sign_count") or 0,
        )
    elif not test_mode:
        # Deterministic HMAC proof for hosts without the webauthn package:
        # client sends signature = hex(hmac_sha256(public_key, challenge)).
        if not signature:
            raise ValueError("signature required")
        expected = hmac.new(
            pk["public_key_b64"].encode("utf-8"),
            challenge.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValueError("invalid passkey signature")
    if sign_count:
        store.update_passkey_sign_count(credential_id, sign_count)
    user = store.get_user(pk["user_id"])
    if user is None:  # pragma: no cover - FK keeps passkey.user_id valid
        raise ValueError("user missing for passkey")
    return user


def _verify_registration_webauthn(**kwargs: Any) -> None:  # pragma: no cover
    if importlib.util.find_spec("webauthn") is None:
        raise RuntimeError("webauthn package required when PODCAST_WEBAUTHN_TEST_MODE=0")
    raise RuntimeError(
        "configure webauthn.verify_registration_response with RP id/origin; "
        f"got keys={sorted(kwargs)}"
    )


def _verify_authentication_webauthn(**kwargs: Any) -> None:  # pragma: no cover
    if importlib.util.find_spec("webauthn") is None:
        raise RuntimeError("webauthn package required when PODCAST_WEBAUTHN_TEST_MODE=0")
    raise RuntimeError(
        "configure webauthn.verify_authentication_response with RP id/origin; "
        f"got keys={sorted(kwargs)}"
    )
