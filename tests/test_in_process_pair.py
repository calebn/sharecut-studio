from __future__ import annotations

from dataclasses import replace

import pytest

from podcast_mcp.engines import ungated_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.services.pipeline import bootstrap, config
from podcast_mcp.services.support import doctor
from podcast_mcp.util import binaries, host_platform, native_ffmpeg, process
from podcast_mcp.util.binaries import (
    IN_PROCESS_BUILD_ID,
    IN_PROCESS_FFMPEG,
    IN_PROCESS_FFPROBE,
    IN_PROCESS_NOT_INSTALLED,
    IN_PROCESS_NOT_LINKED,
    IN_PROCESS_PAIR,
    FFmpegPair,
)

IN_PROCESS_ROW = replace(host_platform.IOS, media_tools="in_process")
DESKTOP_PAIR = FFmpegPair("/x/ffmpeg", "/x/ffprobe", (9, 0, 2), "explicit")


@pytest.fixture(autouse=True)
def isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    for variable in ("PODCAST_MCP_FFMPEG", "PODCAST_MCP_FFPROBE", "PODCAST_MCP_FFMPEG_BUNDLE"):
        monkeypatch.delenv(variable, raising=False)


def _forbid_native_lookups(monkeypatch) -> None:
    def refuse(name):
        def fail(*_args, **_kwargs):
            pytest.fail(name)

        return fail

    monkeypatch.setattr(binaries.shutil, "which", refuse("which"))
    monkeypatch.setattr(binaries, "run", refuse("run"))
    monkeypatch.setattr("podcast_mcp.util.process.run", refuse("process.run"))
    monkeypatch.setattr("podcast_mcp.util.process.popen", refuse("process.popen"))
    monkeypatch.setattr(ungated_audio, "file_stamp", refuse("file_stamp"))


def test_the_sentinel_pair_never_reports_ready_or_installed(monkeypatch, host):
    _forbid_native_lookups(monkeypatch)
    host(IN_PROCESS_ROW)

    pair = binaries.resolve_ffmpeg_pair()
    assert pair is IN_PROCESS_PAIR
    assert pair.is_available() is False
    assert FFmpegEngine().check_available() == (False, IN_PROCESS_NOT_LINKED)

    status = bootstrap.component_status()
    assert status["ready"] is False
    assert status["tools"]["ffmpeg"] == {
        "state": "missing",
        "source": "in_process",
        "hint": IN_PROCESS_NOT_LINKED,
    }
    assert config.component_status()["ffmpeg"] == {
        "state": "missing",
        "source": "in_process",
        "hint": IN_PROCESS_NOT_LINKED,
    }
    assert ungated_audio.ffmpeg_build_id() == (
        IN_PROCESS_FFMPEG,
        (0, 0, 0),
        IN_PROCESS_BUILD_ID,
    )
    info = doctor.ffmpeg_probe_info()
    assert info["ffmpeg"]["ok"] is False
    assert info["ffmpeg"]["path"] == IN_PROCESS_FFMPEG
    assert info["ffprobe"]["path"] == IN_PROCESS_FFPROBE
    assert info["ffprobe"]["version"] == IN_PROCESS_NOT_LINKED


def test_the_sentinel_never_reads_or_writes_the_desktop_pair_cache(monkeypatch, host):
    host(host_platform.LINUX)
    key = ("desktop-key",)
    binaries._PAIR_CACHE.put(key, DESKTOP_PAIR)
    size = len(binaries._PAIR_CACHE)

    def fail(*_args, **_kwargs):
        pytest.fail("cache key")

    monkeypatch.setattr(binaries, "_admission_cache_key", fail)
    with host_platform.using(IN_PROCESS_ROW):
        assert binaries.resolve_ffmpeg_pair() is IN_PROCESS_PAIR
        assert binaries.resolve_ffmpeg_pair(force_refresh=True) is IN_PROCESS_PAIR
    assert binaries._PAIR_CACHE.get(key) is DESKTOP_PAIR
    assert len(binaries._PAIR_CACHE) == size


