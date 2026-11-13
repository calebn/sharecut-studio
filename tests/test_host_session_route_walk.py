"""No owner route answers without a session on a host whose loopback is not trusted (#3810).

``test_host_credential_structure`` reads only ``src/podcast_mcp/gui/``, so a router an extension
mounts from outside it could read a token by hand and pass. This test builds the real app, with
the extensions loaded as in production, walks its live route table and sends every route a
request that carries no cookie. A route that is not on the allowlist below must refuse it.

Telling a refusal by authorization from a failure of validation: FastAPI answers 422 before a
handler runs when a required parameter is missing, so a bare 401/403 is only the authorization
answer once the request is valid. ``refusal_of`` therefore reads each 422 body, fills the
parameters it names, and sends again until the route answers with something other than 422.
Authorization must then say 401 or 403. A route that still says 422 after that fails the test.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fastapi import routing as fastapi_routing
from fastapi.testclient import TestClient
from starlette.routing import BaseRoute, Mount
from starlette.routing import Route as StarletteRoute
from starlette.routing import WebSocketRoute as StarletteWebSocketRoute
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from host_session_helpers import LOOPBACK_PEER, OWNER_TOKEN, untrusted_app
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.util.host_platform import IOS, MACOS, UNKNOWN
from podcast_mcp.util.host_session_wire import EXCHANGE_PATH, SESSION_COOKIE

SHELL = "<!doctype html><title>shell</title><div id=root></div>"
FAVICON = "<svg xmlns='http://www.w3.org/2000/svg'/>"
EPISODE = "Quarterly Secrets Episode"
ASSET = "console.log(1)"
ROWS = pytest.mark.parametrize("row", [IOS, UNKNOWN], ids=["ios", "unknown"])
REFUSED = {401, 403}
OWNER_REFUSAL_CLOSE = 4403
PLACEHOLDER = "x"

# Each route below answers a caller with no session by design. Everything else must refuse.
# The guest prefixes are keyed by a share token in the path, whose lookup is their credential;
# the rest answer one fixed, project-free body, pinned in ``test_the_allowlisted_routes_*``.
ALLOWED_ROUTES = {
    # The exchange trades the engine's single-use code for the session; with no valid code it is a 403.
    ("GET", EXCHANGE_PATH),
    # The shell's launch probe, and it is gated by the boot token, not by the owner credential.
    ("GET", "/api/health"),
    # A fixed list of pipeline step names: it reads no project and no setting.
    ("GET", "/api/pipeline/steps"),
    # The extension manifest: an api version and feature ids, nothing about any project.
    ("GET", "/api/features"),
    # The static shell and its icons carry no project; the page names an episode only to a session.
    ("GET", "/"),
    ("GET", "/favicon.svg"),
    ("GET", "/favicon.ico"),
}
ALLOWED_PREFIXES = (
    "/assets",  # the static bundle's immutable files
    "/api/review/",  # review share guests, keyed by the share token
    "/api/rec/",  # record share guests, keyed by the share token
    "/r/",  # the review share page, keyed by the share token
    "/rec/",  # the record share page, keyed by the share token
    "/mcp/",  # a guest's remote MCP endpoint, keyed by the share token
)
# A document command's body is a union of command types, which no placeholder can guess and whose
# errors name the variant in the field's location.
STARTING_BODIES: dict[tuple[str, str], dict[str, Any]] = {
    ("POST", "/api/document/command"): {
        "type": "ApproveEdits",
        "payload": {"ids": [PLACEHOLDER]},
        "client_id": PLACEHOLDER,
        "client_seq": 1,
    },
}
GUEST_SHELLS = {("GET", "/r/{token}"), ("GET", "/rec/{token}")}


@dataclass(frozen=True)
class Walked:
    kind: str
    path: str
    methods: tuple[str, ...]
    route: BaseRoute | None = field(default=None, compare=False)


@pytest.fixture(autouse=True)
def cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", OWNER_TOKEN)


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    root = tmp_path / "static"
    (root / "assets").mkdir(parents=True)
    (root / "assets" / "app.js").write_text(ASSET, encoding="utf-8")
    (root / "index.html").write_text(SHELL, encoding="utf-8")
    (root / "favicon.svg").write_text(FAVICON, encoding="utf-8")
    return root


@pytest.fixture
def named_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.meta.name = EPISODE
    save_project(project, minimal_project)
    return minimal_project


def walk(routes: list[BaseRoute], context: Any = None, prefix: str = "") -> Iterator[Walked]:
    """Every HTTP route, socket route and mount of *routes*, through included routers and mounts.

    FastAPI keeps an included router's routes unflattened, each with the prefix of the
    inclusion that put it there. A route type this does not know raises, so a new kind of
    route cannot be skipped unseen.
    """
    for route in routes:
        if isinstance(route, fastapi_routing._IncludedRouter):
            inner = context.combine(route.include_context) if context else route.include_context
            yield from walk(route.original_router.routes, inner, prefix)
        else:
            path = context.path_for(route) if context else getattr(route, "path", "")
            yield from _leaf(route, prefix + path)


def _leaf(route: BaseRoute, path: str) -> Iterator[Walked]:
    if isinstance(route, Mount):
        yield Walked("mount", path, (), route)
        yield from walk(list(route.routes), None, path)
    elif isinstance(route, fastapi_routing.APIWebSocketRoute | StarletteWebSocketRoute):
        yield Walked("websocket", path, (), route)
    elif isinstance(route, fastapi_routing.APIRoute | StarletteRoute):
        methods = sorted((route.methods or set()) - {"HEAD", "OPTIONS"})
        yield Walked("http", path, tuple(methods), route)
    else:
        raise AssertionError(f"the route walk does not know {type(route).__name__} at {path}")


def is_allowed(entry: Walked, method: str | None) -> bool:
    if entry.path.startswith(ALLOWED_PREFIXES):
        return True
    return method is not None and (method, entry.path) in ALLOWED_ROUTES


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]*\}", PLACEHOLDER, path)


def _candidates(name: str, tried: dict[str, int]) -> str:
    values = (PLACEHOLDER, "1", "true", "1.5")
    index = tried.get(name, -1) + 1
    tried[name] = index
    return values[min(index, len(values) - 1)]


def _fill(errors: list[dict[str, Any]], query: dict[str, str], body: dict[str, Any]) -> bool:
    """Name the parameters a 422 asks for; False when it asks for nothing this can supply."""
    tried: dict[str, int] = body.setdefault("__tried", {})
    progressed = False
    for error in errors:
        location = error.get("loc") or []
        if location[:1] == ["query"] and len(location) == 2:
            query[str(location[1])] = _candidates("q:" + str(location[1]), tried)
            progressed = True
        elif location[:1] == ["body"] and len(location) >= 2:
            target = body
            for key in location[1:-1]:
                if not isinstance(key, str):
                    break
                target = target.setdefault(key, {})
            else:
                last = location[-1]
                if isinstance(last, str):
                    target[last] = _candidates("b:" + ".".join(map(str, location)), tried)
                    progressed = True
    return progressed


def refusal_of(
    client: TestClient, method: str, url: str, template: str | None = None, **extra: Any
) -> tuple[int, int]:
    """The status an unauthenticated *method* *url* settles on, and how many 422s came first."""
    query: dict[str, str] = {}
    body: dict[str, Any] = dict(STARTING_BODIES.get((method, template or url), {}))
    validations = 0
    for _ in range(12):
        payload = {k: v for k, v in body.items() if k != "__tried"}
        response = client.request(
            method,
            url,
            params=query,
            json=payload if method in {"POST", "PUT", "PATCH"} else None,
            **extra,
        )
        if response.status_code != 422:
            return response.status_code, validations
        validations += 1
        try:
            errors = json.loads(response.text)["detail"]
        except (ValueError, KeyError, TypeError):
            return 422, validations
        if not isinstance(errors, list) or not _fill(errors, query, body):
            return 422, validations
    return 422, validations


def refusal_of_socket(client: TestClient, entry: Walked) -> int:
    """The close code (or the HTTP denial status) of a socket opened with no session."""
    dependant = getattr(entry.route, "dependant", None)
    required = [
        q.alias for q in (dependant.query_params if dependant else []) if q.field_info.is_required()
    ]
    url = concrete(entry.path) + "?" + "&".join(f"{name}={PLACEHOLDER}" for name in required)
    try:
        with client.websocket_connect(url):
            return 101
    except WebSocketDisconnect as closed:
        return closed.code
    except WebSocketDenialResponse as denied:
        return denied.status_code


def _routes_of(app: Any) -> list[Walked]:
    return list(walk(list(app.router.routes)))


def answers_without_a_session(app: Any) -> tuple[list[str], list[str]]:
    """The routes off the allowlist that were tried, and those that did not refuse as they must."""
    client = TestClient(app, client=LOOPBACK_PEER)
    token_header = {"X-Podcast-Token": OWNER_TOKEN}
    checked: list[str] = []
    wrong: list[str] = []

    for entry in _routes_of(app):
        if entry.kind == "http":
            for method in entry.methods:
                if is_allowed(entry, method):
                    continue
                url = concrete(entry.path)
                status, _ = refusal_of(client, method, url, entry.path)
                with_token, _ = refusal_of(client, method, url, entry.path, headers=token_header)
                checked.append(f"{method} {entry.path}")
                if status not in REFUSED or with_token not in REFUSED:
                    wrong.append(f"{method} {entry.path} -> {status} (token header {with_token})")
        elif entry.kind == "websocket":
            if is_allowed(entry, None):
                continue
            code = refusal_of_socket(client, entry)
            checked.append(f"WS {entry.path}")
            if code != OWNER_REFUSAL_CLOSE:
                wrong.append(f"WS {entry.path} -> {code}")
        elif not is_allowed(entry, None):
            status = client.get(concrete(entry.path) + "/" + PLACEHOLDER).status_code
            checked.append(f"MOUNT {entry.path}")
            if status not in REFUSED:
                wrong.append(f"MOUNT {entry.path} -> {status}")
    return checked, wrong


@ROWS
def test_every_route_off_the_allowlist_refuses_a_request_with_no_session(
    host, row, static_dir: Path, named_project: Path
) -> None:
    host(row)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)

    checked, wrong = answers_without_a_session(app)

    assert wrong == []
    assert len(checked) > 60
    assert "GET /api/bootstrap/status" in checked
    assert "WS /api/host/ws" in checked


@ROWS
def test_the_walk_sees_every_route_the_app_documents(host, row) -> None:
    host(row)
    app = untrusted_app()
    documented = {
        (method.upper(), re.sub(r":\w+\}", "}", path))
        for path, item in app.openapi()["paths"].items()
        for method in item
        if method.upper() not in {"HEAD", "OPTIONS"}
    }
    walked = {
        (method, re.sub(r":\w+\}", "}", entry.path))
        for entry in _routes_of(app)
        for method in entry.methods
    }

    assert documented - walked == set()
    assert len(walked) > 100


def test_a_route_that_answers_without_a_session_is_found(host) -> None:
    host(IOS)
    app = untrusted_app()

    @app.get("/api/extension/leak")
    def leak() -> dict[str, bool]:
        return {"open": True}

    _, wrong = answers_without_a_session(app)

    assert wrong == ["GET /api/extension/leak -> 200 (token header 200)"]


def test_a_trusted_host_serves_an_owner_route_where_an_untrusted_one_refuses(host) -> None:
    status = "/api/bootstrap/status"
    host(MACOS)
    trusted = TestClient(create_app(), client=LOOPBACK_PEER).get(status).status_code
    host(IOS)
    untrusted = TestClient(untrusted_app(), client=LOOPBACK_PEER).get(status).status_code

    assert (trusted, untrusted) == (200, 403)


@ROWS
def test_the_allowlisted_routes_answer_as_pinned(
    host, row, static_dir: Path, named_project: Path
) -> None:
    host(row)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)
    client = TestClient(app, client=LOOPBACK_PEER)
    asset = client.get("/assets/app.js")
    features = client.get("/api/features")
    steps = client.get("/api/pipeline/steps")
    exchange = client.get(EXCHANGE_PATH)

    assert client.get("/api/health").json() == {"ok": True}
    assert set(steps.json()) == {"steps"}
    assert set(features.json()) == {"api_version", "features"}
    assert all(isinstance(name, str) for name in features.json()["features"])
    for body in (steps.text, features.text):
        assert str(named_project) not in body
        assert EPISODE not in body
    assert (exchange.status_code, SESSION_COOKIE in exchange.cookies) == (403, False)
    assert client.get("/").text == SHELL
    assert client.get("/favicon.svg").text == FAVICON
    assert client.get("/favicon.ico").text == FAVICON
    assert (asset.status_code, asset.text) == (200, ASSET)
    assert client.get("/assets/missing.js").status_code == 404


@ROWS
def test_a_guest_route_gives_a_made_up_token_nothing(
    host, row, static_dir: Path, named_project: Path
) -> None:
    host(row)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)
    client = TestClient(app, client=LOOPBACK_PEER)
    answers: dict[str, int] = {}

    for entry in _routes_of(app):
        if entry.kind != "http" or not entry.path.startswith(ALLOWED_PREFIXES[1:]):
            continue
        for method in entry.methods:
            status, _ = refusal_of(client, method, concrete(entry.path))
            if (method, entry.path) in GUEST_SHELLS:
                response = client.get(concrete(entry.path))
                assert response.text != SHELL
                assert EPISODE not in response.text
                assert str(named_project) not in response.text
            else:
                answers[f"{method} {entry.path}"] = status

    assert {route: status for route, status in answers.items() if status < 400} == {}
