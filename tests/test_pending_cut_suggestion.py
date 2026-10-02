from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.waveform_pyramid import wait_pyramid_jobs
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EditDecision, EditDecisionType, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, EpisodeService


@pytest.fixture
def pending_workspace(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host", role="music")
    wait_pyramid_jobs()
    ws.project.edit_decisions = [
        EditDecision(id="pending", track_id="host", start=2, end=8, applied=False)
    ]
    save_project(ws.project, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_preview_optimizes_complete_source_range_without_writing(pending_workspace):
    ws = pending_workspace
    project_before = ws.project.model_dump(mode="json")
    files_before = {p: p.read_bytes() for p in Path(ws.project.workspace_dir).rglob("*.json")}
    with patch(
        "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
        side_effect=[1.975, 8.035],
    ):
        suggestion = EditService(ws).preview_pending_cut("pending")
    assert suggestion.edit_id == "pending"
    assert suggestion.track_id == "host"
    assert (suggestion.original_start, suggestion.original_end) == (2, 8)
    assert (suggestion.optimized.start, suggestion.optimized.end) == (1.975, 8.035)
    assert suggestion.optimized.shifted_start_ms == pytest.approx(-25)
    assert suggestion.optimized.shifted_end_ms == pytest.approx(35)
    assert ws.project.model_dump(mode="json") == project_before
    assert {
        p: p.read_bytes() for p in Path(ws.project.workspace_dir).rglob("*.json")
    } == files_before


@pytest.mark.parametrize("kind", [EditDecisionType.REMOVE, EditDecisionType.MUTE])
def test_preview_supports_both_source_cut_types(pending_workspace, kind):
    pending_workspace.project.edit_decisions[0].type = kind
    with patch(
        "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
        side_effect=[2.01, 7.99],
    ):
        suggestion = EditService(pending_workspace).preview_pending_cut("pending")
    assert (suggestion.optimized.start, suggestion.optimized.end) == (2.01, 7.99)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"applied": True}, "pending edit"),
        ({"type": EditDecisionType.SPLIT}, "remove or mute"),
        ({"timebase": "timeline"}, "source-time"),
    ],
)
def test_preview_rejects_ineligible_decisions(pending_workspace, change, message):
    edit = pending_workspace.project.edit_decisions[0]
    pending_workspace.project.edit_decisions = [edit.model_copy(update=change)]
    with pytest.raises(ValueError, match=message):
        EditService(pending_workspace).preview_pending_cut("pending")


def test_preview_rejects_missing_decision(pending_workspace):
    with pytest.raises(KeyError, match="not found"):
        EditService(pending_workspace).preview_pending_cut("missing")


def test_host_preview_is_read_only_and_uses_saved_identity(pending_workspace, minimal_project):
    before = minimal_project.read_bytes()
    client = TestClient(create_app(served_project=minimal_project))
    with patch(
        "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
        side_effect=[1.975, 8.035],
    ):
        response = client.get(
            "/api/pending-edits/pending/cut-suggestion", params={"path": str(minimal_project)}
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "edit_id": "pending",
        "track_id": "host",
        "original_start": 2,
        "original_end": 8,
        "optimized": {
            "start": 1.975,
            "end": 8.035,
            "mode": "waveform_only",
            "shifted_start_ms": pytest.approx(-25),
            "shifted_end_ms": pytest.approx(35),
            "confidence": 0.625,
            "details": {
                "strategy": "waveform",
                "search_window_ms": 40,
                "max_shift_ms": 80,
                "trailing_energy_extended": False,
                "absorb_trailing_silence": False,
            },
        },
    }
    assert minimal_project.read_bytes() == before
    missing = client.get(
        "/api/pending-edits/missing/cut-suggestion", params={"path": str(minimal_project)}
    )
    assert missing.status_code == 404
    pending_workspace.project.edit_decisions[0].applied = True
    save_project(pending_workspace.project, minimal_project)
    invalid = client.get(
        "/api/pending-edits/pending/cut-suggestion", params={"path": str(minimal_project)}
    )
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "cut suggestions require a pending edit"


@pytest.mark.parametrize(
    ("headers", "status", "detail"),
    [
        ({"Host": "evil.example"}, 400, "invalid Host header for host GUI"),
        (
            {"Host": "localhost", "Origin": "https://evil.example"},
            403,
            "Origin not allowed for host GUI",
        ),
        (
            {"Host": "localhost", "Referer": "https://evil.example/page"},
            403,
            "Referer not allowed for host GUI",
        ),
    ],
)
def test_host_preview_rejects_forged_browser_binding(
    pending_workspace, minimal_project, headers, status, detail
):
    before = minimal_project.read_bytes()
    client = TestClient(create_app(served_project=minimal_project), client=("127.0.0.1", 12345))
    response = client.get(
        "/api/pending-edits/pending/cut-suggestion",
        params={"path": str(minimal_project)},
        headers=headers,
    )
    assert response.status_code == status
    assert response.json()["detail"] == detail
    assert minimal_project.read_bytes() == before


def test_host_preview_checks_host_and_project_binding(pending_workspace, minimal_project, tmp_path):
    client = TestClient(create_app(served_project=minimal_project))
    denied = client.get(
        "/api/pending-edits/pending/cut-suggestion",
        params={"path": str(minimal_project)},
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert denied.status_code == 403
    other = tmp_path / "other.json"
    other.write_bytes(minimal_project.read_bytes())
    forbidden = client.get("/api/pending-edits/pending/cut-suggestion", params={"path": str(other)})
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "project path not allowed for this server instance"


@pytest.mark.parametrize("capability", ["suggest", "edit"])
def test_guest_preview_requires_view_and_editing_capability(
    pending_workspace, published_share, capability
):
    client = TestClient(create_app())
    _, _, view_share = published_share(capabilities=["view"])
    denied = client.get(
        f"/api/review/{view_share['token']}/daw/pending-edits/pending/cut-suggestion"
    )
    assert denied.status_code == 403
    _, _, share = published_share(capabilities=["view", capability])
    with patch(
        "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
        side_effect=[1.975, 8.035],
    ):
        response = client.get(
            f"/api/review/{share['token']}/daw/pending-edits/pending/cut-suggestion"
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["original_start"] == 2
    assert response.json()["original_end"] == 8
    assert response.json()["optimized"]["start"] == 1.975
    assert response.json()["optimized"]["end"] == 8.035
    with patch.object(
        EditService, "preview_pending_cut", side_effect=RuntimeError("/private/path")
    ):
        error = client.get(f"/api/review/{share['token']}/daw/pending-edits/pending/cut-suggestion")
    assert error.status_code == 500
    assert error.json() == {"detail": "internal error"}
