"""The HTTP reply shape Studio parses for ApplyDucking (gui/web/src/api/documentEdits.ts)."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from test_ducking import write_project


def post(client: TestClient, path: Path, payload: dict, seq: int):
    return client.post(
        "/api/document/command",
        params={"path": str(path)},
        json={
            "type": "ApplyDucking",
            "payload": payload,
            "client_id": "studio-test",
            "command_id": uuid4().hex,
            "client_seq": seq,
        },
    )


def test_the_route_replies_with_the_shape_studio_parses(tmp_path: Path) -> None:
    path = write_project(tmp_path)
    client = TestClient(create_app())

    dry = post(client, path, {"dry_run": True}, 1)
    assert dry.status_code == 200
    result = dry.json()["command"]["payload"]["result"]
    assert isinstance(result["plan_token"], str)
    assert isinstance(result["depth_db"], float)
    assert result["applied"] is False
    for row in result["tracks"]:
        assert isinstance(row["track_id"], str)
        assert isinstance(row["changed"], bool)
        assert isinstance(row["replaced_generated"], int)
        assert isinstance(row["coarsened"], bool)
    assert "history_head_id" not in dry.json()

    stale = post(client, path, {"expected_plan_token": "not-the-token"}, 2)
    assert stale.status_code == 409
    assert stale.json()["detail"]["conflict"] is True
    assert stale.headers["x-sharecut-error-code"] == "document_conflict"

    applied = post(client, path, {"expected_plan_token": result["plan_token"]}, 3)
    assert applied.status_code == 200
    body = applied.json()
    assert body["command"]["payload"]["result"]["applied"] is True
    assert isinstance(body["history_head_id"], str)
