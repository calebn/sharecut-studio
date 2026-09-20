"""Pipeline run must not silently download Whisper weights."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _plant_weight(cache: Path, model: str) -> None:
    blob = cache / f"models--Systran--faster-whisper-{model}" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")


def test_ensure_whisper_cached_for_run_skips_when_transcribe_not_selected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline_config import ensure_whisper_cached_for_run

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )
    # only ingest — must not raise even with empty cache
    ensure_whisper_cached_for_run(only_step="ingest_tracks")
    ensure_whisper_cached_for_run(
        skip_steps=["transcribe_tracks"],
        config={"transcribe": {"model": "small.en"}},
    )
    ensure_whisper_cached_for_run(
        from_step="assemble_timeline",
        config={"transcribe": {"model": "small.en"}},
    )


def test_ensure_whisper_cached_for_run_raises_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline_config import ensure_whisper_cached_for_run
    from podcast_mcp.whisper_models import WhisperWeightsMissingError

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )
    with pytest.raises(WhisperWeightsMissingError, match=r"small\.en"):
        ensure_whisper_cached_for_run(
            only_step="transcribe_tracks",
            config={"transcribe": {"model": "small.en"}},
        )


def test_ensure_whisper_cached_for_run_ok_when_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline_config import ensure_whisper_cached_for_run

    cache = tmp_path / "whisper"
    _plant_weight(cache, "small.en")
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    ensure_whisper_cached_for_run(
        only_step="transcribe_tracks",
        config={"transcribe": {"model": "small.en"}},
    )


def test_pipeline_service_run_fails_fast_without_weights(
    minimal_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline import PipelineService
    from podcast_mcp.services.workspace import ProjectWorkspace
    from podcast_mcp.whisper_models import WhisperWeightsMissingError

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(WhisperWeightsMissingError):
        PipelineService(ws).run(
            only_step="transcribe_tracks",
            config={"transcribe": {"model": "small.en"}},
        )


def test_pipeline_service_run_skips_gate_for_ingest_only(
    minimal_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline import PipelineService
    from podcast_mcp.services.workspace import ProjectWorkspace

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )

    def fake_run(self, project, **kwargs):
        return MagicMock(steps=[])

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineRunner.run",
        fake_run,
    )
    ws = ProjectWorkspace.open(minimal_project)
    PipelineService(ws).run(only_step="ingest_tracks")


def test_gui_pipeline_run_409_when_weights_missing(
    minimal_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.pipeline_config import config_store

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )
    path = str(minimal_project)
    config_store().put(
        Path(path),
        config={"transcribe": {"model": "small.en"}},
        enabled_steps=["ingest_tracks", "transcribe_tracks"],
    )
    started = {"called": False}

    def boom(*_a, **_k):
        started["called"] = True
        raise AssertionError("jobs.start must not run when weights are missing")

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.PipelineJobManager.start",
        boom,
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run",
        json={"path": path, "use_working_set": True},
    )
    assert res.status_code == 409
    assert "not downloaded" in res.json()["detail"]
    assert started["called"] is False
    status = client.get("/api/pipeline/status")
    assert status.status_code == 200
    assert status.json()["running"] is False


def test_transcription_engine_uses_local_files_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.transcribe import TranscriptionEngine

    _plant_weight(tmp_path, "tiny.en")
    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path,
    )
    captured: dict = {}

    def fake_model(name, **kwargs):
        captured["name"] = name
        captured.update(kwargs)
        return MagicMock()

    with patch("faster_whisper.WhisperModel", side_effect=fake_model):
        eng = TranscriptionEngine("tiny.en")
        eng._get_model()
    assert captured["local_files_only"] is True
    assert captured["name"] == "tiny.en"


def test_transcription_engine_raises_when_weights_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.transcribe import TranscriptionEngine
    from podcast_mcp.whisper_models import WhisperWeightsMissingError

    monkeypatch.setattr(
        "podcast_mcp.config.whisper_cache_dir",
        lambda: tmp_path / "empty",
    )
    eng = TranscriptionEngine("tiny.en")
    with pytest.raises(WhisperWeightsMissingError, match=r"tiny\.en"):
        eng._get_model()


def test_selected_whisper_model_uses_yaml_when_prefs_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.services.pipeline_config import _selected_whisper_model
    from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL

    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.setattr(
        "podcast_mcp.whisper_models.read_whisper_model_pref",
        lambda: None,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline_config.load_defaults",
        lambda: {"transcribe": {"model": "tiny.en"}},
    )
    assert _selected_whisper_model(None) == "tiny.en"
    assert _selected_whisper_model({"transcribe": {"model": "small.en"}}) == "small.en"
    assert (
        _selected_whisper_model({"transcribe": {"model": "not-a-real-model"}})
        == DEFAULT_WHISPER_MODEL
    )
    assert _selected_whisper_model({"transcribe": {"model": "   "}}) == DEFAULT_WHISPER_MODEL
    assert _selected_whisper_model({"transcribe": "broken"}) == DEFAULT_WHISPER_MODEL
