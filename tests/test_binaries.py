from __future__ import annotations

import os
import shutil
import socket
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.util import binaries


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(binaries.platform, "system", lambda: "Linux")
    monkeypatch.delenv("PODCAST_MCP_FFMPEG", raising=False)
    monkeypatch.delenv("PODCAST_MCP_FFPROBE", raising=False)


def test_resolve_ffmpeg_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_FFMPEG", "/opt/custom/ffmpeg")
    assert binaries.resolve_ffmpeg() == "/opt/custom/ffmpeg"


def test_resolve_ffprobe_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", "/opt/custom/ffprobe")
    assert binaries.resolve_ffprobe() == "/opt/custom/ffprobe"


def test_resolve_ffmpeg_prefers_system_path() -> None:
    with patch.object(binaries.shutil, "which", return_value="/usr/bin/ffmpeg"):
        assert binaries.resolve_ffmpeg() == "/usr/bin/ffmpeg"


def test_resolve_ffprobe_prefers_system_path() -> None:
    with patch.object(binaries.shutil, "which", return_value="/usr/bin/ffprobe"):
        assert binaries.resolve_ffprobe() == "/usr/bin/ffprobe"


def test_resolve_ffmpeg_falls_back_to_bootstrap_cache() -> None:
    cached = binaries.bin_cache_dir() / "ffmpeg"
    cached.write_bytes(b"fake")
    with patch.object(binaries.shutil, "which", return_value=None):
        assert binaries.resolve_ffmpeg() == str(cached)


def test_resolve_ffprobe_falls_back_to_bootstrap_cache() -> None:
    cached = binaries.bin_cache_dir() / "ffprobe"
    cached.write_bytes(b"fake")
    with patch.object(binaries.shutil, "which", return_value=None):
        assert binaries.resolve_ffprobe() == str(cached)


def test_resolve_ffmpeg_falls_back_to_literal_when_nothing_found() -> None:
    with patch.object(binaries.shutil, "which", return_value=None):
        assert binaries.resolve_ffmpeg() == "ffmpeg"


def test_resolve_ffprobe_falls_back_to_literal_when_nothing_found() -> None:
    with patch.object(binaries.shutil, "which", return_value=None):
        assert binaries.resolve_ffprobe() == "ffprobe"


def _executable_pair(directory: Path) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    commands = (directory / "ffmpeg", directory / "ffprobe")
    for command in commands:
        command.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        command.chmod(0o755)
    return commands


