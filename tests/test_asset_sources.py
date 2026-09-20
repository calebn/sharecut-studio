"""Bootstrap asset URL ordering and CDN fallback (no network)."""

from __future__ import annotations

import hashlib
import io
import urllib.request
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.util.asset_sources import (
    AssetSourceError,
    _copy_bounded,
    _download_url,
    _https_opener,
    _HttpsRedirectHandler,
    _is_blocked_host,
    _sanitize_cdn_base,
    asset_entry,
    bootstrap_cdn_base,
    cdn_base_configured,
    cdn_url_for,
    download_first_ok,
    ffmpeg_cdn_pins,
    ffmpeg_cdn_relative_paths,
    ffmpeg_platform_slug,
    load_manifest,
    manifest_path,
    ordered_http_urls,
)


def test_ordered_http_urls_prefers_cdn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/bootstrap")
    urls = ordered_http_urls("rnnoise", relative_path="somnolent-hogwash.rnnn")
    assert urls[0] == ("https://cdn.example.test/bootstrap/models/rnnoise/somnolent-hogwash.rnnn")
    assert urls[1].startswith("https://raw.githubusercontent.com/")


def test_ordered_http_urls_upstream_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    urls = ordered_http_urls("rnnoise", relative_path="somnolent-hogwash.rnnn")
    assert len(urls) == 1
    assert urls[0].startswith("https://raw.githubusercontent.com/")


def test_download_first_ok_falls_back(tmp_path: Path) -> None:
    dest = tmp_path / "file.bin"
    calls: list[str] = []

    def fake_download(url: str, path: Path, **kwargs: object) -> None:
        calls.append(url)
        if "cdn" in url:
            raise OSError("404")
        path.write_bytes(b"ok")

    with patch("podcast_mcp.util.asset_sources._download_url", fake_download):
        label = download_first_ok(
            [
                "https://cdn.example.test/bootstrap/models/rnnoise/a.rnnn",
                "https://upstream.example/a.rnnn",
            ],
            dest,
        )
    assert label == "upstream"
    assert dest.read_bytes() == b"ok"
    assert calls[0].startswith("https://cdn.")


def test_download_first_ok_sha_mismatch_retries_upstream(tmp_path: Path) -> None:
    dest = tmp_path / "file.bin"

    def fake_download(url: str, path: Path, **kwargs: object) -> None:
        if "cdn" in url:
            path.write_bytes(b"bad")
        else:
            path.write_bytes(b"good")

    with patch("podcast_mcp.util.asset_sources._download_url", fake_download):
        label = download_first_ok(
            [
                "https://cdn.example.test/file",
                "https://upstream.example/file",
            ],
            dest,
            expected_sha256=hashlib.sha256(b"good").hexdigest(),
        )
    assert label == "upstream"
    assert dest.read_bytes() == b"good"


def test_download_first_ok_all_fail(tmp_path: Path) -> None:
    dest = tmp_path / "file.bin"

    def boom(url: str, path: Path, **kwargs: object) -> None:
        raise OSError(url)

    with (
        patch("podcast_mcp.util.asset_sources._download_url", boom),
        pytest.raises(AssetSourceError),
    ):
        download_first_ok(["https://cdn.example.test/x"], dest)


def test_asset_entry_unknown_raises() -> None:
    with pytest.raises(AssetSourceError, match="unknown bootstrap asset"):
        asset_entry("not-in-manifest")


def test_cdn_url_for_without_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    assert cdn_url_for("rnnoise", "somnolent-hogwash.rnnn") is None


def test_download_first_ok_single_url(tmp_path: Path) -> None:
    dest = tmp_path / "one.bin"

    def fake_download(url: str, path: Path, **kwargs: object) -> None:
        path.write_bytes(b"x")

    with patch("podcast_mcp.util.asset_sources._download_url", fake_download):
        assert download_first_ok(["https://upstream.example/one.bin"], dest) == "upstream"


def test_ffmpeg_platform_slug() -> None:
    with patch("podcast_mcp.util.asset_sources.platform.system", return_value="Darwin"):
        with patch("podcast_mcp.util.asset_sources.platform.machine", return_value="arm64"):
            assert ffmpeg_platform_slug() == "darwin-arm64"
    ff, _fp = ffmpeg_cdn_relative_paths()
    assert ff.endswith("/ffmpeg") or ff.endswith("/ffmpeg.exe")


def test_cdn_base_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    assert bootstrap_cdn_base() is None
    assert cdn_base_configured() is False
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.sharecut.studio/assets")
    assert bootstrap_cdn_base() == "https://cdn.sharecut.studio/assets"
    assert cdn_base_configured() is True


def test_http_and_loopback_cdn_base_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "http://cdn.example.test/assets")
    assert bootstrap_cdn_base() is None
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://127.0.0.1/assets")
    assert bootstrap_cdn_base() is None


