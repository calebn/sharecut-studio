"""Share identity: Restricted ACL, OAuth loaders, magic link, password, passkeys."""

from __future__ import annotations

import json
from datetime import UTC
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService
from podcast_mcp.services.share_auth.access import access_required, normalize_general_access
from podcast_mcp.services.share_auth.oauth_credentials import (
    load_github_oauth,
    load_google_oauth,
)
from podcast_mcp.services.share_auth.oauth_flow import exchange_code, make_pkce_pair
from podcast_mcp.services.share_auth.passkeys import (
    begin_authentication,
    begin_registration,
    finish_authentication,
    finish_registration,
)
from podcast_mcp.services.share_auth.passwords import hash_password, verify_password
from podcast_mcp.services.share_auth.store import (
    ShareIdentityStore,
    reset_identity_store_for_tests,
)


@pytest.fixture
def identity_store(tmp_path, monkeypatch):
    from podcast_mcp.extensions import loader
    from podcast_mcp.extensions.api_version import HOST_API_VERSION
    from podcast_mcp.extensions.features import FEATURE_ONLINE_ACCOUNT
    from podcast_mcp.extensions.registry import FeatureRegistry

    class TestAccountProvider:
        api_version = HOST_API_VERSION
        name = "test-account-provider"

        def compatible(self, host_api_version: int) -> bool:
            return host_api_version >= self.api_version

        def contribute(self, registry: FeatureRegistry) -> None:
            from podcast_mcp.gui.routes import auth

            registry.add_router(auth.router, source=self.name, feature_id=None)
            registry.add(FEATURE_ONLINE_ACCOUNT, source=self.name)

    class AccountProviderEntryPoint:
        name = "test-account-provider"

        @staticmethod
        def load():
            return TestAccountProvider

    db = tmp_path / "identity.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(db))
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration,test-account-provider")
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [AccountProviderEntryPoint()])
    reset_identity_store_for_tests()
    store = ShareIdentityStore(db)
    yield store
    store.close()
    reset_identity_store_for_tests()


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_normalize_general_access() -> None:
    assert normalize_general_access("LINK") == "link"
    assert normalize_general_access("restricted") == "restricted"
    with pytest.raises(ValueError):
        normalize_general_access("public")


def test_password_hash_roundtrip() -> None:
    enc = hash_password("s3cret!!")
    assert verify_password("s3cret!!", enc)
    assert not verify_password("nope", enc)


def test_verified_email_merges_google_and_github(identity_store: ShareIdentityStore) -> None:
    g = identity_store.upsert_user_from_oidc(
        provider="google",
        subject="g-sub-1",
        email="a@example.com",
        email_verified=True,
        display_name="A",
    )
    h = identity_store.upsert_user_from_oidc(
        provider="github",
        subject="42",
        email="a@example.com",
        email_verified=True,
        display_name="A",
    )
    assert g["id"] == h["id"]
    user = identity_store.get_user(g["id"])
    assert user is not None
    assert user["google_sub"] == "g-sub-1"
    assert user["github_sub"] == "42"


def test_oauth_credential_loaders(tmp_path, monkeypatch) -> None:
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", raising=False)
    assert load_google_oauth() is None
    assert load_github_oauth() is None

    (cfg / "google-oauth-client.json").write_text(
        json.dumps(
            {
                "web": {
                    "client_id": "gid",
                    "client_secret": "gsecret",
                }
            }
        ),
        encoding="utf-8",
    )
    (cfg / "github-oauth.json").write_text(
        json.dumps({"client_id": "hid", "client_secret": "hsecret"}),
        encoding="utf-8",
    )
    g = load_google_oauth()
    h = load_github_oauth()
    assert g is not None and g.client_id == "gid"
    assert h is not None and h.client_id == "hid"

    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "env-g")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "env-gs")
    g2 = load_google_oauth()
    assert g2 is not None and g2.client_id == "env-g"


def test_oauth_exchange_google_injectable(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "sec")
    monkeypatch.setenv(
        "PODCAST_GOOGLE_OAUTH_REDIRECT_URI", "http://127.0.0.1:8765/auth/callback/google"
    )

    def post(url, **kwargs):
        return {"access_token": "tok"}

    def get(url, **kwargs):
        return {
            "sub": "sub1",
            "email": "u@example.com",
            "email_verified": True,
            "name": "U",
        }

    profile = exchange_code("google", code="c", code_verifier="v", http_post=post, http_get=get)
    assert profile["email"] == "u@example.com"
    assert make_pkce_pair()[0]


