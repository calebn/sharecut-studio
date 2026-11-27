from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.models import EpisodeProject, MediaAsset, Track
from podcast_mcp.services.document import bleed_inspection

pytestmark = pytest.mark.unscoped_ok


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


@pytest.fixture
def project(tmp_path: Path) -> EpisodeProject:
    built = EpisodeProject.create("gate-state", str(tmp_path))
    built.tracks.append(
        Track(id="host", label="Host", media=MediaAsset(path="host.wav", duration_sec=2))
    )
    built.tracks.append(
        Track(id="guest", label="Guest", media=MediaAsset(path="guest.wav", duration_sec=3))
    )
    return built


def _payload(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]) -> None:
    monkeypatch.setattr(bleed_inspection, "bleed_gate_payload", lambda *_args, **_kwargs: payload)


def test_gate_state_wraps_payload_and_dumps_each_input_lane(project, monkeypatch):
    payload = {
        "revision": 7,
        "inputs": [{"track_id": "guest"}, {"track_id": "host"}],
        "policy": {"attenuation_db": 20.0},
    }
    _payload(monkeypatch, payload)
    state = bleed_inspection._gate_state(project, "host", load_defaults())
    assert list(state) == ["gate", "lanes"]
    assert state["gate"] is payload
    assert [lane["id"] for lane in state["lanes"]] == ["guest", "host"]
    assert _dump(state["lanes"][0]) == _dump(project.track_by_id("guest").model_dump(mode="json"))
    assert _dump(state["lanes"][1]) == _dump(project.track_by_id("host").model_dump(mode="json"))
    assert state["lanes"][1]["media"] == {
        "path": "host.wav",
        "duration_sec": 2.0,
        "sample_rate": None,
        "channels": None,
    }
    assert state["lanes"][1]["label"] == "Host"


def test_gate_state_skips_inputs_for_tracks_the_project_does_not_have(project, monkeypatch):
    _payload(monkeypatch, {"inputs": [{"track_id": "ghost"}, {"track_id": "guest"}]})
    state = bleed_inspection._gate_state(project, "host", load_defaults())
    assert [lane["id"] for lane in state["lanes"]] == ["guest"]


def test_gate_state_with_no_inputs_key_has_no_lanes(project, monkeypatch):
    _payload(monkeypatch, {"revision": 1})
    state = bleed_inspection._gate_state(project, "host", load_defaults())
    assert _dump(state) == _dump({"gate": {"revision": 1}, "lanes": []})


def test_gate_state_for_an_unknown_track_is_the_empty_gate(project):
    state = bleed_inspection._gate_state(project, "nobody", load_defaults())
    assert state == {"gate": {}, "lanes": []}
    assert list(state) == ["gate", "lanes"]


def test_gate_state_digest_is_stable_for_a_fixed_payload(project, monkeypatch):
    _payload(monkeypatch, {"revision": 1, "inputs": [{"track_id": "host"}]})
    first = bleed_inspection.state_digest(
        bleed_inspection._gate_state(project, "host", load_defaults())
    )
    second = bleed_inspection.state_digest(
        bleed_inspection._gate_state(project, "host", load_defaults())
    )
    assert first == second
    assert first == "6bba45ce97553df115b33d2ef96f4278e7ad352cebadf617fe3886f1433f9a39"
