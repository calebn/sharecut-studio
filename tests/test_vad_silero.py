from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines import vad_silero


@pytest.fixture(autouse=True)
def _clear_vad_cache():
    vad_silero._cached_vad.cache_clear()
    yield
    vad_silero._cached_vad.cache_clear()


def test_model_path_resolves_bundled_asset():
    path = vad_silero.model_path()
    assert path.name == "silero_vad_v6.onnx"
    assert path.is_file()


def test_model_path_raises_when_asset_missing(tmp_path):
    with patch("faster_whisper.utils.get_assets_path", return_value=str(tmp_path)):
        with pytest.raises(FileNotFoundError):
            vad_silero.model_path()


def test_is_available_true_in_normal_env():
    assert vad_silero.is_available() is True


def test_is_available_false_when_onnxruntime_missing():
    with patch.dict("sys.modules", {"onnxruntime": None}):
        assert vad_silero.is_available() is False


def test_speech_probs_empty_input_returns_empty():
    vad = vad_silero.SileroVAD()
    probs = vad.speech_probs(np.zeros(0, dtype=np.float32))
    assert probs.size == 0


def test_speech_probs_pads_partial_final_window():
    vad = vad_silero.SileroVAD()
    samples = np.zeros(vad_silero.SileroVAD.WINDOW_SAMPLES + 10, dtype=np.float32)
    probs = vad.speech_probs(samples)
    assert probs.size == 2


def test_speech_probs_low_for_silence():
    vad = vad_silero.SileroVAD()
    samples = np.zeros(vad_silero.SileroVAD.SAMPLE_RATE, dtype=np.float32)
    probs = vad.speech_probs(samples)
    assert probs.size > 0
    assert float(probs.mean()) < 0.1


def test_get_shared_vad_returns_singleton():
    first = vad_silero.get_shared_vad()
    second = vad_silero.get_shared_vad()
    assert first is second
    assert first is not None


def test_get_shared_vad_returns_none_when_unavailable():
    with patch.object(vad_silero, "is_available", return_value=False):
        assert vad_silero.get_shared_vad() is None


def test_get_shared_vad_returns_none_on_construction_failure():
    with patch.object(vad_silero, "is_available", return_value=True):
        with patch.object(vad_silero, "SileroVAD", side_effect=RuntimeError("boom")):
            assert vad_silero.get_shared_vad() is None