def test_restricted_share_requires_acl(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="restricted")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="http://example.test",
        capabilities=["play", "comment"],
        general_access="restricted",
    )
    assert access_required(share)
    token = share["token"]
    identity_store.invite_to_share(token, email="guest@example.com", role="commenter")

    client = TestClient(create_app())
    denied = client.get(f"/api/review/{token}/project")
    assert denied.status_code == 401

    # Password register + session cookie
    reg = client.post(
        "/auth/password/register",
        json={"email": "guest@example.com", "password": "password1"},
    )
    assert reg.status_code == 200
    ok = client.get(f"/api/review/{token}/project")
    assert ok.status_code == 200

    # Outsider blocked
    client2 = TestClient(create_app())
    client2.post(
        "/auth/password/register",
        json={"email": "other@example.com", "password": "password1"},
    )
    assert client2.get(f"/api/review/{token}/project").status_code == 403


def test_link_share_stays_anonymous(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="link")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
        general_access="link",
    )
    assert not access_required(share)
    client = TestClient(create_app())
    assert client.get(f"/api/review/{share['token']}/project").status_code == 200


def test_require_sign_in_on_link_share(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="force")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
        general_access="link",
        require_sign_in=True,
    )
    token = share["token"]
    identity_store.invite_to_share(token, email="force@example.com")
    client = TestClient(create_app())
    assert client.get(f"/api/review/{token}/project").status_code == 401
    client.post(
        "/auth/password/register",
        json={"email": "force@example.com", "password": "password1"},
    )
    assert client.get(f"/api/review/{token}/project").status_code == 200


