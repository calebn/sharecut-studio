"""``GET /api/host-mcp/activity``: when an app last used the host ``/mcp`` address."""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import podcast_mcp.gui.host_mcp as host_mcp
from host_session_helpers import UNTRUSTED, exchange, untrusted_app
from podcast_mcp.gui.host_mcp import HOST_MCP_PATH, HostMcpActivity
from podcast_mcp.gui.server import create_app
from test_host_mcp_http import (
    HANDSHAKE_VERSION,
    LOOPBACK_HOST,
    MCP_ACCEPT,
    _initialize,
    _post_mcp,
    _rpc_payload,
)

ROUTE = "/api/host-mcp/activity"
INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": HANDSHAKE_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "t", "version": "0"},
    },
}
KEYS = {"mounted", "last_request_at", "age_seconds"}


def _activity(client: TestClient):
    res = client.get(ROUTE)
    assert res.status_code == 200, res.text
    return res.json()


def test_unused_then_used_after_a_valid_post() -> None:
    with TestClient(create_app()) as client:
        assert _activity(client) == {"mounted": True, "last_request_at": None, "age_seconds": None}
        _initialize(client)
        body = _activity(client)
        assert body["mounted"] is True
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", body["last_request_at"])
        assert isinstance(body["age_seconds"], int) and 0 <= body["age_seconds"] < 5


def test_route_response_is_exact_and_not_cached() -> None:
    with TestClient(create_app()) as client:
        _initialize(client)
        res = client.get(ROUTE)
        assert set(res.json()) == KEYS
        assert res.headers["cache-control"] == "no-store"


def test_get_of_the_route_does_not_touch_the_stamp() -> None:
    with TestClient(create_app()) as client:
        client.get(ROUTE)
        assert _activity(client)["last_request_at"] is None


def test_rejected_requests_do_not_count() -> None:
    with TestClient(create_app()) as client:
        assert (
            _post_mcp(client, INIT, extra_headers={"Origin": "https://evil.example"}).status_code
            == 403
        )
        assert (
            client.post(
                HOST_MCP_PATH,
                json=INIT,
                headers={
                    "Accept": MCP_ACCEPT,
                    "Content-Type": "application/json",
                    "Host": "evil.example",
                },
            ).status_code
            == 421
        )
        assert _post_mcp(client, INIT, accept="application/json").status_code == 406
        for method in ("get", "head"):
            assert getattr(client, method)(HOST_MCP_PATH, headers=LOOPBACK_HOST).status_code == 405
        assert _activity(client)["last_request_at"] is None


def test_notification_202_counts() -> None:
    with TestClient(create_app()) as client:
        res = _post_mcp(
            client, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        )
        assert res.status_code == 202
        assert _activity(client)["last_request_at"] is not None


def test_tool_error_result_http_200_counts() -> None:
    with TestClient(create_app(served_project=None)) as client:
        res = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "list_comments_tool", "arguments": {}},
            },
        )
        assert res.status_code == 200
        assert _rpc_payload(res)["result"]["isError"] is True
        assert _activity(client)["last_request_at"] is not None


