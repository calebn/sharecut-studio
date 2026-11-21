from __future__ import annotations

import json
import threading
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
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.jobs.setup_runs import SetupRunQueue
from podcast_mcp.services.pipeline import config_store, ensure_word_aligner_for_run
from podcast_mcp.util import host_platform
from test_host_mcp_http import _initialize, _post_mcp, _rpc_payload


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


FORCED_ALIGNMENT = {"transcribe": {"forced_alignment": {"enabled": True}}}
OVERRIDE_SETTING = "PODCAST_MCP_WORD_ALIGNER_MODEL"
OVERRIDE_CODE = "model_override_unsupported"


def test_owner_run_preserves_the_intel_override_refusal(
    intel_runtime: None, minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(OVERRIDE_SETTING, "/tmp/custom-word-aligner")
    terminal = CliRunner().invoke(
        app,
        [
            "pipeline",
            "run",
            "--project",
            str(minimal_project),
            "--only",
            "transcribe_tracks",
            "--set",
            "transcribe.forced_alignment.enabled=true",
        ],
    )
    assert terminal.exit_code == 1
    assert f"unset {OVERRIDE_SETTING}" in terminal.stderr
    assert OVERRIDE_CODE in terminal.stderr

    gui = create_app(served_project=minimal_project)
    payload = {
        "path": str(minimal_project),
        "only_step": "transcribe_tracks",
        "config": FORCED_ALIGNMENT,
        "use_working_set": False,
    }

    with TestClient(gui, client=("127.0.0.1", 5000)) as client:
        response = client.post("/api/pipeline/run", json=payload)
        assert response.status_code == 409
        assert response.headers["x-sharecut-error-code"] == OVERRIDE_CODE
        assert f"unset {OVERRIDE_SETTING}" in response.json()["detail"]
        assert gui.state.jobs.get_job() is None

        _initialize(client)
        rpc = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "pipeline_run",
                    "arguments": {key: value for key, value in payload.items() if key != "path"},
                },
            },
        )
        result = _rpc_payload(rpc)["result"]["structuredContent"]
        assert result["error_code"] == OVERRIDE_CODE
        assert f"unset {OVERRIDE_SETTING}" in result["error"]
        assert gui.state.jobs.get_job() is None

        monkeypatch.delenv(OVERRIDE_SETTING)
        monkeypatch.setattr(
            "podcast_mcp.gui.routes.pipeline_jobs.ensure_whisper_cached_for_run",
            lambda **_kwargs: None,
        )
        monkeypatch.setattr(
            gui.state.jobs, "start", lambda *_args, **_kwargs: Job(id="accepted", kind="pipeline")
        )
        admitted = client.post(
            "/api/pipeline/run",
            json={**payload, "config": {"transcribe": {"forced_alignment": {"enabled": False}}}},
        )
        assert admitted.status_code == 200
        assert admitted.json()["job"]["id"] == "accepted"


def test_setup_intent_refuses_invalid_configuration_at_admission_and_replay(
    intel_runtime: None,
    minimal_project: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        )
    ]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=1, timeline_start=0)
    ]
    save_project(project, minimal_project)
    config_store().put(minimal_project, config=FORCED_ALIGNMENT)
    gui = create_app(served_project=minimal_project, host_mcp=False)
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    gui.state.jobs = jobs
    gui.state.setup_runs = queue
    client = TestClient(gui, client=("127.0.0.1", 5000))
    request = {"path": str(minimal_project)}

    monkeypatch.setenv(OVERRIDE_SETTING, "/tmp/custom-word-aligner")
    refused = client.post("/api/pipeline/setup-run", json=request)
    assert refused.status_code == 409
    assert refused.headers["x-sharecut-error-code"] == OVERRIDE_CODE
    assert f"unset {OVERRIDE_SETTING}" in refused.json()["detail"]
    assert not queue.waiting(minimal_project)

    monkeypatch.delenv(OVERRIDE_SETTING)
    queued = client.post("/api/pipeline/setup-run", json=request)
    assert queued.status_code == 202
    assert queued.json() == {"queued": True}

    monkeypatch.setenv(OVERRIDE_SETTING, "/tmp/custom-word-aligner")
    queue._dispatch(threading.Event())
    job = client.get("/api/pipeline/status").json()["job"]
    assert job["status"] == "error"
    assert job["error_code"] == OVERRIDE_CODE
    assert f"unset {OVERRIDE_SETTING}" in job["error"]
    assert not queue.waiting(minimal_project)
