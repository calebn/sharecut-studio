from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from podcast_mcp.gui import host_mcp
from podcast_mcp.gui.routes import bootstrap
from podcast_mcp.services.jobs import AgentJobFanInReporter, JobManager
from podcast_mcp.util.progress import progress_task


def host_call(monkeypatch, tmp_path: Path, manager: JobManager, body):
    server = SimpleNamespace(
        call_tool=body,
        _tool_manager=SimpleNamespace(get_tool=lambda _name: None),
    )
    monkeypatch.setattr(host_mcp, "mcp", server)
    monkeypatch.setattr(host_mcp, "_call_tool_wrapped", False)
    host_mcp.install_host_project_injection()
    app = FastAPI()
    app.state.served_project = tmp_path / "synthetic-project.json"
    app.state.jobs = manager
    app.include_router(bootstrap.router)
    return app, server


def remove(app: FastAPI):
    return TestClient(app).delete("/api/bootstrap/models/rnnoise")


@pytest.mark.asyncio
async def test_host_body_before_first_progress_excludes_removal(monkeypatch, tmp_path):
    manager = JobManager()
    entered, finish = asyncio.Event(), asyncio.Event()
    uninstall = Mock(return_value={"ok": True})
    monkeypatch.setattr(bootstrap, "uninstall_model", uninstall)

    async def body(_name, _arguments, _context=None):
        reporter = AgentJobFanInReporter(manager)
        reporter.LAZY_AFTER_SEC = 60
        with progress_task("synthetic-model-user", "Synthetic model user", reporter=reporter):
            entered.set()
            await finish.wait()

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    token = host_mcp._request_app.set(app)
    task = asyncio.create_task(server.call_tool("synthetic", {}))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert manager.status()["running"] is False
        response = remove(app)
        assert response.status_code == 409
        assert response.headers["X-Sharecut-Error-Code"] == "pipeline_busy"
        uninstall.assert_not_called()
    finally:
        finish.set()
        await task
        host_mcp._request_app.reset(token)
    assert remove(app).status_code == 200
    uninstall.assert_called_once()


@pytest.mark.asyncio
async def test_evicted_activity_is_not_completed_host_work(monkeypatch, tmp_path):
    manager = JobManager()
    entered = [asyncio.Event() for _ in range(9)]
    finish = [asyncio.Event() for _ in range(9)]
    uninstall = Mock(return_value={"ok": True})
    monkeypatch.setattr(bootstrap, "uninstall_model", uninstall)

    async def body(_name, arguments, _context=None):
        index = arguments["index"]
        name = f"synthetic-model-user-{index}"
        reporter = AgentJobFanInReporter(manager)
        with progress_task(name, name, reporter=reporter):
            reporter.message(name, "Synthetic progress")
            entered[index].set()
            await finish[index].wait()

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    token = host_mcp._request_app.set(app)
    tasks = []
    try:
        for index in range(9):
            tasks.append(asyncio.create_task(server.call_tool("synthetic", {"index": index})))
            await asyncio.wait_for(entered[index].wait(), 1)
        for event in finish[1:]:
            event.set()
        await asyncio.gather(*tasks[1:])
        assert manager.status()["running"] is False
        assert remove(app).status_code == 409
        uninstall.assert_not_called()
    finally:
        for event in finish:
            event.set()
        await asyncio.gather(*tasks)
        host_mcp._request_app.reset(token)
    assert remove(app).status_code == 200


@pytest.mark.asyncio
async def test_removal_refuses_host_body_without_waiting(monkeypatch, tmp_path):
    manager = JobManager()
    called = Mock()

    async def body(_name, _arguments, _context=None):
        called()

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    token = host_mcp._request_app.set(app)
    try:
        with manager.model_removal():
            result = await asyncio.wait_for(server.call_tool("synthetic", {}), 1)
            assert result.is_error is True
            assert result.structured_content["error_code"] == "job_running"
            called.assert_not_called()
            assert manager.status()["running"] is False
            assert manager.cancel() is None
    finally:
        host_mcp._request_app.reset(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["ok", "error", "cancel"])
async def test_host_lifetime_releases_on_actual_exit(monkeypatch, tmp_path, outcome):
    manager = JobManager()
    entered, finish = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(bootstrap, "uninstall_model", Mock(return_value={"ok": True}))

    async def body(_name, _arguments, _context=None):
        entered.set()
        await finish.wait()
        if outcome == "error":
            raise RuntimeError("synthetic failure")
        return "done"

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    token = host_mcp._request_app.set(app)
    task = asyncio.create_task(server.call_tool("synthetic", {}))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert remove(app).status_code == 409
    finally:
        if outcome == "cancel":
            task.cancel()
        else:
            finish.set()
        if outcome == "error":
            with pytest.raises(RuntimeError, match="synthetic failure"):
                await task
        elif outcome == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await task
        host_mcp._request_app.reset(token)
    assert remove(app).status_code == 200


@pytest.mark.asyncio
async def test_nested_host_call_keeps_outer_lifetime(monkeypatch, tmp_path):
    manager = JobManager()
    entered, finish = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(bootstrap, "uninstall_model", Mock(return_value={"ok": True}))

    async def body(_name, arguments, _context=None):
        if arguments.get("inner"):
            return "inner finished"
        assert await server.call_tool("synthetic", {"inner": True}) == "inner finished"
        entered.set()
        await finish.wait()

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    token = host_mcp._request_app.set(app)
    task = asyncio.create_task(server.call_tool("synthetic", {}))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert remove(app).status_code == 409
    finally:
        finish.set()
        await task
        host_mcp._request_app.reset(token)
    assert remove(app).status_code == 200


@pytest.mark.asyncio
async def test_refused_removal_reopens_host_admission(monkeypatch, tmp_path):
    from podcast_mcp.services.jobs import Job

    manager = JobManager()
    manager._job = Job(id="synthetic-pipeline", status="running")
    called = Mock()

    async def body(_name, _arguments, _context=None):
        called()
        return "done"

    app, server = host_call(monkeypatch, tmp_path, manager, body)
    assert remove(app).status_code == 409
    token = host_mcp._request_app.set(app)
    try:
        assert await server.call_tool("synthetic", {}) == "done"
        called.assert_called_once()
    finally:
        host_mcp._request_app.reset(token)
