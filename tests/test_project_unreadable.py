from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models.episode import ProjectUnreadableError, load_project

BODY = {
    "client_id": "c",
    "client_seq": 1,
    "command_id": "abc",
    "role": "viewer",
    "type": "SetTrackMeta",
    "payload": {"track_id": "host", "label": "X"},
}


@pytest.mark.parametrize(
    "contents",
    [b"{not json", b"", b"[1, 2]", b"\xff\xfe\x00"],
)
def test_load_project_raises_unreadable_for_damaged_files(minimal_project, contents):
    minimal_project.write_bytes(contents)
    with pytest.raises(ProjectUnreadableError) as caught:
        load_project(minimal_project)
    assert caught.value.code == "project_unreadable"
    assert str(minimal_project.parent) not in str(caught.value)


@pytest.mark.parametrize("route", ["command", "state"])
def test_damaged_project_is_a_coded_500_in_plain_words(minimal_project, route):
    minimal_project.write_text("{not json")
    with TestClient(create_app(served_project=minimal_project), raise_server_exceptions=False) as c:
        if route == "command":
            response = c.post(
                "/api/document/command", params={"path": str(minimal_project)}, json=BODY
            )
        else:
            response = c.get("/api/document/state", params={"path": str(minimal_project)})
    assert response.status_code == 500
    assert response.headers["x-sharecut-error-code"] == "project_unreadable"
    detail = response.json()["detail"]
    assert "damaged" in detail
    assert str(minimal_project.parent) not in response.text
    assert "Expecting" not in response.text


def test_load_project_raises_unreadable_for_a_wrong_shaped_project(minimal_project):
    data = json.loads(minimal_project.read_text())
    data["meta"] = 7
    minimal_project.write_text(json.dumps(data))
    with pytest.raises(ProjectUnreadableError):
        load_project(minimal_project)
