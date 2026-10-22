"""Bootstrap asset URL ordering and CDN fallback (no network)."""

from __future__ import annotations

import hashlib
import io
import json
import re
import urllib.request
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.util.asset_sources import (
    AssetIntegrityError,
    AssetSourceError,
    DownloadProgress,
    NoDownloadSourceError,
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
    load_manifest,
    ordered_http_urls,
)


class _Resp:
    def __init__(self, body: bytes, *, length: bool = True) -> None:
        self._body = io.BytesIO(body)
        self.headers = {"Content-Length": str(len(body))} if length else {}

    def read(self, n: int) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *_a: object) -> None:
        return None


class _Opener:
    """Serves ``routes``: bytes become a 200 body, an exception is raised on open."""

    def __init__(self, routes: dict[str, bytes | Exception], *, length: bool = True) -> None:
        self.routes = routes
        self.length = length
        self.calls: list[str] = []

    def open(self, req: urllib.request.Request, timeout: float = 120.0) -> _Resp:
        del timeout
        self.calls.append(req.full_url)
        route = self.routes[req.full_url]
        if isinstance(route, Exception):
            raise route
        return _Resp(route, length=self.length)


def _serve(monkeypatch: pytest.MonkeyPatch, opener: _Opener) -> _Opener:
    monkeypatch.setattr("podcast_mcp.util.asset_sources._https_opener", lambda: opener)
    return opener


def test_ordered_http_urls_prefers_cdn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/bootstrap")
    urls = ordered_http_urls("rnnoise", relative_path="somnolent-hogwash.rnnn")
    assert urls[0] == ("https://cdn.example.test/bootstrap/models/rnnoise/somnolent-hogwash.rnnn")
    assert urls[1].startswith("https://raw.githubusercontent.com/")


# The production distribution profile (private overlay) sets this base. The test
# sets it itself and cannot see the overlay, so keep the two in step by hand.
PRODUCTION_CDN_BASE = "https://cdn.sharecut.studio/assets"


def test_speaker_model_url_under_the_production_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", PRODUCTION_CDN_BASE)
    speaker = asset_entry("speaker-ecapa")["filename"]
    rnnoise = asset_entry("rnnoise")["filename"]
    assert ordered_http_urls("speaker-ecapa", relative_path=speaker) == [
        "https://cdn.sharecut.studio/assets/models/speaker-ecapa/ecapa-voxceleb-embedding.onnx",
        "https://cdn.sharecut.studio/models/speaker-ecapa/ecapa-voxceleb-embedding.onnx",
    ]
    assert ordered_http_urls("rnnoise", relative_path=rnnoise)[0] == (
        "https://cdn.sharecut.studio/assets/models/rnnoise/somnolent-hogwash.rnnn"
    )


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


def test_download_first_ok_sha_mismatch_retries_upstream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = tmp_path / "file.bin"
    opener = _Opener(
        {"https://cdn.example.test/file": b"bad", "https://upstream.example/file": b"good"}
    )
    _serve(monkeypatch, opener)
    label = download_first_ok(
        ["https://cdn.example.test/file", "https://upstream.example/file"],
        dest,
        expected_sha256=hashlib.sha256(b"good").hexdigest(),
    )
    assert label == "upstream"
    assert dest.read_bytes() == b"good"
    assert list(tmp_path.glob("*.part")) == []


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


def test_manifest_is_the_contract() -> None:
    contract = Path(__file__).resolve().parents[1] / "contracts" / "bootstrap-assets.json"
    assert load_manifest() == json.loads(contract.read_text(encoding="utf-8"))


def test_every_http_asset_names_an_https_url_and_speaker_is_pinned() -> None:
    assets = load_manifest()["assets"]
    http_assets = {name: meta for name, meta in assets.items() if meta["kind"] == "http"}
    assert {"rnnoise", "speaker-ecapa"} <= set(http_assets)
    for name, meta in http_assets.items():
        assert str(meta.get("url", "")).startswith("https://"), name
    speaker = http_assets["speaker-ecapa"]
    assert re.fullmatch(r"[0-9a-f]{64}", speaker["sha256"])
    assert speaker["url"] == (
        "https://cdn.sharecut.studio/models/speaker-ecapa/ecapa-voxceleb-embedding.onnx"
    )


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


def test_whisper_manifest_rows_are_not_wired_to_runtime() -> None:
    import inspect

    from podcast_mcp.engines.models.whisper import bootstrap_whisper_model

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

    _serve(monkeypatch, _Opener({"https://cdn.example.test/file.bin": b""}))
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


def test_invalid_manifest_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.util import asset_sources as sources

    (tmp_path / "bootstrap-assets.json").write_text("[]", encoding="utf-8")
    monkeypatch.setattr("podcast_mcp.util.contracts.contracts_dir", lambda: tmp_path)
    sources._read_manifest.cache_clear()
    with pytest.raises(AssetSourceError, match="invalid manifest"):
        sources.load_manifest()
    sources._read_manifest.cache_clear()


