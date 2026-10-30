"""Explicit forced alignment refuses with ``model_needed`` when its model is absent (#2046)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mcp.client import Client

from model_pin_helpers import isolate_model_env, plant_pinned_word_aligner
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs import manager as jobs_manager
from podcast_mcp.services.pipeline import (
    PipelineService,
    config_store,
    ensure_word_aligner_for_run,
)
from podcast_mcp.util.model_missing import ModelMissing

ALIGNER = "podcast bootstrap --component word-aligner"
EXPLICIT = {"transcribe": {"forced_alignment": {"enabled": True}}}


def _options(value: object) -> AsrOptions:
    return AsrOptions.from_defaults({"transcribe": {"forced_alignment": {"enabled": value}}})


@pytest.fixture(autouse=True)
def _whisper_installed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    isolate_model_env(monkeypatch, tmp_path)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline_jobs.ensure_whisper_cached_for_run", lambda **_k: None
    )
    monkeypatch.setattr(
        "podcast_mcp.mcp.tools.pipeline.ensure_whisper_cached_for_run", lambda **_k: None
    )
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.config.ensure_whisper_cached_for_run", lambda **_k: None
    )


def test_explicit_flag_with_the_model_missing_names_the_download() -> None:
    with pytest.raises(ModelMissing) as caught:
        _options(True).forced_alignment.require()
    assert caught.value.payload() == {
        "id": "word-aligner",
        "model": "onnx-base",
        "label": caught.value.label,
        "purpose": "precise word boundaries",
        "size": "~360 MB",
        "size_bytes": None,
        "command": ALIGNER,
        "state": "missing",
    }


def test_explicit_flag_with_a_mismatched_model_asks_for_the_upgrade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    snap = plant_pinned_word_aligner(monkeypatch, tmp_path)
    (snap / "onnx" / "model.onnx").write_bytes(b"not the pinned bytes")
    with pytest.raises(ModelMissing) as caught:
        _options(True).forced_alignment.require()
    assert caught.value.state == "update_needed"
    assert caught.value.command == f"{ALIGNER} --upgrade"


def test_a_bad_override_names_the_variable_not_a_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bad = tmp_path / "empty-aligner"
    bad.mkdir()
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(bad))
    with pytest.raises(Exception) as caught:
        _options(True).forced_alignment.require()
    assert not isinstance(caught.value, ModelMissing)
    assert "PODCAST_MCP_WORD_ALIGNER_MODEL" in str(caught.value)
    assert "vocab.json" in str(caught.value)
    assert "bootstrap" not in str(caught.value)


@pytest.mark.parametrize("value", [None, False])
def test_unset_or_off_flag_still_falls_back_with_its_reason(value: object) -> None:
    alignment = _options(value).forced_alignment
    alignment.require()
    assert alignment.enabled is False
    assert alignment.blocked is False
    assert alignment.reason.startswith(("unavailable: word aligner", "off: "))


def test_run_gate_follows_the_selected_steps() -> None:
    ensure_word_aligner_for_run(EXPLICIT, only_step="ingest_tracks")
    ensure_word_aligner_for_run({}, only_step="transcribe_tracks")
    with pytest.raises(ModelMissing):
        ensure_word_aligner_for_run(EXPLICIT, only_step="transcribe_tracks")


def test_run_route_answers_409_before_any_job_starts(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_store().put(minimal_project, config=EXPLICIT)
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.JobManager.start",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not start")),
    )
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run", json={"path": str(minimal_project), "use_working_set": True}
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "model_needed"
    model = res.json()["detail"]["model"]
    assert model["id"] == "word-aligner"
    assert model["command"] == ALIGNER
    assert client.get("/api/pipeline/status").json()["running"] is False


def test_pipeline_service_run_refuses_before_its_checkpoint(minimal_project: Path) -> None:
    before = minimal_project.read_bytes()
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ModelMissing):
        PipelineService(ws).run(only_step="transcribe_tracks", config=EXPLICIT)
    assert minimal_project.read_bytes() == before


@pytest.mark.asyncio
async def test_mcp_pipeline_run_with_studio_refuses_before_a_job_starts(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = jobs_manager.JobManager()
    monkeypatch.setattr(jobs_manager, "_SHARED_JOBS", jobs)
    monkeypatch.setattr(
        jobs, "start", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not start"))
    )
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "pipeline_run",
            {
                "project_path": str(minimal_project),
                "only_step": "transcribe_tracks",
                "config": EXPLICIT,
                "use_working_set": False,
            },
        )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    assert result.structured_content["model"]["id"] == "word-aligner"
