from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import DECODE_SEED, TranscriptionEngine


@pytest.fixture
def loads(tmp_path, monkeypatch):
    """Record each model load and each seeding call, in order."""
    blob = tmp_path / "models--Systran--faster-whisper-tiny" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: tmp_path)
    events: list[tuple[str, int | None]] = []

    class FakeModel:
        def __init__(self, *args, **kwargs):
            events.append(("load", None))

        def transcribe(self, *args, **kwargs):
            return [], SimpleNamespace(language="en", duration=0)

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeModel))
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(set_random_seed=lambda seed: events.append(("seed", seed))),
    )
    return events


def _engine() -> TranscriptionEngine:
    return TranscriptionEngine(model_size="tiny", device="cpu", defaults=load_defaults())


def test_the_seed_is_set_before_the_model_loads(loads):
    _engine()._get_model()
    assert loads == [("seed", DECODE_SEED), ("load", None)]


def test_every_file_decodes_on_a_freshly_seeded_model(loads, sample_wav):
    engine = _engine()
    engine.transcribe_file(sample_wav)
    engine.transcribe_file(sample_wav)
    assert loads == [("seed", DECODE_SEED), ("load", None)] * 2


def test_a_model_that_was_not_loaded_here_is_kept(loads, sample_wav):
    engine = _engine()
    engine._model = MagicMock()
    engine._model.transcribe.return_value = ([], SimpleNamespace(language="en", duration=0))
    held = engine._model
    engine.transcribe_file(sample_wav)
    engine.transcribe_file(sample_wav)
    assert engine._model is held
    assert loads == []


def test_the_model_is_released_when_a_decode_fails(loads, sample_wav):
    engine = _engine()
    model = engine._get_model()
    model.transcribe = MagicMock(side_effect=RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        engine.transcribe_file(sample_wav)
    assert engine._model is None


def test_the_probe_shares_the_loaded_model(loads):
    engine = _engine()
    first = engine._get_model()
    assert engine._get_model() is first
    assert loads.count(("load", None)) == 1


def test_a_forked_lane_loads_and_seeds_its_own_model(loads, sample_wav):
    engine = _engine()
    engine._get_model()
    lane = engine.fork_worker(2)
    assert lane._model is None
    assert lane._model_is_ours is False
    lane.transcribe_file(sample_wav)
    assert loads.count(("seed", DECODE_SEED)) == 2
    assert lane._model is None


def test_the_weights_are_checked_once_however_many_files_decode(loads, sample_wav, monkeypatch):
    from podcast_mcp.engines import transcribe

    resolved = []
    real = transcribe.resolve_whisper_model_path
    monkeypatch.setattr(
        transcribe,
        "resolve_whisper_model_path",
        lambda size: resolved.append(size) or real(size),
    )
    engine = _engine()
    for _ in range(3):
        engine.transcribe_file(sample_wav)
    assert len(resolved) == 1
    assert loads.count(("load", None)) == 3
