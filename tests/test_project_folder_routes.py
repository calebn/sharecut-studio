"""Settings > Saved in: reveal the episode's folder, and move it."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.host_file_dialog import HostPickResult
from podcast_mcp.gui.server import create_app
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace

CODE = "x-sharecut-error-code"
REMOTE = ("203.0.113.9", 5000)


@pytest.fixture
def ws(tmp_path: Path) -> ProjectWorkspace:
    with write_grant(WriteGrantKind.DISPATCHER):
        return ProjectWorkspace.create(str(tmp_path / "library" / "ep"), name="ep")


@pytest.fixture
def local() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


@pytest.fixture
def lan() -> TestClient:
    return TestClient(create_app(), client=REMOTE)


@pytest.fixture(autouse=True)
def config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(tmp_path / "config"))


def _pick(monkeypatch: pytest.MonkeyPatch, result: HostPickResult) -> None:
    monkeypatch.setattr("podcast_mcp.gui.routes.project.pick_folder_path", lambda: result)


def test_reveal_project_shows_the_episode_file_and_refuses_a_lan_peer(
    ws, local, lan, monkeypatch
) -> None:
    shown: list[Path] = []
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.export_files.reveal_in_file_manager",
        lambda path: shown.append(path) or True,
    )

    ok = local.post("/api/project/reveal", json={"path": str(ws.path)})
    refused = lan.post("/api/project/reveal", json={"path": str(ws.path)})
    missing = local.post("/api/project/reveal", json={"path": str(ws.path.parent / "gone")})

    assert (ok.status_code, ok.json()) == (200, {"revealed": True})
    assert shown == [ws.path.resolve()]
    assert (refused.status_code, refused.headers[CODE]) == (403, "reveal_not_allowed")
    assert missing.status_code == 400


def test_move_carries_the_folder_to_the_chosen_parent(ws, local, tmp_path, monkeypatch) -> None:
    destination = tmp_path / "elsewhere"
    destination.mkdir()
    _pick(monkeypatch, HostPickResult(path=str(destination)))

    res = local.post("/api/project/move", json={"path": str(ws.path)})

    moved = destination / "ep" / ws.path.name
    assert (res.status_code, res.json()) == (200, {"project_path": str(moved)})
    assert moved.exists()
    assert not ws.path.parent.exists()


def test_move_reports_a_dismissed_or_missing_dialog(ws, local, monkeypatch) -> None:
    _pick(monkeypatch, HostPickResult(cancelled=True))
    assert local.post("/api/project/move", json={"path": str(ws.path)}).json() == {
        "cancelled": True
    }
    _pick(monkeypatch, HostPickResult(unavailable=True, detail="no dialog"))
    assert local.post("/api/project/move", json={"path": str(ws.path)}).json() == {
        "unavailable": True,
        "detail": "no dialog",
    }
    assert ws.path.exists()


@pytest.mark.parametrize(
    ("parent", "status", "code"),
    [
        ("library", 400, "project_move_same"),
        ("library/ep", 400, "project_move_inside"),
        ("library/ep/artifacts", 400, "project_move_inside"),
        ("taken", 409, "project_move_exists"),
    ],
)
def test_move_refuses_a_destination_that_cannot_hold_the_folder(
    ws, local, tmp_path, monkeypatch, parent, status, code
) -> None:
    (tmp_path / "taken" / "ep").mkdir(parents=True)
    (ws.path.parent / "artifacts").mkdir(exist_ok=True)
    _pick(monkeypatch, HostPickResult(path=str(tmp_path / parent)))

    res = local.post("/api/project/move", json={"path": str(ws.path)})

    assert (res.status_code, res.headers[CODE]) == (status, code)
    assert ws.path.exists()


def test_move_refuses_a_lan_peer_before_any_dialog(ws, lan, monkeypatch) -> None:
    def never() -> HostPickResult:
        raise AssertionError("the dialog must not open")

    monkeypatch.setattr("podcast_mcp.gui.routes.project.pick_folder_path", never)

    res = lan.post("/api/project/move", json={"path": str(ws.path)})

    assert (res.status_code, res.headers[CODE]) == (403, "reveal_not_allowed")


def test_move_waits_for_a_running_step(ws, local, tmp_path, monkeypatch) -> None:
    class Busy:
        def status(self, _path: str) -> dict[str, bool]:
            return {"running": True}

    local.app.state.jobs = Busy()
    _pick(monkeypatch, HostPickResult(path=str(tmp_path)))

    res = local.post("/api/project/move", json={"path": str(ws.path)})

    assert (res.status_code, res.headers[CODE]) == (409, "project_move_busy")
