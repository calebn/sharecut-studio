"""The eleven host document and export routes sit behind the route-level host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes import document, export_routes
from podcast_mcp.gui.routes.deps import host_gate
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/clips/c1/bleed"),
    ("GET", "/api/pending-preview"),
    ("POST", "/api/pending-preview/warm"),
    ("POST", "/api/range-audio"),
    ("POST", "/api/export/bounce"),
    ("POST", "/api/export/deliverables"),
    ("POST", "/api/export/deliverables/settings"),
    ("GET", "/api/export/files"),
    ("POST", "/api/export/files/reveal"),
    ("POST", "/api/transcript/export"),
    ("GET", "/api/transcript/exports"),
]

LEFT_OFF_THE_GATE = [
    ("GET", "/api/document/state"),
    ("GET", "/api/document/comments"),
    ("POST", "/api/document/command"),
    ("GET", "/api/session-suggestion/takes"),
    ("GET", "/api/export/files/{file_id:path}"),
    ("HEAD", "/api/export/files/{file_id:path}"),
]


def _gate_calls(method: str, path: str) -> set[object]:
    for module in (document, export_routes):
        for route in module.router.routes:
            if getattr(route, "path", None) == path and method in getattr(route, "methods", ()):
                return {dep.dependency for dep in route.dependencies}
    raise AssertionError(f"{method} {path} is not declared")


def _relayed() -> TestClient:
    return TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(method: str, path: str) -> None:
    res = _relayed().request(
        method,
        path,
        params={"path": "p", "track_id": "t", "edit_id": "e"},
        json={"path": "p", "id": "x", "target": {"start_s": 0, "end_s": 1}}
        if method == "POST"
        else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_migrated_route_carries_the_host_gate(method: str, path: str) -> None:
    template = {"/api/clips/c1/bleed": "/api/clips/{clip_id}/bleed"}.get(path, path)

    assert host_gate in _gate_calls(method, template)


@pytest.mark.parametrize(("method", "path"), LEFT_OFF_THE_GATE)
def test_routes_left_off_the_gate_do_not_carry_it(method: str, path: str) -> None:
    assert host_gate not in _gate_calls(method, path)


def test_a_download_with_an_unknown_id_keeps_its_own_404(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/export/files/missing.mp3", params={"path": str(minimal_project)})

    assert res.status_code == 404
    assert res.headers["X-Sharecut-Error-Code"] == "export_file_gone"


def test_a_download_with_a_bad_ticket_keeps_its_own_403(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get(
        "/api/export/files/missing.mp3", params={"path": str(minimal_project), "ticket": "bad"}
    )

    assert res.status_code == 403
    assert res.headers["X-Sharecut-Error-Code"] != "authz_denied"


def test_a_loopback_host_caller_lists_export_files(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/export/files", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json()["files"] == []


def test_a_loopback_host_caller_lists_transcript_exports(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/transcript/exports", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json() == []