def test_cdn_base_env_survives_missing_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> dict[str, object]:
        raise AssetSourceError("missing")

    monkeypatch.setattr("podcast_mcp.util.asset_sources.load_manifest", boom)
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/x")
    assert bootstrap_cdn_base() == "https://cdn.example.test/x"
    assert cdn_base_configured() is True


def test_packaged_bootstrap_assets_matches_contract() -> None:
    root = Path(__file__).resolve().parents[1]
    contract = (root / "contracts" / "bootstrap-assets.json").read_text(encoding="utf-8")
    bundled = (root / "src" / "podcast_mcp" / "util" / "bootstrap-assets.json").read_text(
        encoding="utf-8"
    )
    assert contract == bundled
    assert manifest_path().name == "bootstrap-assets.json"


def test_load_manifest_returns_isolated_copies() -> None:
    first = load_manifest()
    second = load_manifest()
    first["assets"]["rnnoise"]["filename"] = "mutated.rnnn"
    assert second["assets"]["rnnoise"]["filename"] != "mutated.rnnn"


def test_download_preserves_last_good_on_get_failure(tmp_path: Path) -> None:
    dest = tmp_path / "file.bin"
    dest.write_bytes(b"keep")

    def boom(url: str, path: Path, **kwargs: object) -> None:
        raise OSError("cdn down")

    with (
        patch("podcast_mcp.util.asset_sources._download_url", boom),
        pytest.raises(AssetSourceError, match="cdn down"),
    ):
        download_first_ok(["https://cdn.example.test/x"], dest)
    assert dest.read_bytes() == b"keep"


