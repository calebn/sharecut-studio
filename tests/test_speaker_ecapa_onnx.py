"""Speaker recognition on the pinned ONNX ECAPA export (#1998)."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import speaker_id
from podcast_mcp.engines.models import speaker_ecapa
from podcast_mcp.engines.models.ecapa_features import ecapa_features
from podcast_mcp.services.pipeline.bootstrap import component_status, run_bootstrap
from podcast_mcp.util.coded_error import CodedValueError


def _signal() -> np.ndarray:
    rng = np.random.default_rng(7)
    t = np.arange(24000) / 16000
    w = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 1320 * t)
    w = (w + 0.02 * rng.standard_normal(t.size)).astype(np.float32)
    w[8000:10000] *= 0.05
    return w


def test_features_match_the_torch_front_end() -> None:
    # Reference values from SpeechBrain's Fbank(n_mels=80) + sentence mean norm on the same
    # signal (torch 2.14, speechbrain 1.1.2), sampled every 60th frame and 16th band.
    want = np.array(
        [
            [22.323, 10.413, 2.123, -0.017, -5.797],
            [-23.390, -23.969, -23.478, -21.676, -22.856],
            [-5.044, 4.315, 2.038, 0.823, 6.551],
        ]
    )
    got = ecapa_features(_signal())
    assert got.shape == (151, 80)
    assert got.dtype == np.float32
    np.testing.assert_allclose(got[::60, ::16], want, atol=0.02)
    np.testing.assert_allclose(got.mean(axis=0), 0.0, atol=1e-3)


@pytest.fixture
def model_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(speaker_ecapa, "models_dir", lambda: tmp_path)
    return tmp_path


def _pin_to(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> str:
    sha = hashlib.sha256(payload).hexdigest()
    real = speaker_ecapa.asset_entry
    monkeypatch.setattr(
        speaker_ecapa, "asset_entry", lambda asset_id: {**real(asset_id), "sha256": sha}
    )
    return sha


def test_missing_model_reports_the_bootstrap_command(model_dir: Path) -> None:
    problem = speaker_ecapa.speaker_ecapa_problem()
    assert problem is not None
    assert "podcast bootstrap --component speaker-ecapa" in problem


def test_pinned_bytes_are_ready_and_other_bytes_are_not(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_to(monkeypatch, b"pinned")
    target = speaker_ecapa.speaker_ecapa_path()
    target.write_bytes(b"pinned")
    assert speaker_ecapa.speaker_ecapa_problem() is None
    target.write_bytes(b"swapped")
    problem = speaker_ecapa.speaker_ecapa_problem()
    assert problem is not None and "--upgrade" in problem


def test_override_file_is_used_without_a_pin_check(
    model_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    custom = tmp_path / "mine.onnx"
    custom.write_bytes(b"anything")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(custom))
    assert speaker_ecapa.speaker_ecapa_path() == custom
    assert speaker_ecapa.speaker_ecapa_problem() is None


def test_bootstrap_downloads_verifies_and_skips_when_cached(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sha = _pin_to(monkeypatch, b"model-bytes")
    seen: list[tuple[list[str], str | None]] = []

    def fake_download(urls, dest, *, expected_sha256=None, **_):
        seen.append((list(urls), expected_sha256))
        dest.write_bytes(b"model-bytes")
        return "cdn"

    monkeypatch.setattr(speaker_ecapa, "download_first_ok", fake_download)
    monkeypatch.setenv("PODCAST_BOOTSTRAP_CDN_BASE", "https://cdn.example.test/b")
    first = speaker_ecapa.bootstrap_speaker_ecapa()
    assert first["ok"] and first["source"] == "cdn"
    assert seen[0][1] == sha
    assert seen[0][0][0].startswith("https://cdn.example.test/b/models/speaker-ecapa/")
    again = speaker_ecapa.bootstrap_speaker_ecapa()
    assert again["skipped"] is True and len(seen) == 1
    speaker_ecapa.bootstrap_speaker_ecapa(force=True)
    assert len(seen) == 2


def test_bootstrap_without_a_source_says_so(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    with pytest.raises(speaker_ecapa.SpeakerEcapaMissingError, match="no download source"):
        speaker_ecapa.bootstrap_speaker_ecapa()


def test_component_status_is_opt_in_and_never_gates_first_run(model_dir: Path) -> None:
    status = component_status()
    entry = status["components"]["speaker-ecapa"]
    assert entry["opt_in"] is True and entry["ok"] is False
    assert "speaker-ecapa" in status["opt_in_components"]
    assert "speaker-ecapa" not in status["default_components"]


def test_gui_bootstrap_accepts_the_component(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    result = run_bootstrap(["speaker-ecapa"])
    assert result["ok"] is False
    assert "no download source" in result["results"]["speaker-ecapa"]["error"]
    with pytest.raises(CodedValueError):
        run_bootstrap(["not-a-component"])


def test_auto_backend_prefers_onnx_when_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speaker_ecapa, "speaker_ecapa_problem", lambda: None)
    assert speaker_id.resolve_speaker_backend().name() == "ecapa-onnx"
    assert speaker_id.resolve_speaker_backend("ecapa-onnx").name() == "ecapa-onnx"


def test_explicit_onnx_backend_refuses_when_not_ready(
    model_dir: Path,
) -> None:
    with pytest.raises(ImportError, match="ecapa-onnx"):
        speaker_id.resolve_speaker_backend("ecapa-onnx")


@pytest.mark.skipif(
    not os.environ.get("PODCAST_TEST_ECAPA_ONNX"),
    reason="set PODCAST_TEST_ECAPA_ONNX to an exported ecapa-voxceleb-embedding.onnx",
)
def test_real_model_gives_a_192_dim_embedding_that_tells_voices_apart() -> None:
    model = speaker_ecapa.EcapaOnnx(Path(os.environ["PODCAST_TEST_ECAPA_ONNX"]))
    a = model.embed(_signal())
    assert a.shape == (192,)
    assert np.isfinite(a).all()
    again = model.embed(_signal())
    np.testing.assert_allclose(a, again, atol=1e-6)
    other = model.embed(
        _signal()[::-1].copy() * 0.5
        + 0.05 * np.random.default_rng(1).standard_normal(24000).astype(np.float32)
    )
    cosine = float(a @ other / np.linalg.norm(a) / np.linalg.norm(other))
    assert cosine < 0.999


def test_embedder_checks_the_pin_before_loading_and_flattens_the_output(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sys
    import types

    with pytest.raises(speaker_ecapa.SpeakerEcapaMissingError, match="not downloaded"):
        speaker_ecapa.EcapaOnnx().embed(_signal())

    calls: list[tuple[str, tuple[int, ...]]] = []

    class FakeSession:
        def __init__(self, path: str, **_: object) -> None:
            self.path = path

        def run(self, _outputs: object, feed: dict[str, np.ndarray]) -> list[np.ndarray]:
            calls.append((self.path, feed["features"].shape))
            return [np.ones((1, 1, 192), dtype=np.float64)]

    fake = types.SimpleNamespace(
        SessionOptions=lambda: types.SimpleNamespace(), InferenceSession=FakeSession
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    model_file = model_dir / "any.onnx"
    model_file.write_bytes(b"x")
    embedder = speaker_ecapa.EcapaOnnx(model_file)
    out = embedder.embed(_signal())
    assert out.shape == (192,) and out.dtype == np.float32
    embedder.embed(_signal())
    assert calls == [(str(model_file), (1, 151, 80))] * 2


def test_cli_bootstrap_component_reports_a_failure(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.setup_cmd import setup_app

    monkeypatch.delenv("PODCAST_BOOTSTRAP_CDN_BASE", raising=False)
    result = CliRunner().invoke(setup_app, ["bootstrap", "--component", "speaker-ecapa"])
    assert result.exit_code == 1
    assert "speaker-ecapa" in result.output


def test_cli_bootstrap_component_skips_when_ready(
    model_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.setup_cmd import setup_app

    _pin_to(monkeypatch, b"ready")
    speaker_ecapa.speaker_ecapa_path().write_bytes(b"ready")
    result = CliRunner().invoke(setup_app, ["bootstrap", "--component", "speaker-ecapa"])
    assert result.exit_code == 0
    assert "[skip] speaker-ecapa" in result.output


def test_pin_and_override_misuse_are_reported(
    model_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = speaker_ecapa.asset_entry
    monkeypatch.setattr(
        speaker_ecapa, "asset_entry", lambda asset_id: {**real(asset_id), "sha256": ""}
    )
    with pytest.raises(speaker_ecapa.SpeakerEcapaMissingError, match="no sha256 pin"):
        speaker_ecapa.speaker_ecapa_problem() or speaker_ecapa._pin()
    monkeypatch.setattr(speaker_ecapa, "asset_entry", real)
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "mine.onnx"))
    with pytest.raises(speaker_ecapa.SpeakerEcapaMissingError, match="unset it"):
        speaker_ecapa.bootstrap_speaker_ecapa()


def _compare_script():
    import importlib.util

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "compare_speaker_backends", root / "scripts" / "compare_speaker_backends.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_compare_script_windows_fit_word_length_regions_after_merging() -> None:
    script = _compare_script()
    words = [(0.0, 1.0), (1.2, 2.1), (2.3, 3.4), (10.0, 10.5)]
    merged = script._merge(words)
    assert merged == [(0.0, 3.4), (10.0, 10.5)]
    # unmerged word-length regions never hold a 3 s window; the merged speech does
    assert script._windows(words, 40) == []
    assert script._windows(merged, 40) == [(0.0, 3.0)]
    many = [(float(i) * 10, float(i) * 10 + 9.0) for i in range(30)]
    assert len(script._windows(many, 5)) == 5


def _chain_env(monkeypatch: pytest.MonkeyPatch, *, onnx: bool, speechbrain: bool, lite: bool):
    """Which of the three real backends this machine could build."""
    import sys
    import types

    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.setattr(
        speaker_ecapa, "speaker_ecapa_problem", lambda: None if onnx else "not downloaded"
    )
    if speechbrain:
        monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
        inference = types.ModuleType("speechbrain.inference.speaker")
        inference.EncoderClassifier = object  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "speechbrain", types.ModuleType("speechbrain"))
        monkeypatch.setitem(sys.modules, "speechbrain.inference", types.ModuleType("x"))
        monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", inference)
    else:
        monkeypatch.setitem(sys.modules, "torch", None)

    def encoder() -> object:
        if not lite:
            raise ImportError("no resemblyzer", name="resemblyzer")
        return object

    monkeypatch.setattr(speaker_id, "_import_voice_encoder", encoder)


def test_auto_backend_walks_onnx_then_speechbrain_then_resemblyzer_then_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order = []
    for onnx, speechbrain, lite in [
        (True, True, True),
        (False, True, True),
        (False, False, True),
    ]:
        _chain_env(monkeypatch, onnx=onnx, speechbrain=speechbrain, lite=lite)
        order.append(speaker_id.resolve_speaker_backend("auto").name())
    assert order == ["ecapa-onnx", "speechbrain-ecapa", "resemblyzer"]
    _chain_env(monkeypatch, onnx=False, speechbrain=False, lite=False)
    with pytest.raises(speaker_id.SpeakerBackendUnavailable):
        speaker_id.resolve_speaker_backend("auto")


def test_a_user_model_that_does_not_load_falls_through_in_auto(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    junk = tmp_path / "junk.onnx"
    junk.write_bytes(b"not a model")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(junk))
    _chain_env(monkeypatch, onnx=True, speechbrain=False, lite=True)
    assert speaker_id.resolve_speaker_backend("auto").name() == "resemblyzer"
    with pytest.raises(ImportError, match="override does not load"):
        speaker_id.resolve_speaker_backend("ecapa-onnx")