def test_pair_prefers_native_homebrew_before_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    native_dir = tmp_path / "homebrew" / "opt" / "ffmpeg" / "bin"
    path_dir = tmp_path / "path"
    _executable_pair(native_dir)
    _executable_pair(path_dir)
    monkeypatch.setattr(binaries.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(binaries.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: binaries._pair_in(native_dir))
    monkeypatch.setenv("PATH", str(path_dir))

    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(
        str(native_dir / "ffmpeg"), str(native_dir / "ffprobe")
    )


def test_pair_uses_first_complete_path_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    partial = tmp_path / "partial"
    first = tmp_path / "first"
    second = tmp_path / "second"
    partial.mkdir()
    (partial / "ffmpeg").write_text("not executable", encoding="utf-8")
    _executable_pair(first)
    _executable_pair(second)
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", os.pathsep.join(map(str, (partial, first, second))))

    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(
        str(first / "ffmpeg"), str(first / "ffprobe")
    )


def test_pair_uses_cache_only_when_path_has_no_complete_pair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_dir = tmp_path / "path"
    path_dir.mkdir()
    (path_dir / "ffmpeg").write_text("partial", encoding="utf-8")
    cached = binaries.bin_cache_dir()
    _executable_pair(cached)
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", str(path_dir))

    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(
        str(cached / "ffmpeg"), str(cached / "ffprobe")
    )


def test_pair_rejects_non_executable_companion_and_missing_pair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_dir = tmp_path / "path"
    path_dir.mkdir()
    (path_dir / "ffmpeg").write_text("#!/bin/sh\n", encoding="utf-8")
    (path_dir / "ffmpeg").chmod(0o755)
    (path_dir / "ffprobe").write_text("not executable", encoding="utf-8")
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", str(path_dir))

    with pytest.raises(binaries.FFmpegPairResolutionError, match="executable pair"):
        binaries.resolve_ffmpeg_pair()


def test_pair_does_not_combine_commands_from_separate_path_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ffmpeg_dir, ffprobe_dir = tmp_path / "ffmpeg-only", tmp_path / "ffprobe-only"
    _executable_pair(ffmpeg_dir)
    _executable_pair(ffprobe_dir)
    (ffmpeg_dir / "ffprobe").unlink()
    (ffprobe_dir / "ffmpeg").unlink()
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", os.pathsep.join((str(ffmpeg_dir), str(ffprobe_dir))))

    with pytest.raises(binaries.FFmpegPairResolutionError, match="executable pair"):
        binaries.resolve_ffmpeg_pair()


def test_pair_is_platform_gated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(binaries.platform, "system", lambda: "Linux")
    monkeypatch.setattr(binaries.platform, "machine", lambda: "arm64")
    assert binaries._native_homebrew_pair() is None


def test_pair_preserves_explicit_values_and_uses_constructor_over_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_MCP_FFMPEG", "/bad/env-ffmpeg")
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", "/bad/env-ffprobe")

    assert binaries.resolve_ffmpeg_pair("bad ffmpeg", "bad ffprobe") == binaries.FFmpegPair(
        "bad ffmpeg", "bad ffprobe"
    )
    assert binaries.resolve_ffmpeg_pair(ffmpeg="chosen ffmpeg") == binaries.FFmpegPair(
        "chosen ffmpeg", "/bad/env-ffprobe"
    )


def test_pair_can_use_executable_sibling_for_one_explicit_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ffmpeg, ffprobe = _executable_pair(tmp_path / "explicit")
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", "")

    assert binaries.resolve_ffmpeg_pair(ffmpeg=str(ffmpeg)) == binaries.FFmpegPair(
        str(ffmpeg), str(ffprobe)
    )


def test_pair_does_not_rank_versions_or_run_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, later = tmp_path / "first", tmp_path / "later"
    _executable_pair(first)
    _executable_pair(later)
    monkeypatch.setattr(binaries, "_native_homebrew_pair", lambda: None)
    monkeypatch.setenv("PATH", os.pathsep.join((str(first), str(later))))
    with (
        patch(
            "subprocess.run", side_effect=AssertionError("resolution must not inspect a version")
        ),
        patch.object(
            socket,
            "create_connection",
            side_effect=AssertionError("resolution must not access the network"),
        ),
    ):
        assert binaries.resolve_ffmpeg_pair().ffmpeg == str(first / "ffmpeg")


def test_ffmpeg_source_classification() -> None:
    cached_path = str(binaries.bin_cache_dir() / "ffmpeg")
    assert binaries.ffmpeg_source("ffmpeg") == "not found"
    assert binaries.ffmpeg_source(cached_path) == "bundled"
    assert binaries.ffmpeg_source("/usr/bin/ffmpeg") == "system"


def test_bootstrap_ffmpeg_prefers_cdn(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"cdn-binary")
        dest.chmod(0o755)
        return "cdn"

    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.bootstrap_cdn_base",
        lambda: "https://cdn.example.test",
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.cdn_url_for",
        lambda asset_id, rel: f"https://cdn.example.test/{rel}",
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.ffmpeg_cdn_pins",
        lambda: ("a" * 64, "b" * 64),
    )
    monkeypatch.setattr("podcast_mcp.util.asset_sources.download_first_ok", fake_download)
    mock_run = MagicMock()
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        ffmpeg_path, ffprobe_path = binaries.bootstrap_ffmpeg()

    mock_run.get_or_fetch_platform_executables_else_raise.assert_not_called()
    assert ffmpeg_path.read_bytes() == b"cdn-binary"
    assert ffprobe_path.read_bytes() == b"cdn-binary"


