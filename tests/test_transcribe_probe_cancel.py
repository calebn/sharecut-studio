from collections.abc import Iterator
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.whisper_device import WhisperPlacement
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import render_cancel_scope


def test_an_already_cancelled_probe_does_not_load_a_model(monkeypatch) -> None:
    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    load_model = Mock(side_effect=AssertionError("Cancelled probe started model loading"))
    monkeypatch.setattr(engine, "_get_model", load_model)

    with render_cancel_scope(lambda: True), pytest.raises(CancelledProgress):
        engine.transcribe_samples(np.zeros(1600))

    load_model.assert_not_called()


@pytest.mark.parametrize("ratio", [None, 0.6, 26.0], ids=["empty", "ordinary", "looping"])
@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_cancelling_during_a_probe_raises_without_a_retry(ratio, device) -> None:
    stop = Event()
    calls = []

    class Model:
        def transcribe(self, samples, **options):
            calls.append(options)

            def segments() -> Iterator[SimpleNamespace]:
                if ratio is not None:
                    yield SimpleNamespace(text=" Heard words. ", compression_ratio=ratio)
                stop.set()

            return segments(), None

    model = Model()
    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = model
    placement = WhisperPlacement(device, "int8")
    engine.placement = placement

    with render_cancel_scope(stop.is_set), pytest.raises(CancelledProgress):
        engine.transcribe_samples(np.zeros(1600))

    assert len(calls) == 1
    assert engine.placement == placement
    assert engine._model is model


def test_cancelling_during_the_penalised_retry_does_not_return_text() -> None:
    stop = Event()
    calls = []

    class Model:
        def transcribe(self, samples, **options):
            calls.append(options)

            def segments() -> Iterator[SimpleNamespace]:
                yield SimpleNamespace(text=" Repeated words. ", compression_ratio=26.0)
                if len(calls) == 2:
                    stop.set()

            return segments(), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = Model()

    with render_cancel_scope(stop.is_set), pytest.raises(CancelledProgress):
        engine.transcribe_samples(np.zeros(1600))

    assert len(calls) == 2
    assert calls[1]["repetition_penalty"] == 1.3
