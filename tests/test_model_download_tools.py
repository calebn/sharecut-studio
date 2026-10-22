"""``model_download`` and ``model_download_status``: the explicit way out of ``model_needed``."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from mcp.client import Client

from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.registry import require_model
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools.models import model_download, model_download_status
from podcast_mcp.services.jobs import manager as jobs_manager
from podcast_mcp.services.jobs.job import Job
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import bind_progress


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        return lambda *args, **kwargs: self.calls.append((name, args, kwargs))


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(tmp_path / "model.rnnn"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.setattr(jobs_manager, "_SHARED_JOBS", None)


@pytest.fixture
def blocked_run(monkeypatch: pytest.MonkeyPatch):
    """Every Studio bootstrap run waits on ``gate`` instead of downloading."""
    gate = threading.Event()
    calls: list[tuple[Any, ...]] = []

    def run(components=None, *, whisper_model=None, force=False, **_extra):
        calls.append((tuple(components or ()), whisper_model, force))
        gate.wait(timeout=5)
        return {"ok": True, "results": {}}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", run)
    yield calls
    gate.set()


def test_with_studio_it_starts_a_job_and_the_status_reads_it(blocked_run) -> None:
    jobs = jobs_manager.JobManager()
    jobs_manager._SHARED_JOBS = jobs

    started = json.loads(model_download("rnnoise"))
    assert started["ok"] is True
    assert started["adopted"] is False
    assert started["components"] == ["rnnoise"]
    assert started["job_id"] in started["message"]
    assert model_download_status.__name__ in started["message"]

    again = json.loads(model_download("rnnoise"))
    assert (again["job_id"], again["adopted"]) == (started["job_id"], True)

    job = jobs.get_bootstrap_job(started["job_id"])
    assert isinstance(job, Job)
    job.download = {"component": "rnnoise", "bytes": 10, "total": 100}
    for status in (
        json.loads(model_download_status(started["job_id"])),
        json.loads(model_download_status()),
    ):
        assert status == {
            "job_id": started["job_id"],
            "status": job.status,
            "download": {"component": "rnnoise", "bytes": 10, "total": 100},
            "failure": None,
        }
    assert blocked_run == [(("rnnoise",), job.whisper_model, False)]


def test_upgrade_and_whisper_model_reach_the_job(blocked_run) -> None:
    jobs_manager._SHARED_JOBS = jobs_manager.JobManager()
    started = json.loads(model_download("whisper", whisper_model="tiny.en", upgrade=True))
    job = jobs_manager._SHARED_JOBS.get_bootstrap_job(started["job_id"])
    assert (job.whisper_model, job.force, job.components) == ("tiny.en", True, ["whisper"])


def test_status_without_a_job_or_without_studio_is_not_running() -> None:
    assert json.loads(model_download_status()) == {"running": False}
    jobs_manager._SHARED_JOBS = jobs_manager.JobManager()
    assert json.loads(model_download_status()) == {"running": False}
    assert json.loads(model_download_status("nope")) == {"running": False}


def test_without_studio_it_downloads_in_the_call_and_reports_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installs: list[tuple[str | None, bool]] = []

    def install(variant, force, on_progress):
        installs.append((variant, force))
        return {"ok": True, "path": "x"}

    spec = replace(registry.model_spec("rnnoise"), install=install)
    monkeypatch.setattr(boot, "model_spec", lambda model_id: spec)
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    progress = Recorder()
    with bind_progress(progress):
        out = json.loads(model_download("rnnoise", upgrade=True))
    assert out == {"ok": True, "components": ["rnnoise"], "result": {"ok": True, "path": "x"}}
    assert installs == [(None, True)]
    assert json.loads(model_download_status()) == {"running": False}  # no job exists to poll
    assert any(name in {"start", "update"} for name, _, _ in progress.calls)
    assert any(a and a[0] == "bootstrap" for _, a, _ in progress.calls)


def test_without_studio_a_failed_download_is_reported_not_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def install(variant, force, on_progress):
        raise RuntimeError("boom with a /private/path")

    spec = replace(registry.model_spec("rnnoise"), install=install)
    monkeypatch.setattr(boot, "model_spec", lambda model_id: spec)
    monkeypatch.setattr(boot, "component_status", lambda **_k: {})
    out = json.loads(model_download("rnnoise"))
    assert out["ok"] is False
    assert "/private/path" not in json.dumps(out)


@pytest.mark.asyncio
async def test_an_unknown_component_is_a_coded_refusal() -> None:
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool("model_download", {"component": "speaker"})
    assert result.is_error
    assert result.structured_content["error_code"] == "unknown_model"


@pytest.mark.asyncio
async def test_a_busy_slot_is_bootstrap_job_running(blocked_run) -> None:
    jobs_manager._SHARED_JOBS = jobs_manager.JobManager()
    model_download("whisper")
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool("model_download", {"component": "rnnoise"})
    assert result.is_error
    assert result.structured_content["error_code"] == "bootstrap_job_running"


@pytest.mark.asyncio
async def test_the_owner_agent_is_told_to_ask_then_download(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def needs_model(self: Any, comment_id: str) -> Any:
        require_model("rnnoise")

    monkeypatch.setattr("podcast_mcp.services.document.comment.CommentService.get", needs_model)
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "get_comment_tool",
            {"project_path": str(minimal_project), "comment_id": "c"},
        )
    assert result.is_error
    assert result.content[0].text.endswith(
        '\nAsk the user first; then call model_download(component="rnnoise")'
    )
    structured = result.structured_content
    assert structured["error"] == result.content[0].text
    assert structured["error_code"] == "model_needed"
    assert structured["download_tool"] == "model_download"
    assert structured["model"]["id"] == "rnnoise"


def test_the_hint_line_names_the_component(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.mcp.tool_errors import with_download_hint
    from podcast_mcp.util.tool_refusal import tool_refusal

    with pytest.raises(ModelMissing) as caught:
        require_model("rnnoise")
    refusal = tool_refusal(caught.value)
    assert refusal is not None
    hinted = with_download_hint(refusal)
    assert hinted.message == (
        f'{refusal.message}\nAsk the user first; then call model_download(component="rnnoise")'
    )
    assert hinted.extra == {"model": caught.value.payload(), "download_tool": "model_download"}
    guest = tool_refusal(caught.value, for_guest=True)
    assert guest is not None
    assert with_download_hint(guest) is guest


def test_require_model_never_starts_a_download(blocked_run) -> None:
    jobs = jobs_manager.JobManager()
    jobs_manager._SHARED_JOBS = jobs
    for model_id in ("whisper", "rnnoise", "word-aligner", "speaker-ecapa"):
        with pytest.raises(ModelMissing):
            require_model(model_id)
    assert jobs.get_bootstrap_job() is None
    assert blocked_run == []


def test_the_download_tools_are_not_guest_tools() -> None:
    assert not {"model_download", "model_download_status"} & set(ALL_GUEST_TOOLS)


def test_model_download_is_never_handed_to_a_running_studio() -> None:
    """No ``project_path``: the stdio hand-off cannot forward it, so it runs in the caller."""
    import inspect

    assert "project_path" not in inspect.signature(model_download).parameters
    assert "project_path" not in inspect.signature(model_download_status).parameters