def test_missing_manifest_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.util import asset_sources as sources

    monkeypatch.setattr("podcast_mcp.util.contracts.contracts_dir", lambda: tmp_path)
    sources._read_manifest.cache_clear()
    with pytest.raises(AssetSourceError, match="not found"):
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

    _serve(monkeypatch, _Opener({"https://cdn.example.test/file.bin": b"bad"}))
    with pytest.raises(AssetSourceError, match="sha256 mismatch"):
        _download_url(
            "https://cdn.example.test/file.bin",
            dest,
            expected_sha256=hashlib.sha256(b"good").hexdigest(),
        )
    assert dest.read_bytes() == b"keep"


def test_rnnoise_manifest_pin_contract() -> None:
    from podcast_mcp.util import model_assets

    meta = asset_entry("rnnoise")
    assert re.search(r"/[0-9a-f]{40}/", meta["url"])
    assert "/master/" not in meta["url"]
    assert re.fullmatch(r"[0-9a-f]{64}", meta["sha256"])
    assert meta["size_bytes"] == 297646
    assert isinstance(meta["size_bytes"], int) and not isinstance(meta["size_bytes"], bool)
    assert not hasattr(model_assets, "RNNOISE_MODEL_URL")


def test_manifest_schema_declares_size_bytes() -> None:
    schema_path = Path(__file__).resolve().parents[1] / "contracts" / "bootstrap-assets.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    def find_props(node: object) -> list[dict]:
        found: list[dict] = []
        if isinstance(node, dict):
            props = node.get("properties")
            if isinstance(props, dict) and "sha256" in props:
                found.append(props)
            for value in node.values():
                found.extend(find_props(value))
        elif isinstance(node, list):
            for value in node:
                found.extend(find_props(value))
        return found

    all_props = find_props(schema)
    assert all_props
    assert all(props.get("size_bytes", {}).get("type") == "integer" for props in all_props)


MIB = 1024 * 1024


def test_download_reports_bytes_against_content_length(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = b"x" * (2 * MIB + 5)
    _serve(monkeypatch, _Opener({"https://up.example/m.bin": body}))
    events: list[DownloadProgress] = []
    download_first_ok(["https://up.example/m.bin"], tmp_path / "m.bin", on_progress=events.append)
    size = len(body)
    assert events == [
        DownloadProgress(0, size),
        DownloadProgress(MIB, size),
        DownloadProgress(2 * MIB, size),
        DownloadProgress(size, size),
    ]
    assert (tmp_path / "m.bin").read_bytes() == body


def test_download_without_content_length_has_no_total(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m.bin": b"abc"}, length=False))
    events: list[DownloadProgress] = []
    download_first_ok(["https://up.example/m.bin"], tmp_path / "m.bin", on_progress=events.append)
    assert events == [DownloadProgress(0, None), DownloadProgress(3, None)]


def test_a_failed_first_source_restarts_progress_at_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    good = b"g" * 10
    _serve(
        monkeypatch,
        _Opener({"https://cdn.example.test/m": b"b" * 4, "https://up.example/m": good}),
    )
    events: list[DownloadProgress] = []
    label = download_first_ok(
        ["https://cdn.example.test/m", "https://up.example/m"],
        tmp_path / "m.bin",
        expected_sha256=hashlib.sha256(good).hexdigest(),
        on_progress=events.append,
    )
    assert label == "upstream"
    assert events == [
        DownloadProgress(0, 4),
        DownloadProgress(4, 4),
        DownloadProgress(0, 10),
        DownloadProgress(10, 10),
    ]


def test_sha_mismatch_on_every_source_leaves_no_dest_and_no_part(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(monkeypatch, _Opener({"https://up.example/m": b"bad"}))
    dest = tmp_path / "m.bin"
    with pytest.raises(AssetSourceError) as raised:
        download_first_ok(
            ["https://up.example/m"], dest, expected_sha256=hashlib.sha256(b"good").hexdigest()
        )
    assert [type(a) for a in raised.value.attempts] == [AssetIntegrityError]
    assert list(tmp_path.iterdir()) == []


def test_no_urls_is_a_typed_error_without_opening_anything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opener = _Opener({})
    _serve(monkeypatch, opener)
    with pytest.raises(NoDownloadSourceError):
        download_first_ok([], tmp_path / "m.bin")
    assert opener.calls == []


def test_download_progress_percent_is_derived() -> None:
    assert DownloadProgress(50, 200).percent == 25.0
    assert DownloadProgress(5, None).percent is None
    assert DownloadProgress(0, 0).percent == 100.0