def test_single_cdn_url_labeled_cdn(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test")
    dest = tmp_path / "one.bin"

    def fake_download(url: str, path: Path, **kwargs: object) -> None:
        path.write_bytes(b"x")

    with patch("podcast_mcp.util.asset_sources._download_url", fake_download):
        assert download_first_ok(["https://cdn.example.test/one.bin"], dest) == "cdn"


def test_ffmpeg_cdn_pins_absent_without_manifest_hashes() -> None:
    assert ffmpeg_cdn_pins() is None


def test_whisper_manifest_rows_are_not_wired_to_runtime() -> None:
    import inspect

    from podcast_mcp.whisper_models import bootstrap_whisper_model

    source = inspect.getsource(bootstrap_whisper_model)
    assert "ordered_http_urls" not in source
    assert "cdn_url_for" not in source
    assert asset_entry("whisper-large-v3-turbo")["kind"] == "huggingface"


def test_download_uses_unique_part_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dest = tmp_path / "file.bin"
    part_names: list[str] = []

    class _Hex:
        hex = "abcd1234ef567890"

    monkeypatch.setattr("podcast_mcp.util.asset_sources.uuid.uuid4", lambda: _Hex())

    class _Resp:
        def read(self, _n: int) -> bytes:
            return b""

    class _Ctx:
        def __enter__(self) -> _Resp:
            return _Resp()

        def __exit__(self, *_a: object) -> None:
            return None

    class _Opener:
        def open(self, req: object, timeout: float = 120.0) -> _Ctx:
            del req, timeout
            return _Ctx()

    monkeypatch.setattr("podcast_mcp.util.asset_sources._https_opener", lambda: _Opener())
    real_with_name = Path.with_name

    def tracking_with_name(self: Path, name: str) -> Path:
        if name.endswith(".part"):
            part_names.append(name)
        return real_with_name(self, name)

    monkeypatch.setattr(Path, "with_name", tracking_with_name)
    from podcast_mcp.util.asset_sources import _download_url

    _download_url("https://cdn.example.test/file.bin", dest)
    assert dest.exists()
    assert part_names == ["file.bin.abcd1234ef567890.part"]


def test_copy_bounded_rejects_oversize() -> None:
    src = io.BytesIO(b"abcdef")
    dest = io.BytesIO()
    with pytest.raises(AssetSourceError, match="exceeds"):
        _copy_bounded(src, dest, max_bytes=4)


def test_redirect_handler_rejects_http_and_blocked_hosts() -> None:
    handler = _HttpsRedirectHandler()
    req = urllib.request.Request("https://cdn.example.test/a")
    with pytest.raises(AssetSourceError, match="non-HTTPS"):
        handler.redirect_request(req, None, 302, "Found", {}, "http://evil.test/x")
    with pytest.raises(AssetSourceError, match="redirect host"):
        handler.redirect_request(req, None, 302, "Found", {}, "https://127.0.0.1/x")
    allowed = handler.redirect_request(req, None, 302, "Found", {}, "https://cdn.example.test/b")
    assert allowed is not None
    assert "cdn.example.test/b" in allowed.full_url


def test_blocked_hosts_and_empty_cdn_base() -> None:
    assert _is_blocked_host("")
    assert _is_blocked_host("localhost")
    assert _is_blocked_host("metadata.google.internal")
    assert _is_blocked_host("svc.internal")
    assert _is_blocked_host("printer.local")
    assert _sanitize_cdn_base(None) is None
    assert _sanitize_cdn_base("   ") is None
    assert _sanitize_cdn_base("https://") is None
    assert _https_opener() is not None


def test_copy_bounded_writes_chunks() -> None:
    src = io.BytesIO(b"ok")
    dest = io.BytesIO()
    _copy_bounded(src, dest, max_bytes=16)
    assert dest.getvalue() == b"ok"


def test_manifest_path_falls_back_to_bundled(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.util import asset_sources as sources

    real_is_file = Path.is_file

    def fake_is_file(self: Path) -> bool:
        if self.name == "bootstrap-assets.json" and "contracts" in self.parts:
            return False
        return real_is_file(self)

    monkeypatch.setattr(Path, "is_file", fake_is_file)
    sources._read_manifest.cache_clear()
    path = sources.manifest_path()
    assert path.parent.name == "util"
    sources._read_manifest.cache_clear()


def test_invalid_manifest_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.util import asset_sources as sources

    bad = tmp_path / "bootstrap-assets.json"
    bad.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(sources, "manifest_path", lambda: bad)
    sources._read_manifest.cache_clear()
    with pytest.raises(AssetSourceError, match="invalid manifest"):
        sources.load_manifest()
    sources._read_manifest.cache_clear()


def test_cdn_base_default_from_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.load_manifest",
        lambda: {
            "cdn_base_env": "PODCAST_BOOTSTRAP_CDN_BASE",
            "cdn_base_default": "https://cdn.example.test/default",
        },
    )
    assert bootstrap_cdn_base() == "https://cdn.example.test/default"


def test_cdn_base_configured_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> str | None:
        raise AssetSourceError("nope")

    monkeypatch.setattr("podcast_mcp.util.asset_sources.bootstrap_cdn_base", boom)
    assert cdn_base_configured() is False


def test_download_url_rejects_http_and_blocked_hosts(tmp_path: Path) -> None:
    dest = tmp_path / "x.bin"
    with pytest.raises(ValueError, match="non-HTTPS"):
        _download_url("http://cdn.example.test/x", dest)
    with pytest.raises(ValueError, match="host"):
        _download_url("https://127.0.0.1/x", dest)


def test_download_url_sha_mismatch_leaves_dest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = tmp_path / "file.bin"
    dest.write_bytes(b"keep")

    class _Resp:
        def __init__(self) -> None:
            self._sent = False

        def read(self, _n: int) -> bytes:
            if self._sent:
                return b""
            self._sent = True
            return b"bad"

    class _Ctx:
        def __enter__(self) -> _Resp:
            return _Resp()

        def __exit__(self, *_a: object) -> None:
            return None

    class _Opener:
        def open(self, req: object, timeout: float = 120.0) -> _Ctx:
            del req, timeout
            return _Ctx()

    monkeypatch.setattr("podcast_mcp.util.asset_sources._https_opener", lambda: _Opener())
    with pytest.raises(AssetSourceError, match="sha256 mismatch"):
        _download_url(
            "https://cdn.example.test/file.bin",
            dest,
            expected_sha256=hashlib.sha256(b"good").hexdigest(),
        )
    assert dest.read_bytes() == b"keep"


def test_ffmpeg_platform_slugs() -> None:
    with (
        patch("podcast_mcp.util.asset_sources.platform.system", return_value="Darwin"),
        patch("podcast_mcp.util.asset_sources.platform.machine", return_value="x86_64"),
    ):
        assert ffmpeg_platform_slug() == "darwin-x64"
    with (
        patch("podcast_mcp.util.asset_sources.platform.system", return_value="Windows"),
        patch("podcast_mcp.util.asset_sources.platform.machine", return_value="AMD64"),
    ):
        assert ffmpeg_platform_slug() == "windows-x64"
    with (
        patch("podcast_mcp.util.asset_sources.platform.system", return_value="Linux"),
        patch("podcast_mcp.util.asset_sources.platform.machine", return_value="x86_64"),
    ):
        assert ffmpeg_platform_slug() == "linux-x64"
    with (
        patch("podcast_mcp.util.asset_sources.platform.system", return_value="Linux"),
        patch("podcast_mcp.util.asset_sources.platform.machine", return_value="aarch64"),
    ):
        assert ffmpeg_platform_slug() == "linux-aarch64"


def test_ffmpeg_cdn_pins_from_platform_map(monkeypatch: pytest.MonkeyPatch) -> None:
    slug = ffmpeg_platform_slug()
    suffix = ".exe" if slug.startswith("windows") else ""
    monkeypatch.setattr(
        "podcast_mcp.util.asset_sources.asset_entry",
        lambda _asset_id: {
            "sha256_by_platform": {
                f"{slug}/ffmpeg{suffix}": "AA",
                f"{slug}/ffprobe{suffix}": "BB",
            }
        },
    )
    assert ffmpeg_cdn_pins() == ("aa", "bb")
