"""Whisper entries refuse with ``model_needed`` when the model is absent (#2046)."""

from __future__ import annotations

from pathlib import Path

import pytest
from mcp.client import Client
from typer.testing import CliRunner

from model_pin_helpers import isolate_model_env
from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.services.jobs import manager as jobs_manager

runner = CliRunner()

WHISPER_COMMAND = "podcast bootstrap --component whisper --whisper-model small.en"


@pytest.fixture(autouse=True)
def _no_whisper(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    isolate_model_env(monkeypatch, tmp_path)
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: tmp_path / "none")
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "small.en")


def _assert_whisper_fields(model: dict) -> None:
    assert model["id"] == "whisper"
    assert model["model"] == "small.en"
    assert model["state"] == "missing"
    assert model["command"] == WHISPER_COMMAND
    assert model["size"]


def test_cli_transcribe_without_the_model_leaves_the_project_unchanged(
    minimal_project: Path,
) -> None:
    before = minimal_project.read_bytes()
    result = runner.invoke(app, ["transcribe", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert f"run `{WHISPER_COMMAND}` (code model_needed)" in result.stderr
    assert minimal_project.read_bytes() == before


@pytest.mark.asyncio
async def test_mcp_transcribe_track_without_the_model_is_a_coded_refusal(
    minimal_project: Path,
) -> None:
    before = minimal_project.read_bytes()
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "transcribe_track", {"project_path": str(minimal_project), "track_id": "host"}
        )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    assert f"run `{WHISPER_COMMAND}`" in result.content[0].text
    _assert_whisper_fields(result.structured_content["model"])
    assert minimal_project.read_bytes() == before


@pytest.mark.asyncio
async def test_mcp_pipeline_run_with_studio_is_refused_before_a_job_starts(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = jobs_manager.JobManager()
    monkeypatch.setattr(jobs_manager, "_SHARED_JOBS", jobs)
    started: list[object] = []
    monkeypatch.setattr(jobs, "start", lambda *a, **k: started.append((a, k)))
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "pipeline_run",
            {
                "project_path": str(minimal_project),
                "only_step": "transcribe_tracks",
                "use_working_set": False,
            },
        )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    _assert_whisper_fields(result.structured_content["model"])
    assert not result.content[0].text.startswith("Error executing tool")
    assert started == []


def test_a_picked_size_is_carried_in_the_command_the_hint_and_the_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.mcp.tool_errors import with_download_hint
    from podcast_mcp.mcp.tools.models import model_download
    from podcast_mcp.services.pipeline.config import ensure_whisper_cached_for_run
    from podcast_mcp.util.model_missing import ModelMissing
    from podcast_mcp.util.tool_refusal import tool_refusal

    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "base")
    with pytest.raises(ModelMissing) as caught:
        ensure_whisper_cached_for_run(
            only_step="transcribe_tracks", config={"transcribe": {"model": "small.en"}}
        )
    assert caught.value.model == "small.en"
    assert caught.value.command == WHISPER_COMMAND

    refusal = tool_refusal(caught.value)
    assert refusal is not None
    hinted = with_download_hint(refusal)
    assert hinted.extra is not None
    assert hinted.extra["whisper_model"] == "small.en"
    assert 'model_download(component="whisper", whisper_model="small.en")' in hinted.message

    seen: dict = {}

    def fake_bootstrap(components, *, whisper_model=None, **_kw):
        seen["whisper_model"] = whisper_model
        return {"ok": True, "results": {"whisper": {"ok": True}}}

    monkeypatch.setattr("podcast_mcp.mcp.tools.models.run_bootstrap", fake_bootstrap)
    monkeypatch.setattr(jobs_manager, "_SHARED_JOBS", None)
    model_download("whisper", whisper_model=hinted.extra["whisper_model"])
    assert seen["whisper_model"] == "small.en"


def test_weights_that_vanish_after_the_gate_still_raise_model_missing() -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.transcribe import TranscriptionEngine
    from podcast_mcp.util.model_missing import ModelMissing

    engine = TranscriptionEngine("small.en", defaults=load_defaults())
    with pytest.raises(ModelMissing) as caught:
        engine._get_model()
    assert caught.value.code == "model_needed"
    assert caught.value.command == WHISPER_COMMAND
