"""Unit tests for host OS file dialog (no real GUI)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.gui.host_file_dialog import (
    HostPickResult,
    _normalize_chosen,
    pick_episode_project_path,
)
from podcast_mcp.util import process


def test_normalize_chosen_empty_is_cancelled() -> None:
    assert _normalize_chosen("") == HostPickResult(cancelled=True)
    assert _normalize_chosen("   ") == HostPickResult(cancelled=True)


def test_normalize_chosen_wrong_basename(tmp_path: Path) -> None:
    junk = tmp_path / "junk.json"
    junk.write_text("{}", encoding="utf-8")
    out = _normalize_chosen(str(junk))
    assert out.path == str(junk.resolve())
    assert out.detail is None


def test_normalize_chosen_directory(tmp_path: Path) -> None:
    out = _normalize_chosen(str(tmp_path))
    assert out.path == str((tmp_path / "episode.project.json").resolve())


def test_normalize_chosen_valid_file(tmp_path: Path) -> None:
    target = tmp_path / "episode.project.json"
    target.write_text("{}", encoding="utf-8")
    out = _normalize_chosen(str(target))
    assert out.path == str(target.resolve())


def test_pick_unknown_platform() -> None:
    out = pick_episode_project_path(system="Plan9")
    assert out.unavailable
    assert out.detail is not None


def test_pick_linux_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda _name: None,
    )
    out = pick_episode_project_path(system="Linux")
    assert out.unavailable
    assert out.detail is not None
    assert "zenity" in out.detail


def test_pick_linux_zenity_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/usr/bin/zenity" if name == "zenity" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=1, stdout="", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Linux")
    assert out.cancelled


def test_pick_linux_zenity_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "episode.project.json"
    target.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/usr/bin/zenity" if name == "zenity" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout=f"{target}\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Linux")
    assert out.path == str(target.resolve())


def test_pick_macos_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout="\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Darwin")
    assert out.cancelled


def test_pick_macos_nonzero_empty_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def _run(*_args, **_kwargs):
        return MagicMock(returncode=1, stdout="", stderr="osascript: failed")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Darwin")
    assert out.unavailable
    assert out.detail == "osascript: failed"
    assert not out.cancelled


def test_pick_macos_osascript_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    def _run(*_args, **_kwargs):
        raise FileNotFoundError("osascript")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Darwin")
    assert out.unavailable
    assert out.detail is not None
    assert "osascript" in out.detail

    def _run(*_args, **_kwargs):
        raise process.TimeoutExpired(cmd=["osascript"], timeout=1)

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Darwin")
    assert out.cancelled
    assert out.detail is not None


def test_pick_windows_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "episode.project.json"
    target.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/bin/powershell" if name == "powershell" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout=str(target), stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path(system="Windows")
    assert out.path == str(target.resolve())
