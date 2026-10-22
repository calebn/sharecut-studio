"""Short and multichannel input to the speaker embedding (#2034)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
from tests.test_speaker_extended import _speaker_project

from podcast_mcp.engines.models.ecapa_features import ecapa_features
from podcast_mcp.engines.models.speaker_ecapa import EcapaOnnx
from podcast_mcp.engines.speaker_id import enroll_track
from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.project.transcript_context import SpeakerIdConfig

# The pinned network's reflect-padded convolutions reject fewer than about 700 samples.
_NETWORK_MIN_SAMPLES = 700


class _StrictBackend:
    """Embeds like the real network: refuses audio it cannot pad."""

    def __init__(self) -> None:
        self.lengths: list[int] = []

    def name(self) -> str:
        return "strict"

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        self.lengths.append(int(samples.size))
        if samples.size < _NETWORK_MIN_SAMPLES:
            raise RuntimeError("Pad reflect: input too short")
        return np.ones(8, dtype=np.float32)


def test_enrollment_does_not_embed_a_sliver_left_to_reach_the_target(
    tmp_path: Path, sample_wav: Path
) -> None:
    _, project = _speaker_project(tmp_path, sample_wav)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=0.0, end=0.5, confidence=0.95),
                TranscriptWord(text="two", start=0.6, end=1.09, confidence=0.95),
                TranscriptWord(text="three", start=1.2, end=1.8, confidence=0.95),
            ],
        )
    ]
    cfg = SpeakerIdConfig(min_enrollment_sec=1.0, min_enrollment_confidence=0.5)
    backend = _StrictBackend()

    def read(path, start, dur, rate, reader=None):
        return np.zeros(int(dur * rate), dtype=np.float32)

    with patch("podcast_mcp.engines.speaker_id._read_window", side_effect=read):
        profile = enroll_track(project, "host", cfg, backend)

    assert profile is not None
    assert backend.lengths == [8000, 7840]


def test_embed_refuses_audio_too_short_with_a_plain_error() -> None:
    with pytest.raises(ValueError, match="too short"):
        EcapaOnnx(model_path=Path("/nonexistent/model.onnx")).embed(np.zeros(399, dtype=np.float32))


def test_features_refuse_true_multichannel_audio() -> None:
    stereo = np.zeros((16000, 2), dtype=np.float32)
    with pytest.raises(ValueError, match="mono"):
        ecapa_features(stereo)


def test_features_accept_a_single_row_or_column_like_a_flat_signal() -> None:
    x = np.random.RandomState(0).randn(16000).astype(np.float32) * 0.1
    flat = ecapa_features(x)
    np.testing.assert_array_equal(ecapa_features(x[None, :]), flat)
    np.testing.assert_array_equal(ecapa_features(x[:, None]), flat)


def test_embed_boundary_pins_the_production_minimum():
    from podcast_mcp.engines.models.speaker_ecapa import MIN_SAMPLES, EcapaOnnx

    assert MIN_SAMPLES == 800
    model = EcapaOnnx(model_path=Path("/nonexistent/model.onnx"))
    with pytest.raises(ValueError, match="too short"):
        model.embed(np.zeros(MIN_SAMPLES - 1, dtype=np.float32))
    with pytest.raises(Exception) as exc:  # reaches the model load, so not "too short"
        model.embed(np.zeros(MIN_SAMPLES, dtype=np.float32))
    assert "too short" not in str(exc.value)