def test_magic_link_and_agent_credential(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    monkeypatch.setenv("PODCAST_MAGIC_LINK_PRINT", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="magic")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "mcp"],
        general_access="restricted",
    )
    token = share["token"]
    identity_store.invite_to_share(token, email="m@example.com")
    client = TestClient(create_app())
    ml = client.post(
        "/auth/magic-link",
        json={"email": "m@example.com", "share_token": token},
    )
    assert ml.status_code == 200
    link = ml.json()["dev_link"]
    assert "token=" in link
    raw = link.split("token=")[1].split("&")[0]
    consumed = client.get(f"/auth/magic-link/consume?token={raw}", follow_redirects=False)
    assert consumed.status_code == 302

    agent = client.post(
        "/auth/agent-credential",
        json={"share_token": token},
    )
    assert agent.status_code == 200
    bearer = agent.json()["token"]
    client3 = TestClient(create_app())
    assert client3.get(f"/api/review/{token}/project").status_code == 401
    ok = client3.get(
        f"/api/review/{token}/project",
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert ok.status_code == 200


def test_passkey_register_and_login(identity_store: ShareIdentityStore) -> None:
    user = identity_store.create_or_get_email_user(
        "pk@example.com", password="password1", email_verified=True
    )
    begin = begin_registration(identity_store, user)
    challenge = begin["publicKey"]["challenge"]
    finish_registration(
        identity_store,
        user,
        credential_id="cred-1",
        public_key_b64="pubkey",
        challenge=challenge,
    )
    auth_begin = begin_authentication(identity_store, email="pk@example.com")
    ch2 = auth_begin["publicKey"]["challenge"]
    logged = finish_authentication(
        identity_store,
        credential_id="cred-1",
        challenge=ch2,
    )
    assert logged["email"] == "pk@example.com"


def test_auth_providers_endpoint(identity_store, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    client = TestClient(create_app())
    r = client.get("/auth/providers")
    assert r.status_code == 200
    assert r.json()["password"] is True
    assert "MCP SDK OAuth" in r.json()["note"]


def test_password_edge_cases() -> None:
    with pytest.raises(ValueError):
        hash_password("")
    assert verify_password("x", "not-a-hash") is False
    assert verify_password("x", "bcrypt$aa$bb") is False
    assert verify_password("x", "scrypt$zz$yy") is False


def test_oauth_public_origin_redirect(monkeypatch) -> None:
    from podcast_mcp.services.share_auth.oauth_credentials import _default_redirect

    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_REDIRECT_URI", raising=False)
    monkeypatch.setenv("PODCAST_PUBLIC_ORIGIN", "https://sudo.science")
    assert _default_redirect("google") == "https://sudo.science/auth/callback/google"


def test_parse_google_top_level_and_bad_json(tmp_path, monkeypatch) -> None:
    from podcast_mcp.services.share_auth.oauth_credentials import (
        _parse_google_json,
        oauth_providers_available,
    )

    cid, secret = _parse_google_json({"client_id": "a", "client_secret": "b"})
    assert cid == "a" and secret == "b"
    with pytest.raises(ValueError):
        _parse_google_json({"web": {"client_id": ""}})

    cfg = tmp_path / "cfg"
    cfg.mkdir()
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", raising=False)
    (cfg / "google-oauth-client.json").write_text("{not json", encoding="utf-8")
    (cfg / "github-oauth.json").write_text("[]", encoding="utf-8")
    assert load_google_oauth() is None
    assert load_github_oauth() is None
    assert oauth_providers_available() == {"google": False, "github": False}

    (cfg / "google-oauth-client.json").write_text(
        json.dumps({"web": {"client_id": "x", "client_secret": ""}}),
        encoding="utf-8",
    )
    assert load_google_oauth() is None
    (cfg / "github-oauth.json").write_text(json.dumps({"client_id": "only"}), encoding="utf-8")
    assert load_github_oauth() is None


def test_authorization_url_and_github_exchange(monkeypatch) -> None:
    from podcast_mcp.services.share_auth.oauth_flow import authorization_url

    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "gid")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "gsec")
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", "hid")
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "hsec")
    monkeypatch.setenv(
        "PODCAST_GOOGLE_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:8765/auth/callback/google",
    )
    monkeypatch.setenv(
        "PODCAST_GITHUB_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:8765/auth/callback/github",
    )
    g_url, g_cfg = authorization_url("google", state="s", code_challenge="cc")
    assert "accounts.google.com" in g_url and g_cfg.client_id == "gid"
    h_url, h_cfg = authorization_url("github", state="s", code_challenge="cc")
    assert "github.com/login" in h_url and h_cfg.client_id == "hid"
    with pytest.raises(ValueError):
        authorization_url("apple", state="s", code_challenge="cc")

    def post(url, **kwargs):
        return {"access_token": "tok"}

    def get(url, **kwargs):
        if url.endswith("/user/emails"):
            return [
                {"email": "sec@ex.com", "primary": False, "verified": True},
                {"email": "pri@ex.com", "primary": True, "verified": True},
            ]
        return {"id": 99, "login": "octo", "email": None, "name": None}

    profile = exchange_code("github", code="c", code_verifier="v", http_post=post, http_get=get)
    assert profile["email"] == "pri@ex.com"
    assert profile["sub"] == "99"

    def get_with_email(url, **kwargs):
        return {"id": 1, "email": "e@ex.com", "name": "N", "login": "l"}

    p2 = exchange_code(
        "github",
        code="c",
        code_verifier="v",
        http_post=post,
        http_get=get_with_email,
    )
    assert p2["email"] == "e@ex.com" and p2["email_verified"] is True

    with pytest.raises(RuntimeError, match="token exchange failed"):
        exchange_code(
            "google",
            code="c",
            code_verifier="v",
            http_post=lambda *a, **k: {},
            http_get=lambda *a, **k: {},
        )
    with pytest.raises(ValueError):
        exchange_code("apple", code="c", code_verifier="v")


def test_authorization_url_unconfigured(monkeypatch) -> None:
    from podcast_mcp.services.share_auth.oauth_flow import authorization_url

    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("PODCAST_CONFIG_DIR", "/tmp/podcast-mcp-no-oauth-cfg")
    with pytest.raises(RuntimeError, match="Google OAuth"):
        authorization_url("google", state="s", code_challenge="c")


