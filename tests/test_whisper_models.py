from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from model_pin_helpers import plant_pinned_whisper
from podcast_mcp.util import model_manifest
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODEL_IDS,
    WHISPER_PINS,
    WhisperPinMismatchError,
    WhisperWeightsMissingError,
    bootstrap_whisper_model,
    cache_path_matches_model,
    ensure_whisper_model_cached,
    persist_whisper_model,
    read_whisper_model_pref,
    resolve_whisper_model,
    resolve_whisper_model_path,
    validate_whisper_model,
    whisper_model_is_cached,
    whisper_model_problem,
)


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    model_manifest.clear_manifest_memo()
    yield
    model_manifest.clear_manifest_memo()


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


def test_whisper_pins_cover_the_catalog() -> None:
    import faster_whisper.utils as fw_utils

    assert set(WHISPER_PINS) == set(WHISPER_MODEL_IDS)
    names_seen = set()
    for model_id, pin in WHISPER_PINS.items():
        assert pin.hf_repo == fw_utils._MODELS[model_id]
        assert len(pin.revision) == 40
        assert all(c in "0123456789abcdef" for c in pin.revision)
        names = [name for name, _ in pin.file_sha256]
        assert len(names) == len(set(names))
        for _name, digest in pin.file_sha256:
            assert len(digest) == 64
            int(digest, 16)
        assert "model.bin" in names
        assert "config.json" in names
        assert "tokenizer.json" in names
        vocab_names = [n for n in names if n.startswith("vocabulary.")]
        assert len(vocab_names) == 1
        names_seen.add(model_id)
    assert names_seen == set(WHISPER_MODEL_IDS)


def test_whisper_model_is_cached_missing_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "no-such-whisper-dir",
    )
    from podcast_mcp.whisper_models import catalog_payload

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
    cache = tmp_path / "whisper"
    blobs = cache / "models--Systran--faster-whisper-base" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "partial.chunk").write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert whisper_model_is_cached("base") is False

    (blobs / "model.safetensors").write_bytes(b"x")
    assert whisper_model_is_cached("base") is True


def test_snapshot_at_another_revision_is_not_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    pin = WHISPER_PINS["small.en"]
    other_rev = "1111111111111111111111111111111111111a"
    snap = cache / f"models--{pin.hf_repo.replace('/', '--')}" / "snapshots" / other_rev
    for name in pin.allow_patterns:
        path = snap / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    assert whisper_model_is_cached("small.en") is False


def test_missing_pinned_file_is_not_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "whisper"
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    (snap / "tokenizer.json").unlink()

    assert whisper_model_is_cached("small.en") is False
    problem = whisper_model_problem("small.en")
    assert isinstance(problem, WhisperWeightsMissingError)
    assert not isinstance(problem, WhisperPinMismatchError)


def test_status_check_memoises_whisper_hashes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    pin = WHISPER_PINS["small.en"]
    calls: list[Path] = []
    real_sha256 = model_manifest.sha256_file

    def counting_sha256(p: Path) -> str:
        calls.append(p)
        return real_sha256(p)

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", counting_sha256)

    assert whisper_model_is_cached("small.en", memoize=True) is True
    assert len(calls) == len(pin.file_sha256)
    assert whisper_model_is_cached("small.en", memoize=True) is True
    assert len(calls) == len(pin.file_sha256)
    assert snap.exists()


def test_bootstrap_whisper_model_downloads_and_persists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config import whisper_cache_dir

    cache = whisper_cache_dir()
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    pin = WHISPER_PINS["small.en"]
    calls: dict[str, object] = {}

    def fake_snapshot_download(repo, **kwargs):
        calls["repo"] = repo
        calls.update(kwargs)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)

    out = bootstrap_whisper_model("small.en")
    assert out["ok"] is True
    assert out["model"] == "small.en"
    assert out["persist_error"] is None
    assert calls["revision"] == pin.revision
    assert calls["allow_patterns"] == pin.allow_patterns
    assert str(calls["cache_dir"]) == str(cache)
    assert calls["force_download"] is False
    assert "local_files_only" not in calls
    assert resolve_whisper_model() == "small.en"


def test_bootstrap_whisper_model_force_redownloads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config import whisper_cache_dir

    cache = whisper_cache_dir()
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    calls: dict[str, object] = {}

    def fake_snapshot_download(repo, **kwargs):
        calls.update(kwargs)
        return str(snap)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download, raising=False)

    bootstrap_whisper_model("small.en", force=True)
    assert calls["force_download"] is True


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
        out = bootstrap_whisper_model("base")
    assert out["ok"] is True
    assert out["model"] == "base"
    assert out["persist_error"] == "disk full"


