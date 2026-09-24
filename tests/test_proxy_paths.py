"""Unit tests for relay→host proxy path sanitization."""

from __future__ import annotations

import posixpath
import random

import pytest

from podcast_mcp.services.tunnel import _PATH_PREFIXES, _map_local_path
from podcast_mcp.util.proxy_paths import (
    UnsafeProxyPath,
    assert_allowed_local_gui_path,
    assert_safe_proxy_path,
    is_allowed_local_gui_path,
    proxy_path_is_safe,
)

_HOST_ONLY_APIS = ("/api/export", "/api/pipeline", "/api/diagnostics")


def _is_guest_route(path: str, token: str) -> bool:
    """Independent expected route roots, separate from the production validator."""
    roots = (
        "/assets",
        "/favicon.svg",
        "/favicon.ico",
        f"/r/{token}",
        f"/rec/{token}",
        f"/api/review/{token}",
        f"/api/rec/{token}",
        f"/mcp/{token}",
    )
    return any(path == root or path.startswith(root + "/") for root in roots)


@pytest.mark.parametrize("host_path", ["/api/project", "/api/session", "/api/shares"])
def test_guest_route_oracle_rejects_other_host_apis(host_path: str):
    assert not _is_guest_route(host_path, "test-token")


def _relay_suffixes() -> list[str]:
    """Build a reproducible mix of ordinary and adversarial relay suffixes."""
    rng = random.Random(247)
    parts = (
        "daw",
        "project",
        "assets/app.js",
        "upload",
        "mcp",
        "",
        ".",
        "..",
        "%2e%2E",
        "%252e%252e",
        "%2E.",
        ".%2e",
        "//",
        ";api/export",
        "?next=/api/pipeline",
        "api/diagnostics",
        "../api/export",
    )
    relay_prefixes = [prefix for prefix, _ in _PATH_PREFIXES]
    suffixes = [prefix + part for prefix in relay_prefixes for part in parts]
    for prefix in relay_prefixes:
        for _ in range(100):
            suffixes.append(prefix + "/".join(rng.choices(parts, k=rng.randint(1, 4))))
    return suffixes


@pytest.mark.parametrize("suffix", _relay_suffixes())
def test_relay_mapping_preserves_guest_path_allowlist(suffix: str):
    """Every mapped path remains guest-scoped, including mixed encodings."""
    token = "test-token"
    try:
        mapped = _map_local_path(suffix, token)
    except UnsafeProxyPath:
        return

    assert is_allowed_local_gui_path(mapped, token), (suffix, mapped)
    normalized = posixpath.normpath(mapped.split("?", 1)[0])
    assert _is_guest_route(normalized, token), (suffix, mapped)
    assert all(
        normalized != host_api and not normalized.startswith(host_api + "/")
        for host_api in _HOST_ONLY_APIS
    ), (suffix, mapped)


@pytest.mark.parametrize(
    "suffix",
    [
        "r/../api/export",
        "rec/%2e%2E/api/pipeline",
        "api/review/%252e%252e/api/export",
        "api/rec/.%2e/api/diagnostics",
        "mcp/%2E./api/export",
    ],
)
def test_relay_mapping_rejects_named_traversal_forms(suffix: str):
    with pytest.raises(UnsafeProxyPath):
        _map_local_path(suffix, "test-token")


def test_proxy_path_rejects_dotdot_and_encoded():
    assert proxy_path_is_safe("api/review/daw/meta")
    assert not proxy_path_is_safe("r/assets/../../api/x")
    assert not proxy_path_is_safe("r/assets/%2e%2e/api/x")
    assert not proxy_path_is_safe("/absolute")
    assert not proxy_path_is_safe("")
    assert not proxy_path_is_safe("r/assets\\x")
    assert not proxy_path_is_safe("r/\x00evil")


def test_allowed_local_paths():
    assert is_allowed_local_gui_path("/assets/app.js", "tok")
    assert is_allowed_local_gui_path("assets/app.js", "tok")  # relative → absolute
    assert is_allowed_local_gui_path("/favicon.svg", "tok")
    assert is_allowed_local_gui_path("/r/tok/daw", "tok")
    assert is_allowed_local_gui_path("/api/review/tok/project", "tok")
    assert is_allowed_local_gui_path("/mcp/tok/mcp", "tok")
    assert not is_allowed_local_gui_path("/api/pipeline/run", "tok")
    assert not is_allowed_local_gui_path("/api/diagnostics/bundle", "tok")
    # #219: host export jobs are never proxied to guests.
    assert not is_allowed_local_gui_path("/api/export/bounce", "tok")
    assert not is_allowed_local_gui_path("/api/export/deliverables", "tok")
    assert not is_allowed_local_gui_path("/api/review/other/project", "tok")
    assert not is_allowed_local_gui_path("/assets/../../api/x", "tok")
    assert not is_allowed_local_gui_path("/r/tok", "")


def test_allowed_local_paths_rec():
    assert is_allowed_local_gui_path("/rec/tok", "tok")
    assert is_allowed_local_gui_path("/rec/tok/index", "tok")
    assert is_allowed_local_gui_path("/api/rec/tok/bootstrap", "tok")
    assert not is_allowed_local_gui_path("/rec/othertoken", "tok")
    assert not is_allowed_local_gui_path("/rec/tok/../x", "tok")
    assert not is_allowed_local_gui_path("/api/rec/tok%2e%2e", "tok")


def test_assert_allowed_normalizes_and_rejects_escape():
    assert assert_allowed_local_gui_path("/assets/foo", "tok") == "/assets/foo"
    assert assert_allowed_local_gui_path("assets/foo", "tok") == "/assets/foo"
    with pytest.raises(UnsafeProxyPath):
        assert_allowed_local_gui_path("/assets/../../api/project", "tok")
    with pytest.raises(UnsafeProxyPath):
        assert_safe_proxy_path("r/../x")


def test_env_max_bytes_and_content_length(monkeypatch):
    from starlette.requests import Request

    from podcast_mcp.util.body_limits import (
        content_length_too_large,
        env_max_bytes,
    )

    monkeypatch.delenv("PODCAST_X_BYTES", raising=False)
    assert env_max_bytes("PODCAST_X_BYTES", 9) == 9
    monkeypatch.setenv("PODCAST_X_BYTES", "bad")
    assert env_max_bytes("PODCAST_X_BYTES", 9) == 9

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [(b"content-length", b"nope")],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 80),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    req = Request(scope, receive)
    assert content_length_too_large(req, 10) is True


def test_tokens_match_and_share_authz(monkeypatch):
    from podcast_mcp.services.session_sync import authz as az

    assert az._tokens_match("a", "a")
    assert not az._tokens_match("a", "ab")
    assert not az._tokens_match(None, "a")

    def _boom(a, b):
        raise TypeError("boom")

    monkeypatch.setattr(az.secrets, "compare_digest", _boom)
    assert not az._tokens_match("a", "a")

    bad = az.authorize_share_token(token=None, expected_token="x")
    assert not bad.allowed


def test_share_authz_digest_ok():
    from podcast_mcp.services.session_sync.authz import authorize_share_token

    bad2 = authorize_share_token(token="a", expected_token="b")
    assert not bad2.allowed
    ok = authorize_share_token(token="same", expected_token="same")
    assert ok.allowed