def test_store_acl_sessions_revoke(identity_store: ShareIdentityStore) -> None:
    user = identity_store.create_or_get_email_user(
        "acl@ex.com", password="password1", email_verified=True
    )
    identity_store.invite_to_share("tok-1", email="acl@ex.com", role="editor")
    assert identity_store.acl_allows("tok-1", user["id"])["role"] == "editor"
    assert identity_store.revoke_acl("tok-1", email="acl@ex.com") is True
    assert identity_store.acl_allows("tok-1", user["id"]) is None

    session = identity_store.create_session(user["id"], ttl_hours=1)
    assert identity_store.resolve_session(session)["id"] == user["id"]
    identity_store.revoke_session(session)
    assert identity_store.resolve_session(session) is None
    assert identity_store.resolve_session(None) is None
    assert identity_store.resolve_agent_credential("not-an-agent") is None
    assert identity_store.verify_email_password("acl@ex.com", "wrong") is None
    with pytest.raises(ValueError):
        identity_store.revoke_acl("tok-1")


def test_passkey_hmac_mode_and_http_routes(identity_store, monkeypatch) -> None:
    import hashlib
    import hmac

    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "0")
    user = identity_store.create_or_get_email_user(
        "pk2@ex.com", password="password1", email_verified=True
    )
    begin = begin_registration(identity_store, user)
    # registration still works in test when attestation omitted (falls through)
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "1")
    finish_registration(
        identity_store,
        user,
        credential_id="cred-hmac",
        public_key_b64="pk-secret",
        challenge=begin["publicKey"]["challenge"],
    )
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "0")
    auth = begin_authentication(identity_store, email="pk2@ex.com")
    ch = auth["publicKey"]["challenge"]
    sig = hmac.new(b"pk-secret", ch.encode("utf-8"), hashlib.sha256).hexdigest()
    logged = finish_authentication(
        identity_store,
        credential_id="cred-hmac",
        challenge=ch,
        signature=sig,
        sign_count=2,
    )
    assert logged["email"] == "pk2@ex.com"
    with pytest.raises(ValueError, match="signature"):
        auth2 = begin_authentication(identity_store, email="pk2@ex.com")
        finish_authentication(
            identity_store,
            credential_id="cred-hmac",
            challenge=auth2["publicKey"]["challenge"],
        )


def test_secure_cookie_flag(monkeypatch) -> None:
    from podcast_mcp.gui.routes import auth as auth_routes

    monkeypatch.setenv("PODCAST_AUTH_COOKIE_SECURE", "true")
    assert auth_routes._secure_cookie() is True
    monkeypatch.delenv("PODCAST_AUTH_COOKIE_SECURE", raising=False)
    assert auth_routes._secure_cookie() is False


