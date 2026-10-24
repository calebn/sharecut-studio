"""Pins the ECAPA ONNX speaker path so the other backends can be removed without changing it (#2255)."""

from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import speaker_id
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.models import speaker_ecapa
from podcast_mcp.project.transcript_context import SpeakerIdConfig

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "ami_bleed_60s"
BASELINE = ROOT / "fixtures" / "speaker_ecapa" / "ami_bleed_60s_embeddings.json"


@pytest.fixture
def ready_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)
    monkeypatch.setattr(speaker_ecapa, "speaker_ecapa_problem", lambda **_: None)


@pytest.mark.parametrize("name", [None, "auto", "ecapa-onnx"])
def test_a_ready_model_resolves_to_the_onnx_backend(ready_model: None, name: str | None) -> None:
    backend = speaker_id.resolve_speaker_backend(name)
    assert type(backend) is speaker_id.OnnxEcapaBackend
    assert backend.name() == "ecapa-onnx"


def test_the_onnx_backend_passes_the_samples_through_the_session(
    ready_model: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: list[tuple[int, ...]] = []

    class FakeSession:
        def __init__(self, path: str, **_: object) -> None: ...

        def run(self, _outputs: object, feed: dict[str, np.ndarray]) -> list[np.ndarray]:
            seen.append(feed["features"].shape)
            return [np.arange(192, dtype=np.float64).reshape(1, 1, 192)]

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        types.SimpleNamespace(
            SessionOptions=lambda: types.SimpleNamespace(), InferenceSession=FakeSession
        ),
    )
    model = tmp_path / "m.onnx"
    model.write_bytes(b"x")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(model))
    backend = speaker_id.resolve_speaker_backend()
    out = backend.embed(np.zeros(32000, dtype=np.float32), 16000)
    assert out.dtype == np.float32
    np.testing.assert_array_equal(out, np.arange(192, dtype=np.float32))
    assert seen == [(1, 201, 80)]


def test_a_missing_model_is_the_model_not_installed_state(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)
    monkeypatch.setattr(speaker_ecapa, "models_dir", lambda: tmp_path / "models")
    for name in (None, "auto", "ecapa-onnx"):
        with pytest.raises(speaker_id.SpeakerModelMissing) as caught:
            speaker_id.resolve_speaker_backend(name)
        assert caught.value.code == "model_needed"


@pytest.mark.skipif(
    not os.environ.get("PODCAST_TEST_ECAPA_ONNX"),
    reason="set PODCAST_TEST_ECAPA_ONNX to the pinned ecapa-voxceleb-embedding.onnx",
)
def test_real_model_embeddings_on_the_ami_fixture_match_the_recorded_baseline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", os.environ["PODCAST_TEST_ECAPA_ONNX"])
    backend = speaker_id.resolve_speaker_backend()
    cfg = SpeakerIdConfig()
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    assert len(baseline) == 4
    for key, want in baseline.items():
        _, track, start = key.split(":")
        samples = load_mono_window(
            FIXTURE / "raw" / f"{track}.wav",
            start_sec=float(start),
            duration_sec=3.0,
            sample_rate=cfg.sample_rate,
            antialias=True,
        )
        got = backend.embed(samples, cfg.sample_rate)
        want_vec = np.asarray(want, dtype=np.float32)
        cosine = float(got @ want_vec / np.linalg.norm(got) / np.linalg.norm(want_vec))
        assert cosine > 0.99999, key
        np.testing.assert_allclose(got, want_vec, atol=1e-2, rtol=1e-3)
