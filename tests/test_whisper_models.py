from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    WhisperWeightsMissingError,
    bootstrap_whisper_model,
    cache_path_matches_model,
    ensure_whisper_model_cached,
    persist_whisper_model,
    resolve_whisper_model,
    validate_whisper_model,
)


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)


def test_validate_accepts_turbo_alias() -> None:
    assert validate_whisper_model("turbo") == "large-v3-turbo"
    assert validate_whisper_model("LARGE-V3-TURBO") == "large-v3-turbo"


def test_validate_rejects_unknown() -> None:
    with pytest.raises(ValueError, match="Unknown Whisper model"):
        validate_whisper_model("not-a-model")


def test_resolve_pref_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_whisper_model() == DEFAULT_WHISPER_MODEL
    persist_whisper_model("small.en")
    assert resolve_whisper_model() == "small.en"
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "medium.en")
    assert resolve_whisper_model() == "medium.en"
    assert resolve_whisper_model(requested="tiny.en") == "tiny.en"


def test_resolve_invalid_env_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "not-a-model")
    assert resolve_whisper_model() == DEFAULT_WHISPER_MODEL
    persist_whisper_model("small.en")
    assert resolve_whisper_model() == "small.en"


def test_persist_merges_existing_prefs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    from podcast_mcp.whisper_models import prefs_path

    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump({"other": 1}), encoding="utf-8")
    persist_whisper_model("base.en")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert data["whisper_model"] == "base.en"
    assert data["other"] == 1


def test_read_pref_tolerates_corrupt_and_invalid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    from podcast_mcp.whisper_models import prefs_path, read_whisper_model_pref

    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not yaml", encoding="utf-8")
    assert read_whisper_model_pref() is None
    path.write_text("- just a list\n", encoding="utf-8")
    assert read_whisper_model_pref() is None
    path.write_text(yaml.safe_dump({"whisper_model": ""}), encoding="utf-8")
    assert read_whisper_model_pref() is None
    path.write_text(yaml.safe_dump({"whisper_model": "nope"}), encoding="utf-8")
    assert read_whisper_model_pref() is None


def test_normalize_rejects_empty() -> None:
    with pytest.raises(ValueError, match="empty"):
        validate_whisper_model("   ")


def test_persist_ignores_non_dict_existing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    from podcast_mcp.whisper_models import persist_whisper_model, prefs_path

    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("- not a mapping\n", encoding="utf-8")
    persist_whisper_model("tiny.en")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert data["whisper_model"] == "tiny.en"


def test_persist_overwrites_corrupt_yaml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    from podcast_mcp.whisper_models import persist_whisper_model, prefs_path

    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not yaml", encoding="utf-8")
    persist_whisper_model("base.en")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert data["whisper_model"] == "base.en"


def test_apply_overlay_skips_non_dict_transcribe() -> None:
    from podcast_mcp.whisper_models import apply_whisper_model_to_defaults

    data = {"transcribe": "off"}
    apply_whisper_model_to_defaults(data)
    assert data["transcribe"] == "off"


def test_apply_overlay_fills_default_when_model_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.whisper_models import (
        DEFAULT_WHISPER_MODEL,
        apply_whisper_model_to_defaults,
    )

    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.whisper_models.read_whisper_model_pref",
        lambda: None,
    )
    data: dict = {"transcribe": {}}
    apply_whisper_model_to_defaults(data)
    assert data["transcribe"]["model"] == DEFAULT_WHISPER_MODEL


def test_whisper_model_is_cached_missing_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "no-such-whisper-dir",
    )
    from podcast_mcp.whisper_models import catalog_payload, whisper_model_is_cached

    assert whisper_model_is_cached("large-v3-turbo") is False
    rows = catalog_payload()
    assert rows[0]["id"] == "tiny.en"
    assert all("cached" in row and isinstance(row["cached"], bool) for row in rows)
    assert rows[0]["cached"] is False
    turbo = "models--Systran--faster-whisper-large-v3-turbo/blobs/x"
    large = "models--Systran--faster-whisper-large-v3/blobs/x"
    small_en = "models--Systran--faster-whisper-small.en/blobs/x"
    small = "models--Systran--faster-whisper-small/blobs/x"
    assert cache_path_matches_model(turbo, "large-v3-turbo")
    assert not cache_path_matches_model(turbo, "large-v3")
    assert cache_path_matches_model(large, "large-v3")
    assert not cache_path_matches_model(small_en, "small")
    assert cache_path_matches_model(small_en, "small.en")
    assert cache_path_matches_model(small, "small")


def test_whisper_model_is_cached_requires_weight_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.whisper_models import whisper_model_is_cached

    cache = tmp_path / "whisper"
    blobs = cache / "models--Systran--faster-whisper-base" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "partial.chunk").write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert whisper_model_is_cached("base") is False

    (blobs / "model.safetensors").write_bytes(b"x")
    assert whisper_model_is_cached("base") is True


def test_bootstrap_whisper_model_downloads_and_persists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from unittest.mock import MagicMock, patch

    from podcast_mcp.config import whisper_cache_dir

    calls: list[dict] = []

    def fake_model(name, **kwargs):
        calls.append({"name": name, **kwargs})
        return MagicMock()

    with patch("faster_whisper.WhisperModel", side_effect=fake_model):
        out = bootstrap_whisper_model("small.en")
    assert out["ok"] is True
    assert out["model"] == "small.en"
    assert out["persist_error"] is None
    assert calls == [
        {
            "name": "small.en",
            "device": "cpu",
            "compute_type": "int8",
            "download_root": str(whisper_cache_dir()),
        }
    ]
    assert resolve_whisper_model() == "small.en"


def test_bootstrap_whisper_model_persist_error_still_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import MagicMock, patch

    with (
        patch("faster_whisper.WhisperModel", return_value=MagicMock()),
        patch(
            "podcast_mcp.whisper_models.persist_whisper_model",
            side_effect=OSError("disk full"),
        ),
    ):
        out = bootstrap_whisper_model("base.en")
    assert out["ok"] is True
    assert out["model"] == "base.en"
    assert out["persist_error"] == "disk full"


def test_ensure_whisper_model_cached_raises_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty-whisper",
    )
    with pytest.raises(WhisperWeightsMissingError, match=r"small\.en") as exc_info:
        ensure_whisper_model_cached("small.en")
    assert "podcast transcribe --model <model>" in str(exc_info.value)


def test_ensure_whisper_model_cached_ok_with_weight_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    blob = cache / "models--Systran--faster-whisper-small.en" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert ensure_whisper_model_cached("small.en") == "small.en"
