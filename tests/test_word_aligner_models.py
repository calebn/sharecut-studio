from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

import podcast_mcp.word_aligner_models as word_aligner_models
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
    word_aligner_models._onnx_pin_mismatch_cached.cache_clear()
    yield
    word_aligner_models._onnx_pin_mismatch_cached.cache_clear()


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
    monkeypatch.setattr(
        "podcast_mcp.word_aligner_models.sha256_file",
        lambda p: word_aligner_model().onnx_sha256,
    )

    result = bootstrap_word_aligner()

    model = word_aligner_model(DEFAULT_WORD_ALIGNER)
    assert calls["revision"] == model.revision
    assert calls["allow_patterns"] == model.allow_patterns
    assert str(calls["cache_dir"]).endswith("word-aligner")
    assert "local_files_only" not in calls
    assert calls["force_download"] is False
    assert result == {"ok": True, "model": model.id, "path": str(tmp_path / "downloaded")}


def test_bootstrap_rejects_a_snapshot_that_does_not_match_the_pin(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda repo, **kw: str(tmp_path), raising=False
    )
    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", lambda p: "0" * 64)
    with pytest.raises(WordAlignerMissingError, match="sha256"):
        bootstrap_word_aligner()


def test_verify_word_aligner_onnx_hashes_the_onnx_file(tmp_path, monkeypatch) -> None:
    from podcast_mcp.word_aligner_models import verify_word_aligner_onnx

    model = word_aligner_model()
    seen = []
    monkeypatch.setattr(
        "podcast_mcp.word_aligner_models.sha256_file",
        lambda p: seen.append(p) or model.onnx_sha256,
    )
    verify_word_aligner_onnx(tmp_path, model)
    assert seen == [tmp_path / model.onnx_file]


def _complete_snapshot(root: Path) -> Path:
    (root / "onnx").mkdir(parents=True)
    (root / "vocab.json").write_text("{}")
    (root / "onnx" / "model.onnx").write_bytes(b"x")
    return root


def test_is_cached_rejects_a_pinned_snapshot_with_a_bad_hash(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", lambda p: "0" * 64)
    assert word_aligner_is_cached() is False
    # same file key: clear the remembered mismatch to re-check with the good hash
    word_aligner_models._onnx_pin_mismatch_cached.cache_clear()
    monkeypatch.setattr(
        "podcast_mcp.word_aligner_models.sha256_file",
        lambda p: word_aligner_model().onnx_sha256,
    )
    assert word_aligner_is_cached() is True


def test_is_cached_does_not_hash_an_override_dir(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "override")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(snap))

    def no_hash(p):
        raise AssertionError("override dirs are not verified")

    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", no_hash)
    assert word_aligner_is_cached() is True


def test_is_cached_hashes_an_unchanged_snapshot_once(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        return word_aligner_model().onnx_sha256

    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", fake_sha256)

    assert word_aligner_is_cached() is True
    assert word_aligner_is_cached() is True
    assert len(calls) == 1

    (snap / "onnx" / "model.onnx").write_bytes(b"xy")
    assert word_aligner_is_cached() is True
    assert len(calls) == 2


def test_is_cached_is_false_when_the_onnx_file_vanishes(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )

    def raise_oserror(model_dir: Path, model) -> None:
        raise OSError("vanished")

    monkeypatch.setattr(
        "podcast_mcp.word_aligner_models._verify_word_aligner_onnx_once", raise_oserror
    )
    assert word_aligner_is_cached() is False


def test_is_cached_hashes_once_under_concurrent_status_checks(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        time.sleep(0.05)
        return word_aligner_model().onnx_sha256

    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", fake_sha256)

    results: list[bool] = []
    threads = [
        threading.Thread(target=lambda: results.append(word_aligner_is_cached())) for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [True, True]
    assert len(calls) == 1


def test_is_cached_remembers_a_pin_mismatch_until_the_file_changes(tmp_path, monkeypatch) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        if len(calls) == 1:
            return "0" * 64
        return word_aligner_model().onnx_sha256

    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", fake_sha256)

    assert word_aligner_is_cached() is False
    assert word_aligner_is_cached() is False
    assert len(calls) == 1

    (snap / "onnx" / "model.onnx").write_bytes(b"xy")
    assert word_aligner_is_cached() is True
    assert len(calls) == 2


def test_is_cached_hashes_a_mismatch_once_under_concurrent_status_checks(
    tmp_path, monkeypatch
) -> None:
    snap = _complete_snapshot(tmp_path / "snap")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        time.sleep(0.05)
        return "0" * 64

    monkeypatch.setattr("podcast_mcp.word_aligner_models.sha256_file", fake_sha256)

    results: list[bool] = []
    threads = [
        threading.Thread(target=lambda: results.append(word_aligner_is_cached())) for _ in range(3)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [False, False, False]
    assert len(calls) == 1


def test_model_supports_only_catalog_languages() -> None:
    model = word_aligner_model()

    assert model.supports_language("en")
    assert model.supports_language(None)
    assert not model.supports_language("de")
