from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.word_aligner_models import (
    DEFAULT_WORD_ALIGNER,
    WordAlignerMissingError,
    bootstrap_word_aligner,
    resolve_word_aligner_dir,
    word_aligner_is_cached,
    word_aligner_model,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")


def test_catalog_pin_matches_benchmarked_candidate() -> None:
    candidates = json.loads((FIXTURES / "word_boundary" / "candidates.json").read_text())[
        "candidates"
    ]
    candidate = next(c for c in candidates if c["label"] == DEFAULT_WORD_ALIGNER)
    model = word_aligner_model(DEFAULT_WORD_ALIGNER)

    assert model.hf_repo == candidate["hf_repo"]
    assert model.revision == candidate["revision"]
    assert model.onnx_file == candidate["onnx_file"]
    assert model.license == candidate["license"]
    assert set(model.allow_patterns) == set(candidate["allow_patterns"])


def test_unknown_model_raises() -> None:
    with pytest.raises(ValueError, match="Unknown word aligner"):
        word_aligner_model("nope")


def test_env_override_dir_is_used_when_complete(tmp_path, monkeypatch) -> None:
    model_dir = tmp_path / "snapshot"
    (model_dir / "onnx").mkdir(parents=True)
    (model_dir / "vocab.json").write_text("{}")
    (model_dir / "onnx" / "model.onnx").write_bytes(b"")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))

    assert resolve_word_aligner_dir() == model_dir


def test_env_override_missing_files_names_the_env_var(tmp_path, monkeypatch) -> None:
    model_dir = tmp_path / "snapshot"
    model_dir.mkdir()
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))

    with pytest.raises(WordAlignerMissingError, match="PODCAST_MCP_WORD_ALIGNER_MODEL"):
        resolve_word_aligner_dir()


def test_uncached_model_raises_missing_with_bootstrap_hint() -> None:
    assert word_aligner_is_cached() is False
    with pytest.raises(WordAlignerMissingError) as excinfo:
        resolve_word_aligner_dir()
    assert "podcast bootstrap --component word-aligner" in str(excinfo.value)


def test_partial_snapshot_is_not_ready(tmp_path, monkeypatch) -> None:
    partial = tmp_path / "partial"
    partial.mkdir()
    (partial / "vocab.json").write_text("{}")

    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(partial), raising=False
    )

    with pytest.raises(WordAlignerMissingError, match="partial download"):
        resolve_word_aligner_dir()


def test_bootstrap_downloads_pinned_snapshot_into_cache(tmp_path, monkeypatch) -> None:
    calls: dict[str, object] = {}

    def fake_snapshot_download(repo, **kwargs):
        calls["repo"] = repo
        calls.update(kwargs)
        return str(tmp_path / "downloaded")

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)

    result = bootstrap_word_aligner()

    model = word_aligner_model(DEFAULT_WORD_ALIGNER)
    assert calls["revision"] == model.revision
    assert calls["allow_patterns"] == model.allow_patterns
    assert str(calls["cache_dir"]).endswith("word-aligner")
    assert "local_files_only" not in calls
    assert calls["force_download"] is False
    assert result == {"ok": True, "model": model.id, "path": str(tmp_path / "downloaded")}