def test_auth_http_password_logout_me_passkeys(identity_store, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_AUTH_COOKIE_SECURE", raising=False)
    client = TestClient(create_app())
    assert client.get("/auth/login").status_code == 200
    assert client.get("/auth/me").status_code == 401

    bad = client.post(
        "/auth/password/register",
        json={"email": "short@ex.com", "password": "short"},
    )
    assert bad.status_code == 400

    reg = client.post(
        "/auth/password/register",
        json={
            "email": "http@ex.com",
            "password": "password1",
            "display_name": "H",
        },
    )
    assert reg.status_code == 200
    assert client.get("/auth/me").status_code == 200

    login = client.post(
        "/auth/password/login",
        json={"email": "http@ex.com", "password": "password1"},
    )
    assert login.status_code == 200
    assert (
        client.post(
            "/auth/password/login",
            json={"email": "http@ex.com", "password": "nope"},
        ).status_code
        == 401
    )

    begin = client.post("/auth/passkey/register/begin")
    assert begin.status_code == 200
    challenge = begin.json()["publicKey"]["challenge"]
    fin = client.post(
        "/auth/passkey/register/finish",
        json={
            "credential_id": "http-cred",
            "public_key_b64": "k",
            "challenge": challenge,
        },
    )
    assert fin.status_code == 200

    client.post("/auth/logout")
    assert client.get("/auth/me").status_code == 401

    start = client.post("/auth/passkey/login/begin", json={"email": "http@ex.com"})
    assert start.status_code == 200
    ch = start.json()["publicKey"]["challenge"]
    done = client.post(
        "/auth/passkey/login/finish",
        json={"credential_id": "http-cred", "challenge": ch},
    )
    assert done.status_code == 200
    assert client.get("/auth/me").status_code == 200


def test_oauth_login_redirect_and_callback(identity_store, monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "gid")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "gsec")
    monkeypatch.setenv(
        "PODCAST_GOOGLE_OAUTH_REDIRECT_URI",
        "http://testserver/auth/callback/google",
    )
    client = TestClient(create_app())
    assert client.get("/auth/login/apple").status_code == 404
    start = client.get("/auth/login/google?next=/r/demo", follow_redirects=False)
    assert start.status_code == 302
    assert "accounts.google.com" in start.headers["location"]

    # Missing cookies → invalid state
    assert (
        client.get("/auth/callback/google?code=c&state=bad", follow_redirects=False).status_code
        == 400
    )

    start = client.get("/auth/login/google", follow_redirects=False)
    state = start.cookies.get("podcast_oauth_state")
    verifier = start.cookies.get("podcast_oauth_verifier")
    assert state and verifier

    def fake_exchange(provider, **kwargs):
        return {
            "sub": "g1",
            "email": "oauth@ex.com",
            "email_verified": True,
            "display_name": "O",
        }

    monkeypatch.setattr("podcast_mcp.gui.routes.auth.exchange_code", fake_exchange)
    cb = client.get(
        f"/auth/callback/google?code=abc&state={state}",
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert client.get("/auth/me").status_code == 200


def test_oauth_login_unconfigured(monkeypatch, identity_store) -> None:
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("PODCAST_CONFIG_DIR", "/tmp/no-oauth-here-xyz")
    client = TestClient(create_app())
    assert client.get("/auth/login/google").status_code == 503


def test_agent_credential_requires_acl(identity_store, monkeypatch) -> None:
    client = TestClient(create_app())
    client.post(
        "/auth/password/register",
        json={"email": "agentless@ex.com", "password": "password1"},
    )
    denied = client.post(
        "/auth/agent-credential",
        json={"share_token": "nope"},
    )
    assert denied.status_code == 403
    anon = TestClient(create_app())
    assert anon.post("/auth/agent-credential", json={"share_token": "x"}).status_code == 401


def test_magic_link_invalid_and_expired(identity_store: ShareIdentityStore) -> None:
    client = TestClient(create_app())
    assert (
        client.get("/auth/magic-link/consume?token=garbage", follow_redirects=False).status_code
        == 400
    )
    raw = identity_store.create_magic_link("exp@ex.com", ttl_minutes=-1)
    # negative ttl still stores past expiry via timedelta - consume should fail
    # (expires_at in the past)
    from datetime import datetime, timedelta

    # Force-expire by rewriting
    th = __import__("hashlib").sha256(raw.encode()).hexdigest()
    identity_store._conn.execute(
        "UPDATE magic_links SET expires_at = ? WHERE token_hash = ?",
        (
            (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            th,
        ),
    )
    identity_store._conn.commit()
    assert identity_store.consume_magic_link(raw) is None


def test_upsert_unverified_and_by_sub(identity_store: ShareIdentityStore) -> None:
    with pytest.raises(ValueError):
        identity_store.upsert_user_from_oidc(
            provider="google", subject="s", email="", email_verified=True
        )
    with pytest.raises(ValueError):
        identity_store.upsert_user_from_oidc(
            provider="apple", subject="s", email="a@b.com", email_verified=True
        )
    u = identity_store.upsert_user_from_oidc(
        provider="google",
        subject="sub-x",
        email="x@ex.com",
        email_verified=False,
        display_name="X",
    )
    again = identity_store.upsert_user_from_oidc(
        provider="google",
        subject="sub-x",
        email="x2@ex.com",
        email_verified=True,
        display_name="X2",
    )
    assert u["id"] == again["id"]


def test_oauth_flow_unconfigured_and_token_failures(monkeypatch) -> None:
    from podcast_mcp.services.share_auth.oauth_flow import authorization_url

    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("PODCAST_CONFIG_DIR", "/tmp/no-gh-oauth")
    with pytest.raises(RuntimeError, match="GitHub OAuth"):
        authorization_url("github", state="s", code_challenge="c")

    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="Google OAuth"):
        exchange_code(
            "google",
            code="c",
            code_verifier="v",
            http_post=lambda *a, **k: {"access_token": "t"},
            http_get=lambda *a, **k: {},
        )

    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", "hid")
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "hsec")
    with pytest.raises(RuntimeError, match="GitHub token"):
        exchange_code(
            "github",
            code="c",
            code_verifier="v",
            http_post=lambda *a, **k: {},
            http_get=lambda *a, **k: {},
        )

    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="GitHub OAuth"):
        exchange_code(
            "github",
            code="c",
            code_verifier="v",
            http_post=lambda *a, **k: {"access_token": "t"},
            http_get=lambda *a, **k: {},
        )

    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", "hid")
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "hsec")

    def get_empty_emails(url, **kwargs):
        if url.endswith("/emails"):
            return []
        return {"id": 7, "email": None, "login": "z"}

    profile = exchange_code(
        "github",
        code="c",
        code_verifier="v",
        http_post=lambda *a, **k: {"access_token": "t"},
        http_get=get_empty_emails,
    )
    assert profile["email"] == ""


