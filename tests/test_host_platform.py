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
    UNKNOWN,
    WINDOWS,
    DataRoots,
    ForeignKernelError,
    HostPlatform,
    current,
    syscall_kernel,
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


def test_the_unknown_row_has_no_capability_and_no_trust() -> None:
    assert _fields(UNKNOWN) == {
        "name": "unknown",
        "kernel": "other",
        "system_label": "",
        "can_spawn_processes": False,
        "loopback_is_trusted": False,
        "media_tools": "unavailable",
        "transcription": "unavailable",
        "file_dialog": None,
        "reveal_tool": None,
        "audition_player": None,
        "homebrew_ffmpeg": False,
        "executable_suffix": "",
        "app_container": False,
    }


@pytest.mark.parametrize(
    ("row", "is_nt", "is_posix"),
    [
        (MACOS, False, True),
        (LINUX, False, True),
        (IOS, False, True),
        (GENERIC_POSIX, False, True),
        (UNKNOWN, False, True),
        (WINDOWS, True, False),
        (GENERIC_NT, True, False),
    ],
)
def test_nt_and_posix_flavour(row: HostPlatform, is_nt: bool, is_posix: bool) -> None:
    assert (row.is_nt, row.is_posix) == (is_nt, is_posix)


@pytest.mark.parametrize("row", [MACOS, LINUX, WINDOWS, GENERIC_POSIX, GENERIC_NT, UNKNOWN])
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


@pytest.mark.parametrize(
    ("sys_platform", "os_name", "system", "expected"),
    [
        ("freebsd14", "posix", "FreeBSD", GENERIC_POSIX),
        ("openbsd7", "posix", "OpenBSD", GENERIC_POSIX),
        ("netbsd9", "posix", "NetBSD", GENERIC_POSIX),
        ("dragonfly6", "posix", "DragonFly", GENERIC_POSIX),
        ("sunos5", "posix", "SunOS", GENERIC_POSIX),
        ("aix7", "posix", "AIX", GENERIC_POSIX),
        ("msys", "posix", "MSYS_NT-10.0", GENERIC_POSIX),
        ("cygwin", "nt", "CYGWIN_NT-10.0", GENERIC_NT),
    ],
)
def test_a_desktop_kernel_family_gets_its_trusted_generic_row_with_its_reported_name(
    monkeypatch: pytest.MonkeyPatch,
    sys_platform: str,
    os_name: str,
    system: str,
    expected: HostPlatform,
) -> None:
    monkeypatch.setattr(sys, "platform", sys_platform)
    monkeypatch.setattr(os, "name", os_name)
    monkeypatch.setattr(platform, "system", lambda: system)
    row = current()
    assert row == dataclasses.replace(expected, system_label=system)
    assert (row.can_spawn_processes, row.loopback_is_trusted) == (True, True)


@pytest.mark.parametrize("sys_platform", ["android", "wasi", "emscripten", "somethingnew"])
def test_any_other_platform_fails_closed(
    monkeypatch: pytest.MonkeyPatch, sys_platform: str
) -> None:
    monkeypatch.setattr(sys, "platform", sys_platform)
    monkeypatch.setattr(platform, "system", lambda: "Mystery")
    row = current()
    assert row == dataclasses.replace(UNKNOWN, system_label="Mystery")
    assert (row.can_spawn_processes, row.loopback_is_trusted) == (False, False)
    assert (row.media_tools, row.transcription) == ("unavailable", "unavailable")
    assert (row.file_dialog, row.reveal_tool, row.audition_player) == (None, None, None)


def test_every_desktop_family_prefix_is_named_in_one_table() -> None:
    assert host_platform.DESKTOP_KERNEL_FAMILIES == (
        "freebsd",
        "openbsd",
        "netbsd",
        "dragonfly",
        "sunos",
        "aix",
        "cygwin",
        "msys",
    )


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


def _a_row_of_another_kernel() -> HostPlatform:
    return next(row for row in (MACOS, LINUX, WINDOWS) if row.kernel != current().kernel)


def test_syscall_kernel_is_the_real_kernel_without_an_override() -> None:
    assert syscall_kernel() == current().kernel


def test_syscall_kernel_accepts_a_row_built_from_the_real_one() -> None:
    row = dataclasses.replace(current(), name="app-container", app_container=True)
    with using(row):
        assert syscall_kernel() == current().kernel


def test_syscall_kernel_refuses_a_row_of_another_kernel() -> None:
    real = current()
    foreign = _a_row_of_another_kernel()
    with using(foreign), pytest.raises(ForeignKernelError) as refused:
        syscall_kernel()
    assert str(refused.value) == (
        f"a test selected the {foreign.name} row and reached a {foreign.kernel} syscall on a "
        f"{real.name} machine; build the row with dataclasses.replace(current(), ...), or pass "
        "real_syscalls=False to using() when the test replaces the syscall layer"
    )


def test_syscall_kernel_lets_a_test_that_replaces_the_syscall_layer_opt_in() -> None:
    foreign = _a_row_of_another_kernel()
    with using(foreign, real_syscalls=False):
        assert syscall_kernel() == foreign.kernel
    with using(foreign), pytest.raises(ForeignKernelError):
        syscall_kernel()


def test_the_opt_in_does_not_leak_to_the_enclosing_block() -> None:
    foreign = _a_row_of_another_kernel()
    with using(foreign, real_syscalls=False):
        with using(foreign), pytest.raises(ForeignKernelError):
            syscall_kernel()
        assert syscall_kernel() == foreign.kernel


def test_the_other_kernel_has_no_syscall_branch_to_guard() -> None:
    with using(GENERIC_POSIX):
        assert syscall_kernel() == "other"


def test_reported_machine_and_release_come_from_the_platform_module(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform, "machine", lambda: "arm64")
    monkeypatch.setattr(platform, "release", lambda: "25.6.0")
    assert (host_platform.machine(), host_platform.release()) == ("arm64", "25.6.0")