def test_bootstrap_unpinned_size_uses_faster_whisper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from unittest.mock import MagicMock, patch

    from podcast_mcp.config import whisper_cache_dir

    calls: list[dict] = []

    def fake_model(name, **kwargs):
        calls.append({"name": name, **kwargs})
        return MagicMock()

    snapshot_calls: list[object] = []
    with (
        patch("faster_whisper.WhisperModel", side_effect=fake_model),
        patch(
            "huggingface_hub.snapshot_download",
            side_effect=lambda *a, **k: snapshot_calls.append((a, k)),
            raising=False,
        ),
    ):
        out = bootstrap_whisper_model("tiny")
    assert out["ok"] is True
    assert calls == [
        {
            "name": "tiny",
            "device": "cpu",
            "compute_type": "int8",
            "download_root": str(whisper_cache_dir()),
        }
    ]
    assert snapshot_calls == []


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
    plant_pinned_whisper(cache, "small.en", monkeypatch)
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert ensure_whisper_model_cached("small.en") == "small.en"


def test_resolve_whisper_model_path_returns_verified_snapshot_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert resolve_whisper_model_path("small.en") == str(snap)


def test_resolve_whisper_model_path_unpinned_returns_size_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    blobs = cache / "models--Systran--faster-whisper-base" / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "model.bin").write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    assert resolve_whisper_model_path("base") == "base"


def test_tampered_vocabulary_fails_status_load_and_bootstrap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config import whisper_cache_dir

    cache = whisper_cache_dir()
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    (snap / "vocabulary.txt").write_bytes(b"tampered")

    assert whisper_model_is_cached("small.en") is False

    problem = whisper_model_problem("small.en")
    assert isinstance(problem, WhisperPinMismatchError)
    assert "vocabulary.txt" in str(problem)
    assert "--upgrade" in str(problem)

    with pytest.raises(WhisperPinMismatchError, match=r"vocabulary\.txt"):
        ensure_whisper_model_cached("small.en")

    with pytest.raises(WhisperPinMismatchError, match=r"vocabulary\.txt"):
        resolve_whisper_model_path("small.en")

    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(snap), raising=False
    )
    with pytest.raises(WhisperPinMismatchError, match=r"vocabulary\.txt"):
        bootstrap_whisper_model("small.en")
    assert read_whisper_model_pref() is None


def test_unreadable_hub_cache_reads_as_not_downloaded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def raise_oserror(*a, **k):
        raise OSError("broken snapshot symlink")

    monkeypatch.setattr("huggingface_hub.snapshot_download", raise_oserror, raising=False)
    problem = whisper_model_problem("small.en")
    assert isinstance(problem, WhisperWeightsMissingError)
    assert not isinstance(problem, WhisperPinMismatchError)
    with pytest.raises(WhisperWeightsMissingError):
        ensure_whisper_model_cached("small.en")
    with pytest.raises(WhisperWeightsMissingError):
        resolve_whisper_model_path("small.en")


def test_resolve_whisper_model_path_maps_a_vanishing_file_to_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    plant_pinned_whisper(cache, "small.en", monkeypatch)
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)

    def raise_oserror(p: Path) -> str:
        raise FileNotFoundError(p)

    monkeypatch.setattr("podcast_mcp.util.model_manifest.sha256_file", raise_oserror)
    with pytest.raises(WhisperWeightsMissingError) as excinfo:
        resolve_whisper_model_path("small.en")
    assert not isinstance(excinfo.value, WhisperPinMismatchError)
    assert "podcast bootstrap --component whisper" in str(excinfo.value)


def test_run_gate_rehashes_a_file_a_status_poll_remembered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "whisper"
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    snap = plant_pinned_whisper(cache, "small.en", monkeypatch)
    assert whisper_model_is_cached("small.en", memoize=True) is True
    target = snap / "vocabulary.txt"
    st = target.stat()
    target.write_bytes(b"x" * st.st_size)  # same size ...
    os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns))  # ... and mtime the poll saw
    assert whisper_model_is_cached("small.en", memoize=True) is True  # stale poll memo
    with pytest.raises(WhisperPinMismatchError, match=r"vocabulary\.txt"):
        ensure_whisper_model_cached("small.en")
    with pytest.raises(WhisperPinMismatchError, match=r"vocabulary\.txt"):
        resolve_whisper_model_path("small.en")
