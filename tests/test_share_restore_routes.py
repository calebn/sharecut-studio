"""Host revoke opt-in (``restorable``) and the host-only restore routes for links and rooms."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes import shares as share_routes
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share_pending
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService

CODE = "X-Sharecut-Error-Code"
RELAYED = {"X-Sharecut-Relayed": "1"}


@pytest.fixture(autouse=True)
def _quiet(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    monkeypatch.setattr(share_pending, "start_sweep_timer", lambda *_a: None)
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


@pytest.fixture
def ws(minimal_project, sample_wav, tmp_workspace) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@pytest.fixture
def client(ws, minimal_project) -> TestClient:
    return TestClient(create_app(served_project=Path(minimal_project)))


def _body(minimal_project, **extra: object) -> dict:
    return {"path": str(minimal_project), **extra}


def _mint(ws: ProjectWorkspace) -> dict:
    ver = ReviewService(ws).publish(label="route")
    return ShareService(ws).create(review_version_id=ver["id"])


def _guest_status(client: TestClient, token: str) -> int:
    return client.get(f"/api/review/{token}/project").status_code


def _refused(res, status: int, code: str) -> None:
    assert res.status_code == status, res.text
    assert res.headers[CODE] == code


def test_default_revoke_is_final_and_has_no_restore_fields(ws, client, minimal_project):
    share = _mint(ws)
    res = client.post(f"/api/shares/{share['token']}/revoke", json=_body(minimal_project))
    assert res.status_code == 200
    assert res.json() == {"revoked": True, "token": share["token"]}
    _refused(
        client.post(f"/api/shares/{share['token']}/restore", json=_body(minimal_project)),
        410,
        "restore_window_closed",
    )


def test_restorable_revoke_kills_the_link_and_restore_brings_it_back(ws, client, minimal_project):
    share = _mint(ws)
    token = share["token"]
    assert _guest_status(client, token) == 200
    res = client.post(f"/api/shares/{token}/revoke", json=_body(minimal_project, restorable=True))
    assert res.status_code == 200
    out = res.json()
    assert out["revoked"] is True and out["token"] == token
    assert out["restorable_until"]
    assert 0 < out["restore_ms"] <= 10_000
    assert _guest_status(client, token) != 200
    listed = client.get("/api/shares", params={"path": str(minimal_project)}).json()["shares"]
    assert token not in {row["token"] for row in listed}

    back = client.post(f"/api/shares/{token}/restore", json=_body(minimal_project))
    assert back.status_code == 200
    assert back.json() == {"restored": True, "token": token}
    assert _guest_status(client, token) == 200
    again = client.post(f"/api/shares/{token}/restore", json=_body(minimal_project))
    assert again.status_code == 200


def test_restore_after_the_window_is_gone_410_and_the_revoke_is_final(
    ws, client, minimal_project, monkeypatch
):
    share = _mint(ws)
    token = share["token"]
    monkeypatch.setattr(share_routes, "RESTORABLE_REVOKE_SEC", 0.0)
    out = client.post(
        f"/api/shares/{token}/revoke", json=_body(minimal_project, restorable=True)
    ).json()
    assert out["restore_ms"] == 0
    _refused(
        client.post(f"/api/shares/{token}/restore", json=_body(minimal_project)),
        410,
        "restore_window_closed",
    )
    assert _guest_status(client, token) != 200


def test_restore_of_an_unknown_link_is_404(client, minimal_project):
    _refused(
        client.post("/api/shares/no-such-token/restore", json=_body(minimal_project)),
        404,
        "share_not_found",
    )
    _refused(
        client.post("/api/shares/rooms/no-such-room/restore", json=_body(minimal_project)),
        404,
        "record_room_not_found",
    )


def test_room_restorable_revoke_and_restore(ws, client, minimal_project):
    room = ShareService(ws).create_record_room()
    sid = room["session_id"]
    res = client.post(
        f"/api/shares/rooms/{sid}/revoke", json=_body(minimal_project, restorable=True)
    )
    assert res.status_code == 200
    out = res.json()
    assert out["session_id"] == sid
    assert set(out["revoked"]) == {room["guest"]["token"], room["producer"]["token"]}
    assert 0 < out["restore_ms"] <= 10_000 and out["restorable_until"]

    back = client.post(f"/api/shares/rooms/{sid}/restore", json=_body(minimal_project))
    assert back.status_code == 200
    assert back.json()["session_id"] == sid
    assert set(back.json()["restored"]) == set(out["revoked"])


def test_default_room_revoke_is_final(ws, client, minimal_project):
    room = ShareService(ws).create_record_room()
    sid = room["session_id"]
    out = client.post(f"/api/shares/rooms/{sid}/revoke", json=_body(minimal_project)).json()
    assert set(out) == {"session_id", "revoked"}
    _refused(
        client.post(f"/api/shares/rooms/{sid}/restore", json=_body(minimal_project)),
        410,
        "restore_window_closed",
    )


def test_a_room_minted_inside_the_window_makes_restore_409(ws, client, minimal_project):
    old = ShareService(ws).create_record_room()
    client.post(
        f"/api/shares/rooms/{old['session_id']}/revoke",
        json=_body(minimal_project, restorable=True),
    )
    ShareService(ws).create_record_room()
    _refused(
        client.post(f"/api/shares/rooms/{old['session_id']}/restore", json=_body(minimal_project)),
        409,
        "record_room_conflict",
    )


def test_a_guest_cannot_restore_or_revoke_restorably(ws, client, minimal_project):
    share = _mint(ws)
    token = share["token"]
    client.post(f"/api/shares/{token}/revoke", json=_body(minimal_project, restorable=True))
    room = ShareService(ws).create_record_room()
    sid = room["session_id"]
    for url in (f"/api/shares/{token}/restore", f"/api/shares/rooms/{sid}/restore"):
        _refused(
            client.post(url, json=_body(minimal_project), headers=RELAYED), 403, "authz_denied"
        )
    _refused(
        client.post(
            f"/api/shares/rooms/{sid}/revoke",
            json=_body(minimal_project, restorable=True),
            headers=RELAYED,
        ),
        403,
        "authz_denied",
    )
    assert _guest_status(client, token) != 200
    assert (
        client.post(f"/api/shares/{token}/restore", json=_body(minimal_project)).status_code == 200
    )
