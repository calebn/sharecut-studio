from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.util import model_assets


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_RNNOISE_MODEL", raising=False)


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
        dest.write_bytes(b"downloaded")
        return "upstream"

    with patch.object(model_assets, "download_first_ok", side_effect=fake_download) as mock_dl:
        path = model_assets.bootstrap_rnnoise_model()

    mock_dl.assert_called_once()
    assert path.read_bytes() == b"downloaded"


def test_bootstrap_rnnoise_skips_cdn_without_sha(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/bootstrap")
    captured: dict[str, list[str]] = {}

    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        captured["urls"] = list(urls)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"upstream-only")
        return "upstream"

    with patch.object(model_assets, "download_first_ok", side_effect=fake_download):
        path = model_assets.bootstrap_rnnoise_model()

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


def test_download_writes_response_body_to_dest(tmp_path: Path) -> None:
    dest = tmp_path / "downloaded.rnnn"
    fake_response = io.BytesIO(b"model contents")
    mock_urlopen = MagicMock()
    mock_urlopen.return_value.__enter__.return_value = fake_response

    with patch.object(model_assets.urllib.request, "urlopen", mock_urlopen):
        model_assets._download("https://example.invalid/model.rnnn", dest)

    assert dest.read_bytes() == b"model contents"
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_cleans_up_partial_file_on_failure(tmp_path: Path) -> None:
    dest = tmp_path / "downloaded.rnnn"
    with (
        patch.object(model_assets.urllib.request, "urlopen", side_effect=OSError("network down")),
        pytest.raises(OSError, match="network down"),
    ):
        model_assets._download("https://example.invalid/model.rnnn", dest)

    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_bootstrap_rnnoise_model_force_redownloads() -> None:
    path = model_assets.rnnoise_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"stale")

    def fake_download(urls, dest: Path, **kwargs: object) -> str:
        dest.write_bytes(b"fresh")
        return "upstream"

    with patch.object(model_assets, "download_first_ok", side_effect=fake_download):
        result = model_assets.bootstrap_rnnoise_model(force=True)

    assert result.read_bytes() == b"fresh"
