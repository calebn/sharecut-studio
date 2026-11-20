"""The embedded engine installs the in-process FFmpeg backend at start, only where it can run."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from podcast_mcp.gui import embedded
from podcast_mcp.gui.bind import BOOT_TOKEN_ENV
from podcast_mcp.util import native_ffmpeg
from podcast_mcp.util.host_platform import IOS, MACOS


@pytest.fixture(autouse=True)
def engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(embedded, "_ENGINE", embedded._Engine())
    monkeypatch.setenv(BOOT_TOKEN_ENV, "boot-token-for-tests")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    yield
    embedded.stop()


def _calls(monkeypatch: pytest.MonkeyPatch, *, available: bool, installs: bool = True):
    calls: list[str] = []

    def is_available() -> bool:
        calls.append("is_available")
        return available

    def install() -> bool:
        calls.append("install")
        return installs

    monkeypatch.setattr(native_ffmpeg, "is_available", is_available)
    monkeypatch.setattr(native_ffmpeg, "install_native_backend", install)
    return calls


def test_a_linked_library_on_the_in_process_row_is_installed(host, monkeypatch) -> None:
    host(IOS)
    calls = _calls(monkeypatch, available=True)
    embedded._install_media_tools()
    assert calls == ["is_available", "install"]


def test_an_unlinked_library_installs_nothing_and_says_so(host, monkeypatch, caplog) -> None:
    host(IOS)
    calls = _calls(monkeypatch, available=False)
    with caplog.at_level(logging.WARNING, logger=embedded.log.name):
        embedded._install_media_tools()
    assert calls == ["is_available"]
    assert "not linked" in caplog.text


def test_a_backend_that_will_not_install_is_logged_not_raised(host, monkeypatch, caplog) -> None:
    host(IOS)
    _calls(monkeypatch, available=True, installs=False)
    with caplog.at_level(logging.WARNING, logger=embedded.log.name):
        embedded._install_media_tools()
    assert "not installed" in caplog.text


def test_a_native_surprise_never_fails_the_boot(host, monkeypatch, caplog) -> None:
    host(IOS)

    def boom() -> bool:
        raise ValueError("native surprise")

    monkeypatch.setattr(native_ffmpeg, "is_available", boom)
    with caplog.at_level(logging.WARNING, logger=embedded.log.name):
        embedded._install_media_tools()
    assert "install failed" in caplog.text


def test_a_desktop_row_never_touches_the_native_module(host, monkeypatch) -> None:
    host(MACOS)
    calls = _calls(monkeypatch, available=True)
    embedded._install_media_tools()
    assert calls == []


def test_start_installs_before_the_app_is_built(host, monkeypatch) -> None:
    host(IOS)
    calls = _calls(monkeypatch, available=False)
    seen: list[list[str]] = []
    real_bind = embedded.exclusive_listen_socket

    def socket_after_install(*args, **kwargs):
        seen.append(list(calls))
        return real_bind(*args, **kwargs)

    monkeypatch.setattr(embedded, "exclusive_listen_socket", socket_after_install)
    embedded.start()
    assert seen == [["is_available"]]
