from __future__ import annotations

import json
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.server import create_app
from podcast_mcp.models.episode import load_project
from podcast_mcp.models.project_format import (
    ProjectVersionNewerError,
    ProjectVersionUnsupportedError,
)
from podcast_mcp.project.store import WriteGrantKind, write_grant

NEWER = ["99.0", "2.4", "2.3.0"]
UNSUPPORTED = ["two", None, "2.1.5"]
COMMAND = {
    "client_id": "c",
    "client_seq": 1,
    "command_id": "abc",
    "role": "viewer",
    "type": "SetTrackMeta",
    "payload": {"track_id": "host", "label": "X"},
}
VERSIONS = [(v, "project_version_newer") for v in NEWER] + [
    (v, "project_version_unsupported") for v in UNSUPPORTED
]


def _set_version(project_file, version):
    data = json.loads(project_file.read_text())
    if version is None:
        data.pop("version", None)
    else:
        data["version"] = version
    project_file.write_text(json.dumps(data))


def _expected_detail(project_file, code):
    with pytest.raises((ProjectVersionNewerError, ProjectVersionUnsupportedError)) as caught:
        load_project(project_file)
    assert caught.value.code == code
    return str(caught.value)


def _call(client, route, project_file):
    params = {"path": str(project_file)}
    if route == "shell":
        return client.get("/api/document/state", params={**params, "phase": "shell"})
    if route == "detail":
        return client.get("/api/document/state", params={**params, "phase": "detail"})
    if route == "session":
        return client.post("/api/session/state", params=params, json={"client_id": "v"})
    if route == "export-files":
        return client.get("/api/export/files", params=params)
    return client.post("/api/document/command", params=params, json=COMMAND)


@pytest.mark.parametrize("route", ["shell", "detail", "session", "export-files", "command"])
@pytest.mark.parametrize(("version", "code"), VERSIONS)
def test_a_version_the_build_cannot_read_is_a_coded_400_on_host_routes(
    minimal_project, route, version, code
):
    _set_version(minimal_project, version)
    expected = _expected_detail(minimal_project, code)
    with TestClient(
        create_app(served_project=minimal_project), raise_server_exceptions=False
    ) as client:
        response = _call(client, route, minimal_project)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["x-sharecut-error-code"] == code
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": expected}
    assert str(minimal_project.parent) not in response.text


@pytest.mark.parametrize(
    "code_version", [("99.0", "project_version_newer"), ("two", "project_version_unsupported")]
)
def test_the_host_socket_refuses_before_accept_with_the_code(minimal_project, code_version):
    version, code = code_version
    _set_version(minimal_project, version)
    url = "/api/host/ws?" + urlencode(
        {
            "path": str(minimal_project),
            "client_id": "presence-owner",
            "document_client_id": "document-owner",
        }
    )
    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(create_app()).websocket_connect(url):
            pass
    assert closed.value.code == 4400
    assert closed.value.reason == code


def test_a_guest_still_gets_the_fixed_guest_line_for_a_newer_episode(
    minimal_project, published_share
):
    with write_grant(WriteGrantKind.DISPATCHER):
        token = published_share()[2]["token"]
    _set_version(minimal_project, "99.0")
    client = TestClient(create_app(), raise_server_exceptions=False)
    response = client.get(f"/api/review/{token}/daw/project", params={"phase": "shell"})
    assert response.status_code == 400
    assert response.headers["x-sharecut-error-code"] == "project_version_newer"
    assert "99.0" not in response.text
    assert "ask the host to update" in response.json()["detail"]


def test_a_healthy_shell_read_is_unchanged(minimal_project):
    with TestClient(create_app(served_project=minimal_project)) as client:
        response = client.get(
            "/api/document/state", params={"path": str(minimal_project), "phase": "shell"}
        )
    assert response.status_code == 200
    assert "x-sharecut-error-code" not in response.headers


def test_an_integer_version_is_capped_like_a_text_one(minimal_project):
    digits = "7" * 4000
    minimal_project.write_text(minimal_project.read_text().replace('"2.3"', digits, 1))
    with TestClient(create_app(served_project=minimal_project), raise_server_exceptions=False) as c:
        response = c.get("/api/document/state", params={"path": str(minimal_project)})
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert len(detail) < 400
    assert "7" * 25 not in detail
    assert "7" * 24 in detail