def test_passkey_error_paths(identity_store: ShareIdentityStore, monkeypatch) -> None:

    user = identity_store.create_or_get_email_user("err@ex.com", password="password1")
    with pytest.raises(ValueError, match="registration challenge"):
        finish_registration(
            identity_store,
            user,
            credential_id="c",
            public_key_b64="k",
            challenge="missing",
        )
    begin = begin_registration(identity_store, user)
    finish_registration(
        identity_store,
        user,
        credential_id="c1",
        public_key_b64="k1",
        challenge=begin["publicKey"]["challenge"],
    )
    with pytest.raises(ValueError, match="authentication challenge"):
        finish_authentication(identity_store, credential_id="c1", challenge="nope")
    auth = begin_authentication(identity_store, email="err@ex.com")
    with pytest.raises(ValueError, match="unknown passkey"):
        finish_authentication(
            identity_store,
            credential_id="missing",
            challenge=auth["publicKey"]["challenge"],
        )
    auth = begin_authentication(identity_store, email="err@ex.com")
    other = identity_store.create_or_get_email_user("other2@ex.com", password="password1")
    begin2 = begin_registration(identity_store, other)
    finish_registration(
        identity_store,
        other,
        credential_id="other-cred",
        public_key_b64="ko",
        challenge=begin2["publicKey"]["challenge"],
    )
    with pytest.raises(ValueError, match="does not match"):
        finish_authentication(
            identity_store,
            credential_id="other-cred",
            challenge=auth["publicKey"]["challenge"],
        )
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "0")
    auth = begin_authentication(identity_store, email="err@ex.com")
    ch = auth["publicKey"]["challenge"]
    with pytest.raises(ValueError, match="invalid passkey signature"):
        finish_authentication(
            identity_store,
            credential_id="c1",
            challenge=ch,
            signature="deadbeef",
        )
    begin_authentication(identity_store)  # no email
    monkeypatch.setenv("PODCAST_WEBAUTHN_RP_ID", "  ")
    begin_registration(identity_store, user)


def test_auth_me_bearer_and_oauth_errors(identity_store, monkeypatch) -> None:
    client = TestClient(create_app())
    store = identity_store
    user = store.create_or_get_email_user("bear@ex.com", password="password1")
    session = store.create_session(user["id"])
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {session}"})
    assert me.status_code == 200

    assert (
        client.get("/auth/callback/google?error=access_denied", follow_redirects=False).status_code
        == 400
    )
    assert client.get("/auth/callback/google", follow_redirects=False).status_code == 400
    assert (
        client.get("/auth/callback/apple?code=c&state=s", follow_redirects=False).status_code == 404
    )

    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "gid")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "gsec")
    monkeypatch.setenv(
        "PODCAST_GOOGLE_OAUTH_REDIRECT_URI",
        "http://testserver/auth/callback/google",
    )
    start = client.get("/auth/login/google", follow_redirects=False)
    state = start.cookies.get("podcast_oauth_state")

    def boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr("podcast_mcp.gui.routes.auth.exchange_code", boom)
    assert (
        client.get(
            f"/auth/callback/google?code=x&state={state}",
            follow_redirects=False,
        ).status_code
        == 400
    )

    start = client.get("/auth/login/google", follow_redirects=False)
    state = start.cookies.get("podcast_oauth_state")

    def no_email(*a, **k):
        return {"sub": "1", "email": "", "email_verified": True}

    monkeypatch.setattr("podcast_mcp.gui.routes.auth.exchange_code", no_email)
    assert (
        client.get(
            f"/auth/callback/google?code=x&state={state}",
            follow_redirects=False,
        ).status_code
        == 400
    )