def test_streamed_call_touches_at_start_and_at_finish() -> None:
    app = create_app()
    touches: list[str] = []
    app.state.host_mcp_activity.touch = lambda: touches.append("t")  # type: ignore[method-assign]
    events: list[str] = []

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        events.append("started")
        assert touches == ["t"]
        await send({"type": "http.response.body", "body": b"x", "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    import asyncio

    wrapper = host_mcp._BindRequestApp(app, inner)
    asyncio.run(wrapper({"type": "http"}, None, send))
    assert touches == ["t", "t"]
    assert [m["type"] for m in sent] == [
        "http.response.start",
        "http.response.body",
        "http.response.body",
    ]
    assert sent[1] == {"type": "http.response.body", "body": b"x", "more_body": True}


def test_wrapper_does_not_count_non_2xx_and_keeps_inner_error() -> None:
    app = create_app()
    touches: list[str] = []
    app.state.host_mcp_activity.touch = lambda: touches.append("t")  # type: ignore[method-assign]

    async def rejected(scope, receive, send):
        await send({"type": "http.response.start", "status": 403, "headers": []})

    async def boom(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        raise RuntimeError("inner failure")

    async def send(message):
        return None

    import asyncio

    asyncio.run(host_mcp._BindRequestApp(app, rejected)({"type": "http"}, None, send))
    assert touches == []
    with pytest.raises(RuntimeError, match="inner failure"):
        asyncio.run(host_mcp._BindRequestApp(app, boom)({"type": "http"}, None, send))
    assert touches == ["t", "t"]


def test_age_is_monotonic_and_ignores_wall_clock_jumps(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"mono": 1000.0, "wall": 1_800_000_000.0}
    monkeypatch.setattr(host_mcp.time, "monotonic", lambda: clock["mono"])
    monkeypatch.setattr(host_mcp.time, "time", lambda: clock["wall"])
    with TestClient(create_app()) as client:
        _initialize(client)
        first = _activity(client)
        assert first["age_seconds"] == 0
        clock["mono"] += 90.9
        second = _activity(client)
        assert second["age_seconds"] == 90
        assert second["last_request_at"] == first["last_request_at"]
        clock["wall"] -= 86_400 * 3  # wall clock jumps back three days
        third = _activity(client)
        assert third["age_seconds"] == 90
        assert third["last_request_at"] == first["last_request_at"]


def test_route_is_bound_to_the_loopback_host_and_origin() -> None:
    with TestClient(create_app()) as client:
        bad_origin = client.get(
            ROUTE, headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"}
        )
        assert bad_origin.status_code == 403
        bad_host = client.get(ROUTE, headers={"Host": "evil.example"})
        assert bad_host.status_code == 400
        assert client.get(ROUTE, headers={"Host": "127.0.0.1:8765"}).status_code == 200


@pytest.mark.parametrize(
    ("status", "counts"),
    [
        (101, False),
        (200, True),
        (202, True),
        (204, True),
        (299, True),
        (300, False),
        (301, False),
        (304, False),
        (399, False),
        (400, False),
        (500, False),
    ],
)
def test_wrapper_counts_exactly_the_2xx_statuses(status: int, counts: bool) -> None:
    import asyncio

    app = create_app()
    touches: list[str] = []
    app.state.host_mcp_activity.touch = lambda: touches.append("t")  # type: ignore[method-assign]

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": status, "headers": []})

    async def send(message):
        return None

    asyncio.run(host_mcp._BindRequestApp(app, inner)({"type": "http"}, None, send))
    assert (len(touches) == 2) is counts
    assert len(touches) in ((2,) if counts else (0,))


def test_each_app_keeps_its_own_activity() -> None:
    app_a, app_b = create_app(), create_app()
    assert app_a.state.host_mcp_activity is not app_b.state.host_mcp_activity
    with TestClient(app_a) as a, TestClient(app_b) as b:
        _initialize(a)
        assert _activity(a)["last_request_at"] is not None
        assert _activity(b)["last_request_at"] is None


def test_activity_object_holds_only_the_two_numbers() -> None:
    activity = HostMcpActivity()
    assert vars(activity) == {"_stamp": None}
    activity.touch()
    stamp = vars(activity)["_stamp"]
    assert len(stamp) == 2 and all(isinstance(v, float) for v in stamp)
    assert set(vars(activity)) == {"_stamp"}


def test_off_loopback_bind_reports_not_mounted() -> None:
    with TestClient(create_app(bind_host="0.0.0.0")) as client:
        assert _activity(client) == {"mounted": False, "last_request_at": None, "age_seconds": None}
        assert client.app.state.host_mcp_activity is None
        assert not any(getattr(r, "path", None) == HOST_MCP_PATH for r in client.app.routes)


def test_relayed_request_is_refused() -> None:
    with TestClient(create_app()) as client:
        res = client.get(ROUTE, headers={"x-sharecut-relayed": "1"})
        assert res.status_code == 403


def test_remote_peer_is_refused_under_strict_authz(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "s3cret-token")
    with TestClient(create_app(), client=("203.0.113.9", 50000)) as client:
        assert client.get(ROUTE).status_code == 403
        ok = client.get(ROUTE, headers={"X-Podcast-Token": "s3cret-token"})
        assert ok.status_code == 200


def test_untrusted_loopback_platform_needs_the_owner_cookie(
    host, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "s3cret-token")
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    host(UNTRUSTED)
    app = untrusted_app()
    client = TestClient(app, client=("127.0.0.1", 50000))
    denied = client.get(ROUTE)
    assert denied.status_code == 403
    exchange(client, app)
    ok = client.get(ROUTE)
    assert ok.status_code == 200
    assert ok.json() == {"mounted": False, "last_request_at": None, "age_seconds": None}


def test_readers_and_posts_in_threads_do_not_raise() -> None:
    with TestClient(create_app()) as client:
        _initialize(client)

        def read(_: int) -> int:
            return client.get(ROUTE).status_code

        def post(_: int) -> int:
            return _post_mcp(client, INIT).status_code

        with ThreadPoolExecutor(max_workers=8) as pool:
            reads = [pool.submit(read, i) for i in range(24)]
            posts = [pool.submit(post, i) for i in range(8)]
            assert {f.result() for f in reads} == {200}
            assert {f.result() for f in posts} == {200}
