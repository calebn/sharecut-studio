from __future__ import annotations

import copy
import hashlib
import io
import logging
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.util import asset_sources, model_assets
from podcast_mcp.util.asset_sources import AssetSourceError, asset_entry


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)


def _pinned_size() -> int:
    size = asset_entry("rnnoise")["size_bytes"]
    assert isinstance(size, int)
    return size


class _FakeOpener:
    """Stands in for asset_sources._https_opener(): maps URL -> bytes or an exception."""

    def __init__(self, routes: dict[str, bytes | Exception]) -> None:
        self.routes = routes
        self.requested: list[str] = []

    def open(self, req, timeout: float | None = None):
        del timeout
        url = req.full_url
        self.requested.append(url)
        result = self.routes[url]
        if isinstance(result, Exception):
            raise result
        return io.BytesIO(result)


def _install_opener(monkeypatch: pytest.MonkeyPatch, routes: dict[str, bytes | Exception]):
    opener = _FakeOpener(routes)
    monkeypatch.setattr(asset_sources, "_https_opener", lambda: opener)
    return opener


def test_rnnoise_model_path_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", "/custom/model.rnnn")
    assert model_assets.rnnoise_model_path() == Path("/custom/model.rnnn")


def test_rnnoise_model_path_default_location() -> None:
    path = model_assets.rnnoise_model_path()
    assert path.parent == model_assets.models_dir()
    assert path.name == model_assets.RNNOISE_MODEL_NAME


def test_resolve_rnnoise_model_raises_with_bootstrap_hint() -> None:
    with pytest.raises(FileNotFoundError, match="podcast bootstrap --component rnnoise"):
        model_assets.resolve_rnnoise_model()


def test_resolve_rnnoise_model_returns_existing_file() -> None:
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"model bytes")
    assert model_assets.resolve_rnnoise_model() == path


def test_bootstrap_rnnoise_model_downloads_when_missing() -> None:
    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"d" * _pinned_size())
        return "upstream"

    with patch.object(model_assets, "download_first_ok", side_effect=fake_download) as mock_dl:
        path = model_assets.bootstrap_rnnoise_model()

    mock_dl.assert_called_once()
    assert path.read_bytes() == b"d" * _pinned_size()


def test_bootstrap_rnnoise_skips_cdn_without_sha(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/bootstrap")
    captured: dict[str, list[str]] = {}
    unpinned = {
        k: v for k, v in asset_entry("rnnoise").items() if k not in {"sha256", "size_bytes"}
    }

    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        captured["urls"] = list(urls)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"upstream-only")
        return "upstream"

    with (
        patch.object(model_assets, "asset_entry", return_value=unpinned),
        patch.object(model_assets, "download_first_ok", side_effect=fake_download),
        caplog.at_level(logging.WARNING),
    ):
        path = model_assets.bootstrap_rnnoise_model()

    assert "no sha256 pin" in caplog.text

    assert path.read_bytes() == b"upstream-only"
    assert captured["urls"]
    assert all("cdn.example.test" not in url for url in captured["urls"])


def test_bootstrap_rnnoise_model_skips_when_already_present() -> None:
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"already here")

    with patch.object(model_assets, "download_first_ok") as mock_dl:
        result = model_assets.bootstrap_rnnoise_model()

    mock_dl.assert_not_called()
    assert result == path
    assert result.read_bytes() == b"already here"


def test_bootstrap_rnnoise_model_force_redownloads() -> None:
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"stale")

    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        dest.write_bytes(b"f" * _pinned_size())
        return "upstream"

    with patch.object(model_assets, "download_first_ok", side_effect=fake_download):
        result = model_assets.bootstrap_rnnoise_model(force=True)

    assert result.read_bytes() == b"f" * _pinned_size()


CDN_BASE = "https://cdn.example.test/bootstrap"
CDN_URL = f"{CDN_BASE}/models/rnnoise/somnolent-hogwash.rnnn"


def _good_payload_entry(payload: bytes, **overrides: object) -> dict[str, object]:
    entry = copy.deepcopy(asset_entry("rnnoise"))
    entry["sha256"] = hashlib.sha256(payload).hexdigest()
    entry["size_bytes"] = len(payload)
    entry.update(overrides)
    return entry


def test_bootstrap_rnnoise_altered_bytes_raise_sha_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    github = asset_entry("rnnoise")["url"]
    _install_opener(monkeypatch, {github: b"ALTERED-NOT-THE-REAL-MODEL" * 10})

    with pytest.raises(AssetSourceError, match="sha256 mismatch"):
        model_assets.bootstrap_rnnoise_model()

    assert not model_assets.rnnoise_model_path().exists()


def test_bootstrap_rnnoise_pinned_keeps_cdn_first(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", CDN_BASE)
    captured: dict[str, object] = {}

    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        captured["urls"] = list(urls)
        captured["expected_sha256"] = kwargs.get("expected_sha256")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"\0" * _pinned_size())
        return "cdn"

    with (
        patch.object(model_assets, "download_first_ok", side_effect=fake_download),
        caplog.at_level(logging.WARNING),
    ):
        model_assets.bootstrap_rnnoise_model()

    assert captured["urls"][0] == CDN_URL  # type: ignore[index]
    assert captured["expected_sha256"] == asset_entry("rnnoise")["sha256"]
    assert "no sha256 pin" not in caplog.text


def test_bootstrap_rnnoise_cdn_403_falls_back_to_pinned_github(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", CDN_BASE)
    github = asset_entry("rnnoise")["url"]
    payload = b"the genuine model bytes"
    forbidden = urllib.error.HTTPError(CDN_URL, 403, "Forbidden", {}, None)  # type: ignore[arg-type]
    opener = _install_opener(monkeypatch, {CDN_URL: forbidden, github: payload})

    with patch.object(model_assets, "asset_entry", return_value=_good_payload_entry(payload)):
        path = model_assets.bootstrap_rnnoise_model()

    assert opener.requested == [CDN_URL, github]
    assert path.read_bytes() == payload


def test_bootstrap_rnnoise_size_mismatch_removes_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    payload = b"bytes with a correct sha but a typo'd size"
    entry = _good_payload_entry(payload, size_bytes=len(payload) + 1)
    _install_opener(monkeypatch, {str(entry["url"]): payload})

    with (
        patch.object(model_assets, "asset_entry", return_value=entry),
        pytest.raises(AssetSourceError, match="size mismatch"),
    ):
        model_assets.bootstrap_rnnoise_model()

    assert not model_assets.rnnoise_model_path().exists()


def test_bootstrap_rnnoise_no_sources_raises() -> None:
    with (
        patch.object(model_assets, "ordered_http_urls", return_value=[]),
        patch.object(model_assets, "download_first_ok") as mock_dl,
        pytest.raises(AssetSourceError, match="no download source"),
    ):
        model_assets.bootstrap_rnnoise_model()

    mock_dl.assert_not_called()
