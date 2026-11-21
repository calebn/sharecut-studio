from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines import onnx_session
from podcast_mcp.engines.asr_options import ForcedAlignment
from podcast_mcp.engines.models.registry import model_record, require_model
from podcast_mcp.engines.models.speaker_ecapa import EcapaOnnx, SpeakerEcapaMissingError
from podcast_mcp.engines.models.word_aligner import resolve_word_aligner_dir, word_aligner_model
from podcast_mcp.engines.speaker_id import SpeakerBackendUnavailable, resolve_speaker_backend
from podcast_mcp.engines.word_align import WordAligner
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.pipeline import ensure_word_aligner_for_run
from podcast_mcp.util import host_platform


@pytest.fixture
def intel_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(host_platform, "current", lambda: host_platform.MACOS)
    monkeypatch.setattr(host_platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(onnx_session, "version", lambda _distribution: "1.23.2", raising=False)


def test_word_aligner_rejects_custom_model_on_legacy_runtime(
    intel_runtime: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / word_aligner_model().onnx_file
    path.parent.mkdir()
    path.write_bytes(b"not an ONNX model")
    (tmp_path / "vocab.json").write_text(json.dumps({"<pad>": 0}), encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(tmp_path))

    with pytest.raises(RuntimeError, match="unset PODCAST_MCP_WORD_ALIGNER_MODEL"):
        WordAligner.load()

    settings = ForcedAlignment.resolve(True)
    assert not settings.enabled
    assert "unset PODCAST_MCP_WORD_ALIGNER_MODEL" in settings.reason
    with pytest.raises(RuntimeError, match="unset PODCAST_MCP_WORD_ALIGNER_MODEL"):
        settings.require()

    status = model_record("word-aligner")
    assert status["state"] == "unsupported"
    assert "unset PODCAST_MCP_WORD_ALIGNER_MODEL" in status["hint"]
    assert "bootstrap" not in status
    with pytest.raises(RuntimeError, match="unset PODCAST_MCP_WORD_ALIGNER_MODEL"):
        ensure_word_aligner_for_run(
            {"transcribe": {"forced_alignment": {"enabled": True}}}, only_step="transcribe_tracks"
        )


def test_ecapa_rejects_custom_model_on_legacy_runtime(
    intel_runtime: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "model.onnx"
    path.write_bytes(b"not an ONNX model")
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(path))

    with pytest.raises(SpeakerEcapaMissingError, match="unset PODCAST_MCP_SPEAKER_ECAPA_MODEL"):
        EcapaOnnx().embed(np.zeros(1600, dtype=np.float32))
    with pytest.raises(SpeakerBackendUnavailable, match="unset PODCAST_MCP_SPEAKER_ECAPA_MODEL"):
        resolve_speaker_backend()

    status = model_record("speaker-ecapa")
    assert status["state"] == "unsupported"
    assert "unset PODCAST_MCP_SPEAKER_ECAPA_MODEL" in status["hint"]
    assert "bootstrap" not in status


def test_intel_with_a_newer_runtime_accepts_local_model_configuration(
    intel_runtime: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(onnx_session, "version", lambda _distribution: "1.31.1")
    path = tmp_path / word_aligner_model().onnx_file
    path.parent.mkdir()
    path.write_bytes(b"custom model bytes")
    (tmp_path / "vocab.json").write_text(json.dumps({"<pad>": 0}), encoding="utf-8")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(tmp_path))
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(path))

    assert resolve_word_aligner_dir() == tmp_path
    assert model_record("speaker-ecapa")["state"] == "installed"


@pytest.mark.parametrize(
    ("component", "setting"),
    [
        ("word-aligner", "PODCAST_MCP_WORD_ALIGNER_MODEL"),
        ("speaker-ecapa", "PODCAST_MCP_SPEAKER_ECAPA_MODEL"),
    ],
)
def test_bootstrap_reports_intel_override_in_cli_and_gui(
    component: str,
    setting: str,
    intel_runtime: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    local_path = tmp_path / "custom-model"
    monkeypatch.setenv(setting, str(local_path))
    hint = f"unset {setting}"

    with pytest.raises(RuntimeError, match=hint):
        require_model(component)

    result = CliRunner().invoke(app, ["bootstrap", "--component", component, "--upgrade"])
    assert result.exit_code == 1
    assert "[get]" not in result.stdout
    assert hint in result.stderr
    assert str(local_path) not in result.stderr

    gui = create_app()
    manager = JobManager()
    gui.state.jobs = manager
    client = TestClient(gui)
    catalog = client.get("/api/bootstrap/status").json()["models"]
    row = next(row for row in catalog if row["id"] == component)
    assert row["state"] == "unsupported"
    assert hint in row["hint"]
    assert "bootstrap" not in row
    assert "path" not in row

    started = client.post("/api/bootstrap/run", json={"components": [component], "force": True})
    assert started.status_code == 200
    job_id = started.json()["job"]["id"]
    job = manager.get_bootstrap_job(job_id)
    assert job is not None
    manager.wait(job, timeout=5)
    status = client.get("/api/bootstrap/status-job", params={"job_id": job_id}).json()["job"]
    assert status["status"] == "error"
    assert status["failure"]["kind"] == "configuration"
    assert hint in status["error"]
    assert hint in status["failure"]["plain"]
    assert str(local_path) not in status["error"]
