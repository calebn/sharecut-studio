from __future__ import annotations

import dataclasses
import os
import platform
import sys
from pathlib import Path

import pytest

from podcast_mcp.util import host_platform
from podcast_mcp.util.host_platform import (
    GENERIC_NT,
    GENERIC_POSIX,
    IOS,
    LINUX,
    MACOS,
    WINDOWS,
    DataRoots,
    HostPlatform,
    current,
    using,
)

HOME = Path("/h/user")


def _fields(row: HostPlatform) -> dict[str, object]:
    return dataclasses.asdict(row)


def test_macos_row() -> None:
    assert _fields(MACOS) == {
        "name": "macos",
        "kernel": "darwin",
        "system_label": "Darwin",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
        "file_dialog": "osascript",
        "reveal_tool": "open",
        "audition_player": "afplay",
        "homebrew_ffmpeg": True,
        "executable_suffix": "",
        "app_container": False,
    }


def test_linux_row() -> None:
    assert _fields(LINUX) == {
        "name": "linux",
        "kernel": "linux",
        "system_label": "Linux",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
        "file_dialog": "zenity",
        "reveal_tool": "xdg-open",
        "audition_player": "ffplay",
        "homebrew_ffmpeg": False,
        "executable_suffix": "",
        "app_container": False,
    }


def test_windows_row() -> None:
    assert _fields(WINDOWS) == {
        "name": "windows",
        "kernel": "nt",
        "system_label": "Windows",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
        "file_dialog": "powershell",
        "reveal_tool": "explorer",
        "audition_player": "ffplay",
        "homebrew_ffmpeg": False,
        "executable_suffix": ".exe",
        "app_container": False,
    }


def test_ios_row_shares_the_darwin_kernel_and_loses_every_desktop_capability() -> None:
    assert _fields(IOS) == {
        "name": "ios",
        "kernel": "darwin",
        "system_label": "iOS",
        "can_spawn_processes": False,
        "loopback_is_trusted": False,
        "media_tools": "unavailable",
        "transcription": "unavailable",
        "file_dialog": None,
        "reveal_tool": None,
        "audition_player": None,
        "homebrew_ffmpeg": False,
        "executable_suffix": "",
        "app_container": True,
    }


def test_generic_rows() -> None:
    assert _fields(GENERIC_POSIX) == {
        "name": "posix",
        "kernel": "other",
        "system_label": "",
        "can_spawn_processes": True,
        "loopback_is_trusted": True,
        "media_tools": "executables",
        "transcription": "faster_whisper",
        "file_dialog": None,
        "reveal_tool": None,
        "audition_player": "ffplay",
        "homebrew_ffmpeg": False,
        "executable_suffix": "",
        "app_container": False,
    }
    assert dataclasses.replace(GENERIC_NT, name="posix", kernel="other", executable_suffix="") == (
        GENERIC_POSIX
    )
    assert (GENERIC_NT.name, GENERIC_NT.kernel, GENERIC_NT.executable_suffix) == (
        "nt",
        "nt",
        ".exe",
    )


@pytest.mark.parametrize(
    ("row", "is_nt", "is_posix"),
    [
        (MACOS, False, True),
        (LINUX, False, True),
        (IOS, False, True),
        (GENERIC_POSIX, False, True),
        (WINDOWS, True, False),
        (GENERIC_NT, True, False),
    ],
)
def test_nt_and_posix_flavour(row: HostPlatform, is_nt: bool, is_posix: bool) -> None:
    assert (row.is_nt, row.is_posix) == (is_nt, is_posix)


@pytest.mark.parametrize("row", [MACOS, LINUX, WINDOWS, GENERIC_POSIX, GENERIC_NT])
def test_desktop_rows_keep_the_dotfile_data_layout(row: HostPlatform) -> None:
    assert row.data_roots(HOME) == DataRoots(
        config=Path("/h/user/.config/podcast_mcp"),
        cache=Path("/h/user/.cache/podcast_mcp"),
        state=Path("/h/user/.podcast_mcp"),
        workspace=Path("/h/user/ShareCut"),
        exports=Path("/h/user/Downloads"),
        log_dirs=(
            Path("/h/user/Library/Logs/ShareCut Studio"),
            Path("/h/user/.local/state/SharecutStudio"),
        ),
        trust_root=None,
    )


def test_ios_data_roots_live_in_the_app_container() -> None:
    container = Path("/var/mobile/Containers/Data/Application/ABC")
    assert IOS.data_roots(container) == DataRoots(
        config=Path(
            "/var/mobile/Containers/Data/Application/ABC/Library/Application Support/ShareCut"
        ),
        cache=Path("/var/mobile/Containers/Data/Application/ABC/Library/Caches/ShareCut"),
        state=Path(
            "/var/mobile/Containers/Data/Application/ABC/Library/Application Support/ShareCut/state"
        ),
        workspace=Path("/var/mobile/Containers/Data/Application/ABC/Documents"),
        exports=Path("/var/mobile/Containers/Data/Application/ABC/Documents/Exports"),
        log_dirs=(Path("/var/mobile/Containers/Data/Application/ABC/Library/Logs/ShareCut"),),
        trust_root=container,
    )


@pytest.mark.parametrize(
    ("sys_platform", "expected"),
    [
        ("darwin", MACOS),
        ("linux", LINUX),
        ("linux2", LINUX),
        ("win32", WINDOWS),
        ("ios", IOS),
    ],
)
def test_current_maps_each_listed_platform_to_its_row(
    monkeypatch: pytest.MonkeyPatch, sys_platform: str, expected: HostPlatform
) -> None:
    monkeypatch.setattr(sys, "platform", sys_platform)
    assert current() is expected


def test_current_gives_an_unlisted_platform_a_generic_row_with_its_reported_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with monkeypatch.context() as scope:
        scope.setattr(sys, "platform", "freebsd14")
        scope.setattr(os, "name", "posix")
        scope.setattr(platform, "system", lambda: "FreeBSD")
        posix = current()
    with monkeypatch.context() as scope:
        scope.setattr(sys, "platform", "cygwin")
        scope.setattr(os, "name", "nt")
        scope.setattr(platform, "system", lambda: "CYGWIN_NT-10.0")
        nt = current()
    assert posix == dataclasses.replace(GENERIC_POSIX, system_label="FreeBSD")
    assert nt == dataclasses.replace(GENERIC_NT, system_label="CYGWIN_NT-10.0")


def test_using_selects_a_row_and_restores_the_previous_one() -> None:
    outer = current()
    with using(IOS):
        assert current() is IOS
        with using(WINDOWS):
            assert current() is WINDOWS
        assert current() is IOS
    assert current() is outer


def test_using_restores_the_previous_row_when_the_block_raises() -> None:
    outer = current()
    with pytest.raises(RuntimeError), using(IOS):
        raise RuntimeError("boom")
    assert current() is outer


def test_reported_machine_and_release_come_from_the_platform_module(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform, "machine", lambda: "arm64")
    monkeypatch.setattr(platform, "release", lambda: "25.6.0")
    assert (host_platform.machine(), host_platform.release()) == ("arm64", "25.6.0")
