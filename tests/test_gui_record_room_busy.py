"""A busy record room lock leaves the host routes as 503 project_busy (#2329)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from filelock import FileLock

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share
from podcast_mcp.util.project_state import record_room_lock_path

ROUTES = [
    "/api/shares/record",
    "/api/shares/rooms/sid/revoke",
    "/api/shares/rooms/sid/restore",
]


@pytest.mark.parametrize("route", ROUTES)
def test_host_room_routes_answer_project_busy_while_the_room_lock_is_held(
    monkeypatch: pytest.MonkeyPatch, minimal_project, tmp_workspace, route: str
) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    monkeypatch.setattr(share, "RECORD_ROOM_LOCK_TIMEOUT_SEC", 0.2)
    client = TestClient(
        create_app(served_project=Path(minimal_project)), client=("127.0.0.1", 50000)
    )
    ws = ProjectWorkspace.open(str(minimal_project))
    path = record_room_lock_path(Path(ws.project.workspace_dir))
    path.parent.mkdir(parents=True, exist_ok=True)
    holder = FileLock(str(path), thread_local=False)
    with holder.acquire(timeout=5):
        res = client.post(
            route,
            params={"path": str(minimal_project)},
            json={"path": str(minimal_project)},
        )

    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