@pytest.mark.parametrize("row", [host_platform.LINUX, host_platform.MACOS])
def test_a_desktop_row_keeps_its_build_id_and_status_payloads(monkeypatch, host, row):
    class Stamp:
        content = "stamp-content"

    monkeypatch.setattr(binaries.shutil, "which", lambda command: command)
    monkeypatch.setattr(ungated_audio, "resolve_ffmpeg_pair", lambda *_a, **_k: DESKTOP_PAIR)
    monkeypatch.setattr(ungated_audio, "file_stamp", lambda _path: Stamp())
    monkeypatch.setattr(bootstrap, "resolve_ffmpeg_pair", lambda *_a, **_k: DESKTOP_PAIR)
    monkeypatch.setattr(
        bootstrap, "model_status", lambda *_a, **_k: {"id": "whisper", "state": "installed"}
    )
    monkeypatch.setattr(binaries, "resolve_ffmpeg_pair", lambda *_a, **_k: DESKTOP_PAIR)
    host(row)

    assert ungated_audio.ffmpeg_build_id() == ("/x/ffmpeg", (9, 0, 2), "stamp-content")
    status = bootstrap.component_status()
    assert status["ready"] is True
    assert status["tools"] == {"ffmpeg": {"state": "installed", "source": "explicit", "hint": None}}
    assert config.component_status()["ffmpeg"] == {"state": "installed", "path": "/x/ffmpeg"}

    monkeypatch.setattr(binaries.shutil, "which", lambda _command: None)
    status = bootstrap.component_status()
    assert status["ready"] is False
    assert status["tools"] == {"ffmpeg": {"state": "missing", "source": "explicit", "hint": None}}
    assert config.component_status()["ffmpeg"] == {
        "state": "missing",
        "path": "/x/ffmpeg",
        "hint": "Install a matching FFmpeg 9.0.2 or later 9.x pair; see docs/setup.md",
    }


class _Backend:
    """Stands in for the native backend: only its presence in process.py matters here."""


def _statuses() -> tuple[dict, dict, dict, tuple[bool, str]]:
    return (
        bootstrap.component_status()["tools"]["ffmpeg"],
        config.component_status()["ffmpeg"],
        doctor.ffmpeg_probe_info()["ffmpeg"],
        FFmpegEngine().check_available(),
    )


def test_linked_and_installed_is_the_only_state_that_says_installed(monkeypatch, host):
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: True)
    host(IN_PROCESS_ROW)
    with process.using_in_process_backend(_Backend()):  # type: ignore[arg-type]
        assert native_ffmpeg.is_installed() is True
        boot, cfg, info, check = _statuses()
        assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "installed"
    assert boot["state"] == "installed" and boot["hint"] is None
    assert cfg == {"state": "installed", "source": "in_process"}
    assert info["ok"] is True and info["version"] == "in-process FFmpeg"
    assert check == (True, "in-process FFmpeg")


def test_linked_but_not_installed_is_missing_with_its_own_hint(monkeypatch, host):
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: True)
    host(IN_PROCESS_ROW)
    assert native_ffmpeg.is_installed() is False
    boot, cfg, info, check = _statuses()
    assert boot["state"] == "missing"
    assert boot["hint"] == IN_PROCESS_NOT_INSTALLED != IN_PROCESS_NOT_LINKED
    assert cfg == {"state": "missing", "source": "in_process", "hint": IN_PROCESS_NOT_INSTALLED}
    assert info["ok"] is False and info["version"] == IN_PROCESS_NOT_INSTALLED
    assert check == (False, IN_PROCESS_NOT_INSTALLED)
    assert bootstrap.component_status()["ready"] is False


def test_unlinked_is_missing_with_the_not_linked_hint(monkeypatch, host):
    monkeypatch.setattr(native_ffmpeg, "is_available", lambda: False)
    host(IN_PROCESS_ROW)
    boot, cfg, info, check = _statuses()
    assert boot["state"] == "missing" and boot["hint"] == IN_PROCESS_NOT_LINKED
    assert cfg["hint"] == IN_PROCESS_NOT_LINKED
    assert info["version"] == IN_PROCESS_NOT_LINKED
    assert check == (False, IN_PROCESS_NOT_LINKED)
