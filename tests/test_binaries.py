from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.util import binaries


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
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

    # Patch via sys.modules so we never import a broken/partial static_ffmpeg.
    mock_run = MagicMock()
    with patch.dict("sys.modules", {"static_ffmpeg": MagicMock(run=mock_run)}):
        result = binaries.bootstrap_ffmpeg()

    mock_run.get_or_fetch_platform_executables_else_raise.assert_not_called()
    assert result == (dest_ffmpeg, dest_ffprobe)


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
