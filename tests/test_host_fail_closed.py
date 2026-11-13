from __future__ import annotations

import errno
from pathlib import Path

import pytest

from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.util import process
from podcast_mcp.util.binaries import FFmpegPairResolutionError, resolve_ffmpeg_pair
from podcast_mcp.util.host_platform import IOS, MACOS


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)


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


def test_a_desktop_host_still_spawns(host) -> None:
    host(MACOS)
    assert process.run(["true"], check=True).returncode == 0


def test_a_host_without_media_tools_names_the_reason_in_one_sentence(host) -> None:
    host(IOS)
    with pytest.raises(FFmpegPairResolutionError) as refused:
        resolve_ffmpeg_pair(force_refresh=True)
    assert str(refused.value) == "ShareCut can't process audio on this device yet."


def test_bootstrap_status_reports_unsupported_components_and_the_host(host) -> None:
    host(IOS)
    status = boot.component_status()
    assert status["ready"] is False
    assert status["host"] == {
        "name": "ios",
        "can_spawn_processes": False,
        "loopback_is_trusted": False,
        "media_tools": "unavailable",
        "transcription": "unavailable",
    }
    assert status["tools"]["ffmpeg"] == {
        "state": "unsupported",
        "source": "not found",
        "hint": "ShareCut can't process audio on this device yet.",
    }
    whisper = next(row for row in status["models"] if row["id"] == "whisper")
    assert whisper["state"] == "unsupported"
    assert whisper["hint"] == "ShareCut can't transcribe audio on this device yet."


def test_bootstrap_status_on_a_desktop_host_reports_its_capabilities(host) -> None:
    host(MACOS)
    assert boot.component_status()["host"] == {
        "name": "macos",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
    }