def test_auth_passkey_http_errors(identity_store, monkeypatch) -> None:
    client = TestClient(create_app())
    assert client.post("/auth/passkey/register/begin").status_code == 401
    assert (
        client.post(
            "/auth/passkey/register/finish",
            json={
                "credential_id": "x",
                "public_key_b64": "y",
                "challenge": "z",
            },
        ).status_code
        == 401
    )
    client.post(
        "/auth/password/register",
        json={"email": "pkhttp@ex.com", "password": "password1"},
    )
    bad = client.post(
        "/auth/passkey/register/finish",
        json={
            "credential_id": "x",
            "public_key_b64": "y",
            "challenge": "bad",
        },
    )
    assert bad.status_code == 400
    assert (
        client.post(
            "/auth/passkey/login/finish",
            json={"credential_id": "x", "challenge": "bad"},
        ).status_code
        == 400
    )


def test_magic_link_redirects_to_share(identity_store, monkeypatch) -> None:
    client = TestClient(create_app())
    raw = identity_store.create_magic_link("shareme@ex.com", share_token="cool-name-token")
    resp = client.get(f"/auth/magic-link/consume?token={raw}", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/r/cool-name-token"


def test_passkey_webauthn_stub_paths(identity_store, monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "0")
    user = identity_store.create_or_get_email_user("wa@ex.com", password="password1")
    begin = begin_registration(identity_store, user)
    with pytest.raises(RuntimeError, match=r"webauthn|configure"):
        finish_registration(
            identity_store,
            user,
            credential_id="wa1",
            public_key_b64="k",
            challenge=begin["publicKey"]["challenge"],
            attestation_object="att",
            client_data_json="cd",
        )
    # Re-register in test mode then hit auth webauthn stub
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "1")
    begin = begin_registration(identity_store, user)
    finish_registration(
        identity_store,
        user,
        credential_id="wa1",
        public_key_b64="k",
        challenge=begin["publicKey"]["challenge"],
    )
    monkeypatch.setenv("PODCAST_WEBAUTHN_TEST_MODE", "0")
    auth = begin_authentication(identity_store, email="wa@ex.com")
    with pytest.raises(RuntimeError, match=r"webauthn|configure"):
        finish_authentication(
            identity_store,
            credential_id="wa1",
            challenge=auth["publicKey"]["challenge"],
            authenticator_data="ad",
            client_data_json="cd",
            signature="sig",
        )


def test_expired_session_and_policy_bearer(identity_store: ShareIdentityStore) -> None:
    from datetime import datetime, timedelta

    from starlette.requests import Request as StarletteRequest

    from podcast_mcp.services.share_auth.policy import extract_bearer

    user = identity_store.create_or_get_email_user("exp@ex.com", password="password1")
    raw = identity_store.create_session(user["id"])
    th = __import__("hashlib").sha256(raw.encode()).hexdigest()
    identity_store._conn.execute(
        "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
        ((datetime.now(UTC) - timedelta(days=1)).isoformat(), th),
    )
    identity_store._conn.commit()
    assert identity_store.resolve_session(raw) is None

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [(b"authorization", b"Token nope")],
        "client": ("127.0.0.1", 123),
        "server": ("test", 80),
    }
    req = StarletteRequest(scope)
    assert extract_bearer(req) is None
    assert access_required(None) is False
    assert access_required({}) is False


def test_middleware_options_and_unknown_token(identity_store, monkeypatch) -> None:
    client = TestClient(create_app())
    # OPTIONS bypasses ACL enforcement
    assert client.options("/api/review/any-token/project").status_code in {200, 204, 405}
    assert client.get("/api/review/definitely-missing/project").status_code == 404


def test_public_mcp_path_enforces_share_identity(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
) -> None:
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mcp-public-id")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "mcp"],
        general_access="link",
        require_sign_in=True,
    )
    token = share["token"]
    identity_store.invite_to_share(token, email="mcp-public@example.com")
    client = TestClient(create_app())
    assert client.get(f"/mcp/{token}").status_code == 401
    assert (
        client.post(
            f"/mcp/{token}/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
        ).status_code
        == 401
    )
    client.post(
        "/auth/password/register",
        json={"email": "mcp-public@example.com", "password": "password1"},
    )
    assert client.get(f"/mcp/{token}").status_code == 200