def test_bootstrap_ffmpeg_skips_cdn_without_sha_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.bootstrap_cdn_base",
        lambda: "https://cdn.example.test",
    )
    monkeypatch.setattr("podcast_mcp.util.asset_sources.ffmpeg_cdn_pins", lambda: None)
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.download_first_ok",
        MagicMock(side_effect=AssertionError("CDN should be skipped")),
    )
    src_ffmpeg = binaries.bin_cache_dir() / "src_ffmpeg"
    src_ffprobe = binaries.bin_cache_dir() / "src_ffprobe"
    src_ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    src_ffmpeg.write_bytes(b"static ffmpeg")
    src_ffprobe.write_bytes(b"static ffprobe")
    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        ffmpeg_path, ffprobe_path = binaries.bootstrap_ffmpeg()
    mock_run.get_or_fetch_platform_executables_else_raise.assert_called_once()
    assert ffmpeg_path.read_bytes() == b"static ffmpeg"
    assert ffprobe_path.read_bytes() == b"static ffprobe"


def test_bootstrap_ffmpeg_skips_when_already_cached() -> None:
    dest_ffmpeg = binaries.bin_cache_dir() / "ffmpeg"
    dest_ffprobe = binaries.bin_cache_dir() / "ffprobe"
    dest_ffmpeg.write_bytes(b"fake")
    dest_ffprobe.write_bytes(b"fake")
    dest_ffmpeg.chmod(0o755)
    dest_ffprobe.chmod(0o755)

    # Patch via sys.modules so we never import a broken/partial static_ffmpeg.
    mock_run = MagicMock()
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        result = binaries.bootstrap_ffmpeg()

    mock_run.get_or_fetch_platform_executables_else_raise.assert_not_called()
    assert result == (dest_ffmpeg, dest_ffprobe)


def test_bootstrap_ffmpeg_replaces_non_executable_cached_pair(tmp_path: Path) -> None:
    dest_ffmpeg = binaries.bin_cache_dir() / "ffmpeg"
    dest_ffprobe = binaries.bin_cache_dir() / "ffprobe"
    dest_ffmpeg.write_bytes(b"broken ffmpeg")
    dest_ffprobe.write_bytes(b"broken ffprobe")
    src_ffmpeg, src_ffprobe = tmp_path / "ffmpeg", tmp_path / "ffprobe"
    for source in (src_ffmpeg, src_ffprobe):
        source.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        result = binaries.bootstrap_ffmpeg()

    assert result == (dest_ffmpeg, dest_ffprobe)
    assert binaries.FFmpegPair(*map(str, result)).is_available()
    mock_run.get_or_fetch_platform_executables_else_raise.assert_called_once()


def test_bootstrap_ffmpeg_downloads_and_copies(tmp_path: Path) -> None:
    src_ffmpeg = tmp_path / "src_ffmpeg"
    src_ffprobe = tmp_path / "src_ffprobe"
    src_ffmpeg.write_bytes(b"real ffmpeg")
    src_ffprobe.write_bytes(b"real ffprobe")

    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        ffmpeg_path, ffprobe_path = binaries.bootstrap_ffmpeg()

    assert ffmpeg_path.read_bytes() == b"real ffmpeg"
    assert ffprobe_path.read_bytes() == b"real ffprobe"
    assert ffmpeg_path.parent == binaries.bin_cache_dir()


def test_bootstrap_ffmpeg_force_redownloads() -> None:
    dest_ffmpeg = binaries.bin_cache_dir() / "ffmpeg"
    dest_ffprobe = binaries.bin_cache_dir() / "ffprobe"
    dest_ffmpeg.write_bytes(b"stale")
    dest_ffprobe.write_bytes(b"stale")

    src_ffmpeg = dest_ffmpeg.parent / "fresh_ffmpeg"
    src_ffprobe = dest_ffmpeg.parent / "fresh_ffprobe"
    src_ffmpeg.write_bytes(b"fresh")
    src_ffprobe.write_bytes(b"fresh")

    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        binaries.bootstrap_ffmpeg(force=True)

    assert dest_ffmpeg.read_bytes() == b"fresh"
    mock_run.get_or_fetch_platform_executables_else_raise.assert_called_once()


