"""Guest's-eye CORS check for object-store media (#1759)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.media import object_store_cors as cors
from podcast_mcp.util.object_store import ObjectStoreConfig
from test_review_share import _seed_premix, _seed_track_for_proxy

ORIGIN = "https://share.example.test"
URL = "https://object-store.example.test/proxy/host/h/00000.mp3?sig=1"


def _headers(**h: str):
    return lambda url, origin: {k.lower().replace("_", "-"): v for k, v in h.items()}


def test_probe_ok_when_origin_allowed() -> None:
    probe = cors.probe_guest_cors(URL, ORIGIN, fetch=_headers(Access_Control_Allow_Origin=ORIGIN))
    assert probe.status == "ok"


def test_probe_ok_for_wildcard() -> None:
    assert (
        cors.probe_guest_cors(URL, ORIGIN, fetch=_headers(Access_Control_Allow_Origin="*")).status
        == "ok"
    )


def test_probe_blocked_without_header() -> None:
    probe = cors.probe_guest_cors(URL, ORIGIN, fetch=_headers(Content_Type="audio/mpeg"))
    assert probe.blocked
    assert "no Access-Control-Allow-Origin" in probe.detail


def test_probe_blocked_for_other_origin() -> None:
    probe = cors.probe_guest_cors(
        URL, ORIGIN, fetch=_headers(Access_Control_Allow_Origin="https://other.example.test")
    )
    assert probe.blocked


def test_probe_unknown_when_store_unreachable() -> None:
    assert cors.probe_guest_cors(URL, ORIGIN, fetch=lambda u, o: None).status == "unknown"


def test_cached_probe_asks_the_store_once_per_host_and_origin() -> None:
    calls: list[str] = []

    def fetch(url: str, origin: str):
        calls.append(url)
        return {}

    t = [0.0]
    for _ in range(3):
        cors.cached_guest_cors(URL, ORIGIN, fetch=fetch, now=lambda: t[0])
    assert len(calls) == 1
    t[0] = 1000.0
    cors.cached_guest_cors(URL, ORIGIN, fetch=fetch, now=lambda: t[0])
    assert len(calls) == 2


def test_rule_and_message_name_the_origin() -> None:
    rule = cors.cors_rule(ORIGIN)
    assert rule[0]["AllowedOrigins"] == [ORIGIN]
    assert rule[0]["AllowedMethods"] == ["GET", "HEAD"]
    assert ORIGIN in cors.cors_blocked_message(ORIGIN)


def _store(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )

    class _Fake:
        def upload_fileobj(self, source, *a, **k):
            return None

        def presigned_get_url(self, object_key, *, expires_in):
            return f"https://object-store.example.test/{object_key}?e={expires_in}"

        def delete_object(self, *a, **k):
            return None

    for mod in ("proxy_media", "review_media"):
        monkeypatch.setattr(
            f"podcast_mcp.services.media.{mod}.load_object_store_config",
            lambda config_path=None: cfg,
        )
        monkeypatch.setattr(
            f"podcast_mcp.services.media.{mod}.ObjectStoreClient", lambda _cfg: _Fake()
        )
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.share_page.share_public_origin",
        lambda request_base=None: ORIGIN,
    )


def _share(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="Cors")
    return ShareService(ws).create(review_version_id=ver["id"], capabilities=["play", "view"])


def test_manifest_serves_chunks_through_the_share_when_the_bucket_blocks_guests(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    _store(monkeypatch)
    monkeypatch.setattr(cors, "_fetch_headers", lambda url, origin: {})
    share = _share(minimal_project, sample_wav)
    body = TestClient(create_app()).get(f"/api/review/{share['token']}/daw/proxy/manifest").json()
    urls = body["tracks"]["host"]["urls"]
    assert urls[0].startswith(f"/api/review/{share['token']}/daw/proxy/host/")
    assert body["object_store_cors"] == {"status": "blocked", "origin": ORIGIN}
    assert len(urls) == body["tracks"]["host"]["chunk_count"]


def test_manifest_keeps_bucket_urls_when_cors_is_in_place(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    _store(monkeypatch)
    monkeypatch.setattr(
        cors, "_fetch_headers", lambda url, origin: {"access-control-allow-origin": origin}
    )
    share = _share(minimal_project, sample_wav)
    body = TestClient(create_app()).get(f"/api/review/{share['token']}/daw/proxy/manifest").json()
    assert body["tracks"]["host"]["urls"][0].startswith("https://object-store.example.test/")
    assert "object_store_cors" not in body


def test_create_warns_the_host_when_the_bucket_blocks_guests(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    _store(monkeypatch)
    monkeypatch.setattr(cors, "_fetch_headers", lambda url, origin: {})
    share = _share(minimal_project, sample_wav)
    (warning,) = share["warnings"]
    assert warning["code"] == "object_store_cors"
    assert warning["origin"] == ORIGIN
    assert warning["rule"][0]["AllowedOrigins"] == [ORIGIN]
    assert ORIGIN in warning["message"]


def test_create_has_no_warning_when_cors_is_in_place_or_unknown(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    _store(monkeypatch)
    share = _share(minimal_project, sample_wav)  # probe answers "unknown" in tests
    assert "warnings" not in share


def _raise_http(code: int, headers: dict[str, str]):
    import email.message
    import urllib.error

    msg = email.message.Message()
    for k, v in headers.items():
        msg[k] = v

    def urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, code, "x", msg, None)

    return urlopen


@pytest.mark.parametrize("code", [429, 502, 503])
def test_gateway_errors_are_unknown_not_blocked(monkeypatch, code) -> None:
    monkeypatch.undo()  # conftest stubs _fetch_headers; exercise the real one
    monkeypatch.setattr("urllib.request.urlopen", _raise_http(code, {}))
    assert cors.probe_guest_cors(URL, ORIGIN).status == "unknown"


def test_forbidden_without_cors_header_is_blocked_and_with_it_ok(monkeypatch) -> None:
    monkeypatch.undo()
    monkeypatch.setattr("urllib.request.urlopen", _raise_http(403, {}))
    assert cors.probe_guest_cors(URL, ORIGIN).blocked
    monkeypatch.setattr(
        "urllib.request.urlopen", _raise_http(403, {"Access-Control-Allow-Origin": ORIGIN})
    )
    assert cors.probe_guest_cors(URL, ORIGIN).status == "ok"


def test_cached_probe_keeps_a_failure_for_a_shorter_time_than_a_success() -> None:
    ok_calls: list[str] = []
    blocked_calls: list[str] = []

    def ok(url: str, origin: str):
        ok_calls.append(url)
        return {"access-control-allow-origin": "*"}

    def blocked(url: str, origin: str):
        blocked_calls.append(url)
        return {}

    ok_url = "https://ok.example.test/a"
    blocked_url = "https://blocked.example.test/a"
    t = [0.0]

    def now() -> float:
        return t[0]

    for _ in range(2):
        cors.cached_guest_cors(ok_url, ORIGIN, fetch=ok, now=now)
        cors.cached_guest_cors(blocked_url, ORIGIN, fetch=blocked, now=now)
    assert (len(ok_calls), len(blocked_calls)) == (1, 1)

    t[0] = cors._FAIL_TTL_SEC + 0.1
    cors.cached_guest_cors(ok_url, ORIGIN, fetch=ok, now=now)
    cors.cached_guest_cors(blocked_url, ORIGIN, fetch=blocked, now=now)
    assert (len(ok_calls), len(blocked_calls)) == (1, 2)


def test_clear_cors_cache_forces_a_new_probe() -> None:
    calls: list[str] = []

    def fetch(url: str, origin: str):
        calls.append(url)
        return {}

    cors.cached_guest_cors(URL, ORIGIN, fetch=fetch)
    cors.clear_cors_cache()
    cors.cached_guest_cors(URL, ORIGIN, fetch=fetch)
    assert len(calls) == 2
