"""POST /api/project/reveal: show the served episode's project file in this computer's file manager."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes.deps import require_loopback_peer
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, save_project

CODE = "x-sharecut-error-code"
URL = "/api/project/reveal"
LOOPBACK = ("127.0.0.1", 50000)


@pytest.fixture
def episode(tmp_workspace: Path) -> Path:
    created = EpisodeProject.create("reveal_episode", str(tmp_workspace))
    created.ensure_dirs()
    return save_project(created)


@pytest.fixture
def shown(monkeypatch) -> list[Path]:
    calls: list[Path] = []
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.reveal_in_file_manager",
        lambda path: calls.append(path) or True,
    )
    return calls


def _client(episode: Path, peer: tuple[str, int]) -> TestClient:
    return TestClient(create_app(served_project=episode), client=peer)


def test_a_loopback_host_reveals_the_resolved_project_file(episode, shown) -> None:
    res = _client(episode, LOOPBACK).post(URL, json={"path": str(episode)})

    assert (res.status_code, res.json()) == (200, {"revealed": True})
    assert shown == [episode.resolve()]


def test_an_ipv4_mapped_loopback_peer_is_allowed(episode, shown) -> None:
    res = _client(episode, ("::ffff:127.0.0.1", 50000)).post(URL, json={"path": str(episode)})

    assert res.status_code == 200
    assert len(shown) == 1


def test_a_lan_peer_is_refused(episode, shown) -> None:
    res = _client(episode, ("203.0.113.9", 50000)).post(URL, json={"path": str(episode)})

    assert (res.status_code, res.headers[CODE]) == (403, "reveal_not_allowed")
    assert shown == []


def test_a_relayed_request_is_refused_as_not_a_host(episode, shown) -> None:
    res = _client(episode, LOOPBACK).post(
        URL, json={"path": str(episode)}, headers={"x-sharecut-relayed": "1"}
    )

    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")
    assert shown == []


def test_a_project_other_than_the_served_one_is_refused(episode, tmp_path, shown) -> None:
    other = save_project(EpisodeProject.create("other_episode", str(tmp_path / "other")))

    res = _client(episode, LOOPBACK).post(URL, json={"path": str(other)})

    assert (res.status_code, res.headers[CODE]) == (403, "project_path_not_allowed")
    assert shown == []


def test_a_missing_project_is_not_found(episode, shown) -> None:
    res = _client(episode, LOOPBACK).post(
        URL, json={"path": str(episode.with_name("gone.sharecut"))}
    )

    assert (res.status_code, res.headers[CODE]) == (404, "project_not_found")
    assert shown == []


def test_a_computer_with_no_file_manager_is_a_conflict(episode, monkeypatch) -> None:
    monkeypatch.setattr("podcast_mcp.gui.routes.project.reveal_in_file_manager", lambda path: False)

    res = _client(episode, LOOPBACK).post(URL, json={"path": str(episode)})

    assert (res.status_code, res.headers[CODE]) == (409, "reveal_unavailable")


def test_the_loopback_gate_fails_closed_without_a_peer() -> None:
    nobody = SimpleNamespace(client=None)

    with pytest.raises(Exception) as caught:
        require_loopback_peer(nobody)  # type: ignore[arg-type]

    assert getattr(caught.value, "status_code", None) == 403
    assert caught.value.headers[CODE.title()] == "reveal_not_allowed"