def test_bootstrap_ffmpeg_force_copy_failure_removes_both_destinations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest_ffmpeg = binaries.bin_cache_dir() / "ffmpeg"
    dest_ffprobe = binaries.bin_cache_dir() / "ffprobe"
    dest_ffmpeg.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    dest_ffprobe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    dest_ffmpeg.chmod(0o755)
    dest_ffprobe.chmod(0o755)
    src_ffmpeg, src_ffprobe = tmp_path / "ffmpeg", tmp_path / "ffprobe"
    src_ffmpeg.write_text("new ffmpeg", encoding="utf-8")
    src_ffprobe.write_text("new ffprobe", encoding="utf-8")
    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    real_copy = shutil.copy2
    calls = 0

    def fail_second_copy(source, destination, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("second copy failed")
        return real_copy(source, destination, *args, **kwargs)

    monkeypatch.setattr(binaries.shutil, "copy2", fail_second_copy)
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        with pytest.raises(OSError, match="second copy failed"):
            binaries.bootstrap_ffmpeg(force=True)

    assert not dest_ffmpeg.exists()
    assert not dest_ffprobe.exists()
    assert not binaries.FFmpegPair(str(dest_ffmpeg), str(dest_ffprobe)).is_available()


def test_bootstrap_ffmpeg_raises_clear_error_without_static_ffmpeg() -> None:
    with patch.dict("sys.modules", {"static_ffmpeg": None}):
        with pytest.raises(ImportError, match="static-ffmpeg"):
            binaries.bootstrap_ffmpeg()


def test_bootstrap_ffmpeg_cdn_error_falls_back(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from podcast_mcp.util.asset_sources import AssetSourceError

    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.bootstrap_cdn_base",
        lambda: "https://cdn.example.test",
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.ffmpeg_cdn_pins",
        lambda: ("a" * 64, "b" * 64),
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.cdn_url_for",
        lambda *_a, **_k: "https://cdn.example.test/ff",
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.download_first_ok",
        MagicMock(side_effect=AssetSourceError("cdn 500")),
    )
    src_ffmpeg = binaries.bin_cache_dir() / "src_ffmpeg"
    src_ffprobe = binaries.bin_cache_dir() / "src_ffprobe"
    src_ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    src_ffmpeg.write_bytes(b"static ffmpeg")
    src_ffprobe.write_bytes(b"static ffprobe")
    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    caplog.set_level("WARNING")
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        ffmpeg_path, _fp = binaries.bootstrap_ffmpeg()
    assert ffmpeg_path.read_bytes() == b"static ffmpeg"
    assert "falling back to static-ffmpeg" in caplog.text


def test_bootstrap_ffmpeg_pin_lookup_error_skips_cdn(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.util.asset_sources import AssetSourceError

    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.bootstrap_cdn_base",
        lambda: "https://cdn.example.test",
    )
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.ffmpeg_cdn_pins",
        MagicMock(side_effect=AssetSourceError("no manifest")),
    )
    src_ffmpeg = binaries.bin_cache_dir() / "src_ffmpeg"
    src_ffprobe = binaries.bin_cache_dir() / "src_ffprobe"
    src_ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    src_ffmpeg.write_bytes(b"static ffmpeg")
    src_ffprobe.write_bytes(b"static ffprobe")
    mock_run = MagicMock()
    mock_run.get_or_fetch_platform_executables_else_raise.return_value = (
        str(src_ffmpeg),
        str(src_ffprobe),
    )
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        ffmpeg_path, _fp = binaries.bootstrap_ffmpeg()
    assert ffmpeg_path.read_bytes() == b"static ffmpeg"


