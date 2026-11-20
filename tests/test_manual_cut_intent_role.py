from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    CutIntent,
    EditDecision,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role


@pytest.fixture
def pending_project(minimal_project):
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(id="clip", track_id="host", source_start=0, source_end=10, timeline_start=0)
    ]
    project.edit_decisions = [
        EditDecision(id="pending", track_id="host", start=2, end=8, applied=False)
    ]
    save_project(project, minimal_project)
    return minimal_project


def _retime(role: str) -> dict:
    return {
        "type": "UpdatePendingEdit",
        "payload": {"id": "pending", "start": 2.5, "end": 8.0, "snap": False},
        "client_id": f"{role}-client",
        "client_seq": 1,
        "role": role,
    }


def _stored_intent(path) -> CutIntent:
    return load_project(path).edit_decisions[0].boundary_intent


@pytest.mark.parametrize(
    ("role", "intent"),
    [
        ("viewer", CutIntent.HUMAN_BOUNDARIES),
        ("agent", CutIntent.PROGRAMMATIC),
        ("cli", CutIntent.PROGRAMMATIC),
    ],
)
def test_host_route_intent_follows_the_actor_role(pending_project, role, intent):
    client = TestClient(create_app())
    response = client.post(f"/api/document/command?path={pending_project}", json=_retime(role))
    assert response.status_code == 200, response.text
    assert _stored_intent(pending_project) is intent


def test_guest_editor_stamps_human_intent(pending_project, published_share):
    _, _, share = published_share(capabilities=capabilities_for_role("editor"))
    client = TestClient(create_app())
    response = client.post(
        f"/api/review/{share['token']}/daw/document/command", json=_retime("viewer")
    )
    assert response.status_code == 200, response.text
    assert _stored_intent(pending_project) is CutIntent.HUMAN_BOUNDARIES


def test_guest_commenter_stays_programmatic(pending_project, published_share):
    _, _, share = published_share(capabilities=capabilities_for_role("commenter"))
    client = TestClient(create_app())
    url = f"/api/review/{share['token']}/daw/document/command"
    suggested = client.post(
        url,
        json={
            "type": "SuggestPendingEdit",
            "payload": {"track_id": "host", "start": 1.0, "end": 3.0},
            "client_id": "commenter-client",
            "client_seq": 1,
            "role": "guest",
        },
    )
    assert suggested.status_code == 200, suggested.text
    own = next(e for e in load_project(pending_project).edit_decisions if e.id != "pending")
    retimed = {
        **_retime("guest"),
        "payload": {"id": own.id, "start": 1.5, "end": 3.0, "snap": False},
    }
    response = client.post(url, json=retimed)
    assert response.status_code == 200, response.text
    stored = next(e for e in load_project(pending_project).edit_decisions if e.id == own.id)
    assert stored.start == 1.5
    assert stored.boundary_intent is CutIntent.PROGRAMMATIC
