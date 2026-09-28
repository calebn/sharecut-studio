from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from model_pin_helpers import pin_word_aligner_to_fake_snapshot, write_fake_files
from podcast_mcp.util import model_manifest
from podcast_mcp.word_aligner_models import (
    DEFAULT_WORD_ALIGNER,
    WORD_ALIGNER_CATALOG,
    WordAlignerMissingError,
    WordAlignerPinMismatchError,
    bootstrap_word_aligner,
    resolve_word_aligner_dir,
    verify_word_aligner_snapshot,
    word_aligner_is_cached,
    word_aligner_model,
    word_aligner_problem,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_MCP_WORD_ALIGNER_MODEL", raising=False)
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    model_manifest.clear_manifest_memo()
    yield
    model_manifest.clear_manifest_memo()


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
    assert dict(model.file_sha256) == candidate["file_sha256"]


def test_catalog_manifest_covers_the_snapshot() -> None:
    for model in WORD_ALIGNER_CATALOG:
        assert "vocab.json" in model.allow_patterns
        assert model.onnx_file in model.allow_patterns
        names = [name for name, _ in model.file_sha256]
        assert len(names) == len(set(names))
        for _, digest in model.file_sha256:
            assert len(digest) == 64
            assert digest == digest.lower()
            int(digest, 16)  # hex


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


def test_partial_pinned_snapshot_missing_config_is_not_ready(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    (snap / "preprocessor_config.json").unlink()
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )

    with pytest.raises(WordAlignerMissingError, match="partial download"):
        resolve_word_aligner_dir()


def test_bootstrap_downloads_pinned_snapshot_into_cache(tmp_path, monkeypatch) -> None:
    calls: dict[str, object] = {}
    snap = tmp_path / "downloaded"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)

    def fake_snapshot_download(repo, **kwargs):
        calls["repo"] = repo
        calls.update(kwargs)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)

    result = bootstrap_word_aligner()

    model = word_aligner_model(DEFAULT_WORD_ALIGNER)
    assert calls["revision"] == model.revision
    assert calls["allow_patterns"] == model.allow_patterns
    assert str(calls["cache_dir"]).endswith("word-aligner")
    assert "local_files_only" not in calls
    assert calls["force_download"] is False
    assert result == {"ok": True, "model": model.id, "path": str(snap)}


def test_bootstrap_rejects_a_snapshot_that_does_not_match_the_pin(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "downloaded"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    (snap / "vocab.json").write_bytes(b"tampered")
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda repo, **kw: str(snap), raising=False
    )
    with pytest.raises(WordAlignerPinMismatchError, match=r"vocab\.json"):
        bootstrap_word_aligner()


def test_verify_word_aligner_snapshot_hashes_every_file(tmp_path, monkeypatch) -> None:
    model = word_aligner_model()
    snap = tmp_path / "snap"
    write_fake_files(snap, model.allow_patterns)
    # Real bytes were written for a different (frozen) pin, so patch sha256_file to record
    # every path it is asked to hash and pretend they all match.
    seen: list[Path] = []
    manifest = dict(model.file_sha256)

    def fake_sha256(p: Path) -> str:
        seen.append(p)
        return manifest[p.relative_to(snap).as_posix()]

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", fake_sha256)
    verify_word_aligner_snapshot(snap, model)
    assert {p.relative_to(snap).as_posix() for p in seen} == set(manifest)


def test_is_cached_rejects_a_pinned_snapshot_with_a_bad_hash(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    # A different-length rewrite changes the memo key, unlike swapping the fake hash.
    (snap / "onnx" / "model.onnx").write_bytes(b"tampered bytes")
    assert word_aligner_is_cached() is False


def test_is_cached_does_not_hash_an_override_dir(tmp_path, monkeypatch) -> None:
    model = word_aligner_model()
    snap = tmp_path / "override"
    write_fake_files(snap, model.allow_patterns)
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(snap))

    def no_hash(p):
        raise AssertionError("override dirs are not verified")

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", no_hash)
    assert word_aligner_is_cached() is True


def test_is_cached_hashes_an_unchanged_snapshot_once(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    calls: list[Path] = []
    real_sha256 = model_manifest.sha256_file

    def counting_sha256(p: Path) -> str:
        calls.append(p)
        return real_sha256(p)

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", counting_sha256)

    assert word_aligner_is_cached() is True
    assert word_aligner_is_cached() is True
    assert len(calls) == 4  # one hash per manifest file, then remembered

    (snap / "onnx" / "model.onnx").write_bytes(b"xy")
    assert word_aligner_is_cached() is False
    assert len(calls) == 5


def test_is_cached_is_false_when_a_pinned_file_vanishes(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )

    def raise_oserror(model_dir: Path, model, *, memoize: bool = False) -> None:
        raise OSError("vanished")

    monkeypatch.setattr(
        "podcast_mcp.word_aligner_models.verify_word_aligner_snapshot", raise_oserror
    )
    assert word_aligner_is_cached() is False


def test_is_cached_hashes_once_under_concurrent_status_checks(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    model = word_aligner_model()
    manifest = dict(model.file_sha256)
    calls: list[Path] = []

    def fake_sha256(p: Path) -> str:
        calls.append(p)
        time.sleep(0.05)
        return manifest[p.relative_to(snap).as_posix()]

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", fake_sha256)

    results: list[bool] = []
    threads = [
        threading.Thread(target=lambda: results.append(word_aligner_is_cached())) for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [True, True]
    assert len(calls) == len(manifest)


def test_is_cached_remembers_a_pin_mismatch_until_the_file_changes(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    (snap / "onnx" / "model.onnx").write_bytes(b"tampered bytes")

    assert word_aligner_is_cached() is False
    assert word_aligner_is_cached() is False

    model = word_aligner_model()
    manifest = dict(model.file_sha256)
    real_bytes = f"fake {model.onnx_file}".encode()
    assert manifest[model.onnx_file] != model_manifest.sha256_file(snap / model.onnx_file)
    (snap / model.onnx_file).write_bytes(real_bytes)
    assert word_aligner_is_cached() is True


def test_word_aligner_problem_is_none_when_ready(tmp_path, monkeypatch) -> None:
    snap = tmp_path / "snap"
    pin_word_aligner_to_fake_snapshot(snap, monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    assert word_aligner_problem() is None


def test_model_supports_only_catalog_languages() -> None:
    model = word_aligner_model()

    assert model.supports_language("en")
    assert model.supports_language(None)
    assert not model.supports_language("de")


def test_tampered_vocab_json_fails_status_bootstrap_and_load(tmp_path, monkeypatch) -> None:
    snap = pin_word_aligner_to_fake_snapshot(tmp_path / "snap", monkeypatch)
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    (snap / "vocab.json").write_bytes(b'{"tampered": 1}')

    assert word_aligner_is_cached() is False

    problem = word_aligner_problem()
    assert isinstance(problem, WordAlignerPinMismatchError)
    assert "vocab.json" in str(problem)
    assert "--upgrade" in str(problem)

    with pytest.raises(WordAlignerPinMismatchError, match=r"vocab\.json"):
        bootstrap_word_aligner()


def test_unreadable_hub_cache_reads_as_not_downloaded(monkeypatch) -> None:
    def raise_oserror(*a, **k):
        raise OSError("broken snapshot symlink")

    monkeypatch.setattr("huggingface_hub.snapshot_download", raise_oserror, raising=False)
    with pytest.raises(WordAlignerMissingError, match="local cache unreadable"):
        resolve_word_aligner_dir()
    assert word_aligner_is_cached() is False