@pytest.mark.parametrize("machine,prefix", [("arm64", "/opt/homebrew"), ("x86_64", "/usr/local")])
def test_native_prefix_routes_pair_and_single_command_consumers(monkeypatch, machine, prefix):
    monkeypatch.setattr(binaries.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(binaries.platform, "machine", lambda: machine)
    monkeypatch.setattr(Path, "is_file", lambda _path: True)
    monkeypatch.setattr(binaries.os, "access", lambda *_args: True)
    monkeypatch.setenv("PATH", "/old/bin")
    expected = binaries.FFmpegPair(
        str(Path(prefix, "opt", "ffmpeg", "bin", "ffmpeg").absolute()),
        str(Path(prefix, "opt", "ffmpeg", "bin", "ffprobe").absolute()),
    )
    assert binaries.resolve_ffmpeg_pair() == expected
    assert binaries.resolve_ffmpeg() == expected.ffmpeg
    assert binaries.resolve_ffprobe() == expected.ffprobe


def test_empty_environment_overrides_do_not_hide_automatic_pair(tmp_path, monkeypatch):
    commands = _executable_pair(tmp_path / "bin")
    monkeypatch.setenv("PATH", str(commands[0].parent))
    monkeypatch.setenv("PODCAST_MCP_FFMPEG", "")
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", "")
    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(*map(str, commands))
    assert binaries.resolve_ffmpeg_pair("", "invalid probe") == binaries.FFmpegPair(
        "", "invalid probe"
    )


def test_path_current_directory_pair_returns_absolute_commands(tmp_path, monkeypatch):
    partial = tmp_path / "partial"
    partial.mkdir()
    partial_command = partial / "ffmpeg"
    partial_command.write_text("#!/bin/sh\nexit 0\n")
    partial_command.chmod(0o755)
    cwd = tmp_path / "cwd"
    commands = _executable_pair(cwd)
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("PATH", str(partial) + os.pathsep)
    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(*map(str, commands))


def test_relative_explicit_path_can_use_current_directory_sibling(tmp_path, monkeypatch):
    commands = _executable_pair(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", "/missing")
    assert binaries.resolve_ffmpeg_pair("./ffmpeg") == binaries.FFmpegPair(
        "./ffmpeg", str(commands[1])
    )


def test_pair_availability_checks_each_selected_command(monkeypatch):
    found = {"ffmpeg": "ffmpeg", "ffprobe": "ffprobe"}
    monkeypatch.setattr(binaries.shutil, "which", lambda command: found.get(command))
    assert binaries.FFmpegPair("ffmpeg", "ffprobe").is_available() is True
    found.pop("ffprobe")
    assert binaries.FFmpegPair("ffmpeg", "ffprobe").is_available() is False
    assert binaries.FFmpegPair("ffmpeg", "/missing/ffprobe").is_available() is False


def test_windows_pair_uses_exe_suffix(tmp_path, monkeypatch):
    monkeypatch.setattr(binaries.platform, "system", lambda: "Windows")
    monkeypatch.setattr(binaries.os, "access", lambda path, _mode: Path(path).is_file())
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        path = tmp_path / name
        path.write_text("binary")
    monkeypatch.setenv("PATH", str(tmp_path))
    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(
        str(tmp_path / "ffmpeg.exe"), str(tmp_path / "ffprobe.exe")
    )


def test_windows_pair_requires_both_executables_and_preserves_per_slot_overrides(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(binaries.platform, "system", lambda: "Windows")
    monkeypatch.setattr(binaries.os, "access", lambda path, _mode: Path(path).is_file())
    ffmpeg, ffprobe = (tmp_path / name for name in ("ffmpeg.exe", "ffprobe.exe"))
    ffmpeg.write_bytes(b"ffmpeg")
    ffprobe.write_bytes(b"ffprobe")
    monkeypatch.setenv("PATH", str(tmp_path))
    assert binaries.resolve_ffmpeg_pair() == binaries.FFmpegPair(str(ffmpeg), str(ffprobe))

    ffprobe.unlink()
    with pytest.raises(binaries.FFmpegPairResolutionError):
        binaries.resolve_ffmpeg_pair()
    ffprobe.write_bytes(b"ffprobe")
    assert binaries.resolve_ffmpeg_pair("custom-ffmpeg.exe", "custom-ffprobe.exe") == (
        binaries.FFmpegPair("custom-ffmpeg.exe", "custom-ffprobe.exe")
    )
    assert binaries.resolve_ffmpeg_pair("custom-ffmpeg.exe") == binaries.FFmpegPair(
        "custom-ffmpeg.exe", str(ffprobe)
    )
