"""Tests for `edits.prosody_profile.prosody_overlay` and `GET /api/project/prosody` (#719)."""

from __future__ import annotations

import json

import pytest

from podcast_mcp.edits.prosody_profile import prosody_overlay
from podcast_mcp.engines.prosody import ProsodyParams
from podcast_mcp.models import Clip, load_project, save_project
from podcast_mcp.services.play import PlayService
from podcast_mcp.services.workspace import ProjectWorkspace
from prosody_helpers import seed_prosody_profile, single_track_prosody_project


def test_prosody_overlay_missing_profile(minimal_project):
    proj = single_track_prosody_project(minimal_project)
    result = prosody_overlay(proj)
    assert result["schema"] == "prosody_overlay.v1"
    assert len(result["tracks"]) == 1
    host = result["tracks"][0]
    assert host["track_id"] == "host"
    assert host["status"] == "missing"
    assert "hint" in host
    assert host["segments"] == []
    assert host["boundaries"] == []
    assert host["prominent_words"] == []
    assert host["energy_db"] is None


def test_prosody_overlay_maps_seeded_profile(minimal_project):
    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj)
    proj = load_project(minimal_project)

    result = prosody_overlay(proj)
    host = result["tracks"][0]
    assert host["status"] == "fresh"
    assert len(host["segments"]) == 1
    seg = host["segments"][0]
    assert seg["spans"] == pytest.approx([{"start": 0.0, "end": 2.0}])
    assert seg["trend"] == "falling"
    assert "F0" in seg["line"]

    thirds = seg["energy_thirds"]
    assert [t["db"] for t in thirds] == pytest.approx([62.0, 60.0, 58.0])
    assert thirds[0]["spans"] == pytest.approx([{"start": 0.0, "end": 2.0 / 3.0}])
    assert thirds[1]["spans"] == pytest.approx([{"start": 2.0 / 3.0, "end": 4.0 / 3.0}])
    assert thirds[2]["spans"] == pytest.approx([{"start": 4.0 / 3.0, "end": 2.0}])

    assert len(host["boundaries"]) == 1
    boundary = host["boundaries"][0]
    assert boundary["timeline_sec"] == pytest.approx(2.0)
    assert boundary["kind"] == "segment_end"
    assert boundary["strength"] == pytest.approx(1.0)

    assert len(host["prominent_words"]) == 1
    word = host["prominent_words"][0]
    assert word["text"] == "hello"
    assert word["word_index"] == 0
    assert word["timeline_sec"] == pytest.approx(0.1)
    assert word["score"] == pytest.approx(1.2)

    assert host["energy_db"] == {"min": 58.0, "max": 62.0}


def test_prosody_overlay_follows_cuts(minimal_project):
    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj)
    proj = load_project(minimal_project)
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=1.5, source_end=2.0, timeline_start=1.0),
    ]
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)

    result = prosody_overlay(proj)
    host = result["tracks"][0]
    assert host["status"] == "fresh"
    seg = host["segments"][0]
    # The two clips' timeline ranges (0-1, 1-1.5) are contiguous, so map_source_span
    # (SessionTimeline) merges them into one span.
    assert seg["spans"] == pytest.approx([{"start": 0.0, "end": 1.5}])

    boundary = host["boundaries"][0]
    assert boundary["timeline_sec"] == pytest.approx(1.5)

    middle = seg["energy_thirds"][1]
    assert middle["spans"] == pytest.approx([{"start": 2.0 / 3.0, "end": 1.0}])
    last = seg["energy_thirds"][2]
    assert last["spans"] == pytest.approx([{"start": 1.0, "end": 1.5}])


def test_prosody_overlay_stale_keeps_data(minimal_project):
    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj)
    proj = load_project(minimal_project)

    result = prosody_overlay(proj, params=ProsodyParams(pitch_floor_hz=90.0))
    host = result["tracks"][0]
    assert host["status"] == "stale"
    assert "hint" in host
    assert host["segments"] != []


def test_prosody_overlay_unreadable_cache_is_unavailable(minimal_project, tmp_workspace):
    from podcast_mcp.edits import prosody_profile as pp

    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj)
    proj = load_project(minimal_project)

    cache_file = next(pp.prosody_dir(proj).glob("host_*.json"))
    payload = json.loads(cache_file.read_text())
    payload["segments"] = [{"end": 1.0}]
    cache_file.write_text(json.dumps(payload))

    result = prosody_overlay(proj)
    host = result["tracks"][0]
    assert host["status"] == "unavailable"
    assert host["hint"] == pp._OVERLAY_UNAVAILABLE_HINT

    dumped = json.dumps(result)
    assert str(tmp_workspace) not in dumped
    assert "KeyError" not in dumped


def test_play_service_prosody_overlay_uses_staged_params(minimal_project):
    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj, params=ProsodyParams(pitch_floor_hz=90.0).key())
    ws = ProjectWorkspace.open(minimal_project)

    result = PlayService(ws).prosody_overlay()
    host = result["tracks"][0]
    assert host["status"] == "fresh"


def test_api_project_prosody_route(minimal_project):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.middleware_host_binding import path_requires_host_binding
    from podcast_mcp.gui.server import create_app

    assert path_requires_host_binding("/api/project/prosody")

    proj = single_track_prosody_project(minimal_project)
    seed_prosody_profile(proj)

    client = TestClient(create_app())
    res = client.get("/api/project/prosody", params={"path": str(minimal_project)})
    assert res.status_code == 200
    body = res.json()
    assert body["tracks"][0]["status"] == "fresh"
