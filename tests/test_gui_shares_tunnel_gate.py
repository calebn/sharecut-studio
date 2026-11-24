"""The host share and tunnel routes sit behind the include-time host gate of the collaboration mount."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.record_links import make_project

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/shares"),
    ("POST", "/api/shares"),
    ("POST", "/api/shares/tok/revoke"),
    ("POST", "/api/shares/tok/restore"),
    ("POST", "/api/shares/record"),
    ("POST", "/api/shares/record/tok/replace"),
    ("POST", "/api/shares/rooms/sid/revoke"),
    ("POST", "/api/shares/rooms/sid/restore"),
    ("GET", "/api/tunnel/status"),
]


@pytest.fixture(autouse=True)
def _collaboration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")


def _relayed() -> TestClient:
    return TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(method: str, path: str) -> None:
    res = _relayed().request(
        method,
        path,
        params={"path": "p"},
        json={"path": "p"} if method == "POST" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403


def test_a_loopback_host_lists_shares(minimal_project, tmp_workspace) -> None:
    client = TestClient(
        create_app(served_project=Path(minimal_project)), client=("127.0.0.1", 50000)
    )

    res = client.get("/api/shares", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json()["shares"] == []


def test_a_loopback_host_reads_the_tunnel_status(tmp_workspace) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/tunnel/status")

    assert res.status_code == 200
    assert res.json()["schema"] == 1


NOT_SET_UP = {"code": "online_sharing_not_set_up"}


def _loopback(project: Path) -> TestClient:
    return TestClient(create_app(served_project=project), client=("127.0.0.1", 50000))


def _publish_silent_mix(project: Path) -> str:
    import wave

    from podcast_mcp.models import load_project, save_project
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.collaboration.review import ReviewService

    loaded = load_project(project)
    premix = Path(loaded.workspace_dir) / "artifacts" / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(premix), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(48000)
        out.writeframes(b"\x00\x00" * 4800)
    save_project(loaded, project)
    return str(ReviewService(ProjectWorkspace.open(project)).publish(label="mix")["id"])


def test_mint_warns_when_online_sharing_not_set_up(tmp_workspace: Path) -> None:
    project = make_project(tmp_workspace)
    _publish_silent_mix(project)

    res = _loopback(project).post("/api/shares", json={"path": str(project)})

    assert res.status_code == 200, res.text
    assert NOT_SET_UP in res.json()["share"]["warnings"]


def test_record_mint_warns_when_online_sharing_not_set_up(tmp_workspace: Path) -> None:
    project = make_project(tmp_workspace)

    res = _loopback(project).post("/api/shares/record", json={"path": str(project)})

    assert res.status_code == 200, res.text
    room = res.json()["room"]
    assert NOT_SET_UP in room["guest"]["warnings"]
    assert NOT_SET_UP in room["producer"]["warnings"]


def test_record_mint_does_not_warn_when_online_sharing_is_set_up(
    tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    project = make_project(tmp_workspace)

    res = _loopback(project).post("/api/shares/record", json={"path": str(project)})

    assert res.status_code == 200, res.text
    room = res.json()["room"]
    assert "warnings" not in room["guest"]
    assert "warnings" not in room["producer"]


def test_mint_does_not_warn_when_online_sharing_is_set_up(
    tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
    project = make_project(tmp_workspace)
    _publish_silent_mix(project)

    res = _loopback(project).post("/api/shares", json={"path": str(project)})

    assert res.status_code == 200, res.text
    assert NOT_SET_UP not in res.json()["share"].get("warnings", [])
