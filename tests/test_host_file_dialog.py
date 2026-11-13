"""Unit tests for host OS file dialog (no real GUI)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.gui.host_file_dialog import (
    HostPickResult,
    _normalize_chosen,
    pick_episode_project_path,
    pick_folder,
)
from podcast_mcp.util import process
from podcast_mcp.util.host_platform import GENERIC_POSIX, IOS, LINUX, MACOS, WINDOWS


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
    assert out.path == str((tmp_path / "episode.sharecut").resolve())


def test_normalize_chosen_valid_file(tmp_path: Path) -> None:
    target = tmp_path / "episode.sharecut"
    target.write_text("{}", encoding="utf-8")
    out = _normalize_chosen(str(target))
    assert out.path == str(target.resolve())


def test_pick_unknown_platform(host) -> None:
    host(replace(GENERIC_POSIX, system_label="Plan9"))
    out = pick_episode_project_path()
    assert out.unavailable
    assert out.detail == "No OS file dialog for platform 'Plan9'; paste the path instead."


def test_ios_has_no_file_dialog_and_never_spawns_one(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(IOS)
    monkeypatch.setattr(process, "run", lambda *_a, **_k: pytest.fail("spawned a dialog"))
    assert pick_episode_project_path() == HostPickResult(
        unavailable=True,
        detail="No OS file dialog for platform 'iOS'; paste the path instead.",
    )
    assert pick_folder() == HostPickResult(
        unavailable=True,
        detail="No OS folder dialog for platform 'iOS'; paste the path instead.",
    )


def test_pick_linux_unavailable(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(LINUX)
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda _name: None,
    )
    out = pick_episode_project_path()
    assert out.unavailable
    assert out.detail is not None
    assert "zenity" in out.detail


def test_pick_linux_zenity_cancel(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(LINUX)
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/usr/bin/zenity" if name == "zenity" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=1, stdout="", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.cancelled


def test_pick_linux_zenity_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(LINUX)
    target = tmp_path / "episode.sharecut"
    target.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/usr/bin/zenity" if name == "zenity" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout=f"{target}\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.path == str(target.resolve())


def test_pick_macos_cancel(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(MACOS)

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout="\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.cancelled


def test_pick_macos_nonzero_empty_is_unavailable(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(MACOS)

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=1, stdout="", stderr="osascript: failed")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.unavailable
    assert out.detail == "osascript: failed"
    assert not out.cancelled


def test_pick_macos_osascript_missing(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(MACOS)

    def _run(*_args, **_kwargs):
        raise FileNotFoundError("osascript")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.unavailable
    assert out.detail is not None
    assert "osascript" in out.detail

    def _run(*_args, **_kwargs):
        raise process.TimeoutExpired(cmd=["osascript"], timeout=1)

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.cancelled
    assert out.detail is not None


def test_pick_windows_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(WINDOWS)
    target = tmp_path / "episode.sharecut"
    target.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.shutil.which",
        lambda name: "/bin/powershell" if name == "powershell" else None,
    )

    def _run(*_args, **_kwargs):
        return MagicMock(returncode=0, stdout=str(target), stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_episode_project_path()
    assert out.path == str(target.resolve())


def _which_only(name: str):
    return lambda candidate: f"/usr/bin/{name}" if candidate == name else None


def test_pick_folder_unknown_platform(host) -> None:
    host(replace(GENERIC_POSIX, system_label="Plan9"))
    assert pick_folder().unavailable


def test_pick_folder_linux_zenity_asks_for_a_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(LINUX)
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", _which_only("zenity"))
    seen: list[list[str]] = []

    def _run(argv, **_kwargs):
        seen.append(argv)
        return MagicMock(returncode=0, stdout=f"{tmp_path}\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    out = pick_folder()
    assert out.path == str(tmp_path.resolve())
    assert "--directory" in seen[0]


def test_pick_folder_linux_kdialog_asks_for_a_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(LINUX)
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", _which_only("kdialog"))
    seen: list[list[str]] = []

    def _run(argv, **_kwargs):
        seen.append(argv)
        return MagicMock(returncode=0, stdout=f"{tmp_path}\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    assert pick_folder().path == str(tmp_path.resolve())
    assert "--getexistingdirectory" in seen[0]


def test_pick_folder_linux_cancel_and_missing_tools(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(LINUX)
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", _which_only("zenity"))
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.process.run",
        lambda *_a, **_k: MagicMock(returncode=1, stdout="", stderr=""),
    )
    assert pick_folder().cancelled
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", lambda _n: None)
    assert pick_folder().unavailable


def test_pick_folder_macos_chooses_a_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(MACOS)
    seen: list[list[str]] = []

    def _run(argv, **_kwargs):
        seen.append(argv)
        return MagicMock(returncode=0, stdout=f"{tmp_path}/\n", stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    assert pick_folder().path == str(tmp_path.resolve())
    assert "choose folder" in seen[0][-1]


def test_pick_folder_macos_cancel_and_failure(monkeypatch: pytest.MonkeyPatch, host) -> None:
    host(MACOS)
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.process.run",
        lambda *_a, **_k: MagicMock(returncode=0, stdout="\n", stderr=""),
    )
    assert pick_folder().cancelled
    monkeypatch.setattr(
        "podcast_mcp.gui.host_file_dialog.process.run",
        lambda *_a, **_k: MagicMock(returncode=1, stdout="", stderr="osascript: failed"),
    )
    out = pick_folder()
    assert out.unavailable
    assert out.detail == "osascript: failed"


def test_pick_folder_windows_uses_the_folder_browser(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(WINDOWS)
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", _which_only("powershell"))
    seen: list[list[str]] = []

    def _run(argv, **_kwargs):
        seen.append(argv)
        return MagicMock(returncode=0, stdout=str(tmp_path), stderr="")

    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.process.run", _run)
    assert pick_folder().path == str(tmp_path.resolve())
    assert "FolderBrowserDialog" in seen[0][-1]
    monkeypatch.setattr("podcast_mcp.gui.host_file_dialog.shutil.which", lambda _n: None)
    assert pick_folder().unavailable