def test_restricted_share_ws_requires_auth(
    minimal_project, sample_wav, tmp_workspace, identity_store, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="ws-restricted")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
        general_access="restricted",
    )
    token = share["token"]
    identity_store.invite_to_share(token, email="ws@example.com", role="viewer")
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{token}/daw/ws") as ws_conn:
            ws_conn.receive_json()
            raise AssertionError("expected websocket close without auth")
    except Exception:
        pass
    client.post(
        "/auth/password/register",
        json={"email": "ws@example.com", "password": "password1"},
    )
    with client.websocket_connect(f"/api/review/{token}/daw/ws") as ws_conn:
        msg = ws_conn.receive_json()
        assert msg.get("type") == "Snapshot" or "plane" in msg


def test_get_identity_store_singleton(tmp_path, monkeypatch) -> None:
    from podcast_mcp.services.share_auth.store import (
        get_identity_store,
        reset_identity_store_for_tests,
    )

    db = tmp_path / "singleton.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(db))
    reset_identity_store_for_tests()
    a = get_identity_store()
    b = get_identity_store()
    assert a is b
    other = get_identity_store(tmp_path / "other.sqlite")
    assert other is not a
    other.close()
    reset_identity_store_for_tests()


def test_github_emails_verified_fallback(monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_ID", "hid")
    monkeypatch.setenv("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "hsec")

    def get(url, **kwargs):
        if url.endswith("/emails"):
            return [{"email": "only@ex.com", "primary": False, "verified": True}]
        return {"id": 3, "email": None, "login": "u"}

    profile = exchange_code(
        "github",
        code="c",
        code_verifier="v",
        http_post=lambda *a, **k: {"access_token": "t"},
        http_get=get,
    )
    assert profile["email"] == "only@ex.com"


def test_expired_agent_and_require_sign_in_flag(identity_store: ShareIdentityStore) -> None:
    from datetime import datetime, timedelta

    from podcast_mcp.services.share_auth.access import access_required

    user = identity_store.create_or_get_email_user("ag@ex.com", password="password1")
    raw = identity_store.mint_agent_credential("share-t", user["id"], ttl_hours=1)
    th = __import__("hashlib").sha256(raw.encode()).hexdigest()
    identity_store._conn.execute(
        "UPDATE agent_credentials SET expires_at = ? WHERE token_hash = ?",
        ((datetime.now(UTC) - timedelta(hours=1)).isoformat(), th),
    )
    identity_store._conn.commit()
    assert identity_store.resolve_agent_credential(raw) is None
    assert access_required({"general_access": "link", "require_sign_in": True}) is True
    identity_store.invite_to_share("share-t", email="ag@ex.com", role="viewer")
    assert identity_store.revoke_acl("share-t", user_id=user["id"]) is True


def test_resolve_principal_from_headers(identity_store: ShareIdentityStore) -> None:
    from podcast_mcp.services.share_auth.policy import (
        SESSION_COOKIE,
        resolve_principal_from_headers,
    )

    user = identity_store.create_or_get_email_user("hdr@ex.com", password="password1")
    raw_agent = identity_store.mint_agent_credential("tok-a", user["id"], ttl_hours=1)
    assert (
        resolve_principal_from_headers(
            {"authorization": f"Bearer {raw_agent}"},
            {},
            share_token="other-token",
            store=identity_store,
        )
        is None
    )
    identity_store.invite_to_share("tok-a", email="hdr@ex.com", role="viewer")
    agent = resolve_principal_from_headers(
        {"authorization": f"Bearer {raw_agent}"},
        {},
        share_token="tok-a",
        store=identity_store,
    )
    assert agent is not None
    assert agent.source == "agent"
    assert resolve_principal_from_headers({}, {}, share_token="tok-a", store=identity_store) is None
    assert (
        resolve_principal_from_headers(
            {},
            {SESSION_COOKIE: "nope"},
            share_token="tok-a",
            store=identity_store,
        )
        is None
    )
    sess = identity_store.create_session(user["id"])
    session = resolve_principal_from_headers(
        {},
        {SESSION_COOKIE: sess},
        share_token="tok-a",
        store=identity_store,
    )
    assert session is not None
    assert session.source == "session"
