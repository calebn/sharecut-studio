from __future__ import annotations

import errno
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from host_session_helpers import LOOPBACK_PEER, exchange
from podcast_mcp.engines.models.registry import MODELS
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.util import native_ffmpeg, process
from podcast_mcp.util.binaries import FFmpegPairResolutionError, resolve_ffmpeg_pair
from podcast_mcp.util.host_platform import IOS, MACOS, UNKNOWN

MEDIA_SENTENCE = "ShareCut can't process audio on this device yet."


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "route-token")


def _route_status() -> dict[str, Any]:
    app = create_app()
    client = TestClient(app, client=LOOPBACK_PEER)
    headers: dict[str, str] = {}
    if app.state.host_sessions is None:
        headers["X-Podcast-Token"] = "route-token"
    else:
        exchange(client, app)
    response = client.get("/api/bootstrap/status", headers=headers)
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize("call", [process.run, process.popen])
def test_a_host_that_cannot_spawn_refuses_before_starting_anything(
    host, call, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process.subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    host(IOS)
    with pytest.raises(process.SpawnUnavailableError) as refused:
        call(["true"])
    assert refused.value.errno == errno.ENOSYS
    assert isinstance(refused.value, OSError)
    assert refused.value.strerror == "This device can't start other programs."


def test_a_host_that_is_not_known_cannot_spawn(host, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(process.subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    host(UNKNOWN)
    with pytest.raises(process.SpawnUnavailableError):
        process.run(["true"])


def test_a_desktop_host_still_spawns(host) -> None:
    host(MACOS)
    assert process.run(["true"], check=True).returncode == 0


def test_a_host_without_media_tools_names_the_reason_in_one_sentence(host) -> None:
    host(UNKNOWN)
    with pytest.raises(FFmpegPairResolutionError) as refused:
        resolve_ffmpeg_pair(force_refresh=True)
    assert str(refused.value) == "ShareCut can't process audio on this device yet."


def test_bootstrap_status_reports_unsupported_components_and_the_host(host) -> None:
    host(UNKNOWN)
    status = boot.component_status()
    assert status["ready"] is False
    assert status["host"] == {
        "name": "unknown",
        "can_spawn_processes": False,
        "loopback_is_trusted": False,
        "media_tools": "unavailable",
        "transcription": "unavailable",
        "folder_picker": False,
    }
    assert status["tools"]["ffmpeg"] == {
        "state": "unsupported",
        "source": "not found",
        "hint": "ShareCut can't process audio on this device yet.",
    }


def test_a_host_that_cannot_process_audio_reports_every_model_unsupported(host) -> None:
    host(UNKNOWN)
    for status in (boot.component_status(), _route_status()):
        assert [m["id"] for m in status["models"]] == [spec.id for spec in MODELS]
        for model in status["models"]:
            assert model["state"] == "unsupported", model["id"]
            assert model["hint"] == MEDIA_SENTENCE, model["id"]
            assert "bootstrap" not in model, model["id"]
            assert "path" not in model, model["id"]


def test_the_ios_row_without_a_linked_library_reports_tools_missing_and_models_unsupported(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: False)
    host(IOS)
    assert IOS.media_tools == "in_process"
    for status in (boot.component_status(), _route_status()):
        assert status["ready"] is False
        assert status["tools"]["ffmpeg"]["state"] == "missing"
        assert status["tools"]["ffmpeg"]["source"] == "in_process"
        for model in status["models"]:
            assert model["state"] == "unsupported", model["id"]
            assert model["hint"] == MEDIA_SENTENCE, model["id"]
            assert "bootstrap" not in model, model["id"]


def test_the_ios_row_with_a_linked_library_lets_models_report_their_own_state(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: True)
    host(IOS)
    states = {m["id"]: m["state"] for m in boot.component_status()["models"]}
    assert states["whisper"] == "unsupported"
    assert states["rnnoise"] != "unsupported"


def test_the_unsupported_fixture_matches_the_engine_answer(host) -> None:
    """The fixture keeps the iOS row as it was before media tools ran in-process."""
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "bootstrap_status" / "unsupported.json").read_text(
            encoding="utf-8"
        )
    )
    host(replace(IOS, media_tools="unavailable"))
    status = boot.component_status()
    assert fixture["host"] == status["host"]
    assert fixture["tools"] == status["tools"]
    assert fixture["models"] == status["models"]


def test_a_host_that_can_process_audio_but_not_transcribe_blocks_whisper_alone(host) -> None:
    host(replace(MACOS, transcription="unavailable"))
    states = {m["id"]: (m["state"], m.get("hint")) for m in boot.component_status()["models"]}
    assert states["whisper"] == (
        "unsupported",
        "ShareCut can't transcribe audio on this device yet.",
    )
    assert {i: s for i, (s, _) in states.items() if i != "whisper"} == {
        "rnnoise": "missing",
        "word-aligner": "missing",
        "speaker-ecapa": "missing",
    }


def test_a_desktop_host_reports_each_model_as_it_did_before(host) -> None:
    host(MACOS)
    for status in (boot.component_status(), _route_status()):
        assert [(m["id"], m["state"], m["bootstrap"]) for m in status["models"]] == [
            (
                "whisper",
                "missing",
                "podcast bootstrap --component whisper --whisper-model large-v3-turbo",
            ),
            ("rnnoise", "missing", "podcast bootstrap --component rnnoise"),
            ("word-aligner", "missing", "podcast bootstrap --component word-aligner"),
            ("speaker-ecapa", "missing", "podcast bootstrap --component speaker-ecapa"),
        ]


def test_bootstrap_status_on_a_desktop_host_reports_its_capabilities(host) -> None:
    host(MACOS)
    assert boot.component_status()["host"] == {
        "name": "macos",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
        "folder_picker": True,
    }
