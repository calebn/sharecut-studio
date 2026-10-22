"""RNNoise is refused at effect apply, not at render, when its model is absent (#2046)."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.effect_filters import require_rnnoise_model
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.util.model_missing import ModelMissing

COMMAND = "podcast bootstrap --component rnnoise"


@pytest.fixture
def project(minimal_project: Path) -> Path:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    return save_project(proj, minimal_project)


@pytest.fixture
def model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "models" / "rnnoise.rnnn"
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(path))
    return path


def _history_len(project: Path) -> int:
    return len(load_project(project).history.entries)


@pytest.mark.parametrize(
    "call",
    [
        {"preset": "noise_reduction_rnnoise"},
        {"effect": "arnndn"},
        {"effect": "arnndn", "params": {}},
    ],
    ids=["preset", "effect", "effect-empty-params"],
)
def test_apply_without_the_model_is_refused_and_leaves_no_history(
    project: Path, model: Path, call: dict
) -> None:
    before = project.read_bytes()
    entries = _history_len(project)
    with pytest.raises(ModelMissing) as caught:
        AnalysisService(ProjectWorkspace.open(project)).add_effect(track_id="host", **call)
    assert caught.value.id == "rnnoise"
    assert caught.value.command == COMMAND
    assert str(model.parent) not in str(caught.value)
    assert project.read_bytes() == before
    assert _history_len(project) == entries


def test_an_explicit_model_param_is_allowed(project: Path, model: Path) -> None:
    result = AnalysisService(ProjectWorkspace.open(project)).add_effect(
        track_id="host", effect="arnndn", params={"model": str(model)}
    )
    assert [e["effect"] for e in result["effects"]] == ["arnndn"]


def test_apply_with_the_model_installed_is_unchanged(project: Path, model: Path) -> None:
    model.parent.mkdir(parents=True)
    model.write_bytes(b"x")
    svc = AnalysisService(ProjectWorkspace.open(project))
    assert svc.add_effect(track_id="host", preset="noise_reduction_rnnoise")["effects"]
    assert svc.add_effect(track_id="host", effect="agate")["effects"]


def test_other_effects_never_ask_for_the_model(project: Path, model: Path) -> None:
    result = AnalysisService(ProjectWorkspace.open(project)).add_effect(
        track_id="host", effect="highpass"
    )
    assert [e["effect"] for e in result["effects"]] == ["highpass"]


def _add_effect_command() -> dict:
    return {
        "type": "AddEffect",
        "payload": {"track_id": "host", "preset": "noise_reduction_rnnoise"},
        "client_id": "v1",
        "role": "viewer",
        "client_seq": 1,
        "command_id": uuid4().hex,
    }


def test_document_command_route_answers_409_not_400(project: Path, model: Path) -> None:
    before = project.read_bytes()
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    res = client.post(
        "/api/document/command",
        params={"path": str(project)},
        json=_add_effect_command(),
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "model_needed"
    detail = res.json()["detail"]
    assert detail["model"]["id"] == "rnnoise"
    assert detail["model"]["command"] == COMMAND
    assert project.read_bytes() == before


def test_a_guest_cannot_reach_the_gate(published_share, project: Path, model: Path) -> None:
    _, _, share = published_share(capabilities=capabilities_for_role("editor"))
    res = TestClient(create_app()).post(
        f"/api/review/{share['token']}/daw/document/command", json=_add_effect_command()
    )
    assert res.status_code == 403
    assert res.headers["X-Sharecut-Error-Code"] != "model_needed"


def test_render_backstop_is_coded_and_names_no_path(model: Path) -> None:
    chain = ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="arnndn", params={})])
    with pytest.raises(ModelMissing) as caught:
        FFmpegEngine().build_track_filter(chain, None)
    assert caught.value.code == "model_needed"
    assert str(model) not in str(caught.value)
    with pytest.raises(ModelMissing):
        require_rnnoise_model()
    model.parent.mkdir(parents=True)
    model.write_bytes(b"x")
    assert require_rnnoise_model() == model
