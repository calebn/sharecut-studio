"""Agents and the CLI can cancel a running export; the previous export stays intact (#1164).

Real ffmpeg encodes a 15 min master (mastering is stubbed by the ``slow_export`` fixture).
"""

from __future__ import annotations

import json
import os
import signal
import threading

import anyio
import pytest
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import render_cancel_scope

MP3_FORMAT_OBJECTS = [{"ext": "mp3", "codec": "libmp3lame"}]
MP3_FORMATS = json.dumps(MP3_FORMAT_OBJECTS)


def _export_cmd(slow_export, formats: str) -> list[str]:
    return ["pipeline", "export-audio", "--project", str(slow_export.project), "--formats", formats]


def test_ctrl_c_mid_encode_cancels_the_cli_export_and_keeps_the_previous_one(slow_export) -> None:
    def interrupt_once_encoding() -> None:
        slow_export.wait_until_encoding()
        os.kill(os.getpid(), signal.SIGINT)

    interrupter = threading.Thread(target=interrupt_once_encoding, daemon=True)
    interrupter.start()
    result = CliRunner().invoke(app, _export_cmd(slow_export, MP3_FORMATS))
    interrupter.join(timeout=5)

    assert result.exit_code == 130
    assert "Export cancelled. Files from an earlier export are unchanged." in result.output
    assert result.stdout.strip() == ""
    assert slow_export.files() == slow_export.previous


def test_cli_export_without_ctrl_c_replaces_the_previous_wav(slow_export) -> None:
    result = CliRunner().invoke(app, _export_cmd(slow_export, "[]"))

    assert result.exit_code == 0
    assert "test_episode.wav" in result.stdout
    assert slow_export.files()["test_episode.wav"] != b"OLD-WAV"
    assert slow_export.files()["test_episode.mp3"] == b"OLD-MP3"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_mcp_cancel_mid_encode_stops_the_export_and_keeps_the_previous_one(
    slow_export, mode
) -> None:
    args = {"project_path": str(slow_export.project)}
    async with Client(mcp_server.mcp, mode=mode) as client:
        async with anyio.create_task_group() as tg:

            async def call() -> None:
                await client.call_tool("export_audio_tool", args)

            tg.start_soon(call)
            while not any(
                p.name.endswith(".partial.mp3") for p in slow_export.export_dir.iterdir()
            ):
                await anyio.sleep(0.02)
            tg.cancel_scope.cancel()

        with anyio.fail_after(15):
            while any(".partial" in p.name for p in slow_export.export_dir.iterdir()):
                await anyio.sleep(0.05)

    assert slow_export.files() == slow_export.previous


def test_export_audio_tool_raises_cancelled_before_touching_the_previous_export(
    slow_export,
) -> None:
    with (
        render_cancel_scope(lambda: True),
        pytest.raises(CancelledProgress, match="Export cancelled"),
    ):
        mcp_server.export_audio_tool(str(slow_export.project), formats=MP3_FORMAT_OBJECTS)

    assert slow_export.files() == slow_export.previous


class _FakeServer:
    def __init__(self, tool):
        self._tool = tool

    async def call_tool(self, name, arguments, context=None, *args, **kwargs):
        return await self._tool()


@pytest.mark.asyncio
async def test_request_cancel_keeps_the_tools_own_error_type() -> None:
    from podcast_mcp.mcp.request_cancel import install_request_cancel

    async def failing_tool():
        raise ValueError("bad formats")

    server = _FakeServer(failing_tool)
    install_request_cancel(server)

    with pytest.raises(ValueError, match="bad formats"):
        await server.call_tool("t", {}, object())


@pytest.mark.asyncio
async def test_request_cancel_flag_turns_true_when_the_request_scope_is_cancelled() -> None:
    from podcast_mcp.mcp.request_cancel import install_request_cancel
    from podcast_mcp.util.project_state import current_cancel_check

    seen: list[bool] = []
    started = anyio.Event()

    async def tool():
        check = current_cancel_check()
        seen.append(check())
        started.set()
        with anyio.CancelScope(shield=True):
            await anyio.sleep(0.2)
        seen.append(check())

    server = _FakeServer(tool)
    install_request_cancel(server)
    with anyio.CancelScope() as scope:
        async with anyio.create_task_group() as tg:
            tg.start_soon(server.call_tool, "t", {}, object())
            await started.wait()
            scope.cancel()

    assert seen == [False, True]
    assert current_cancel_check() is None


@pytest.mark.asyncio
async def test_request_cancel_binds_nothing_outside_a_request() -> None:
    from podcast_mcp.mcp.request_cancel import install_request_cancel
    from podcast_mcp.util.project_state import current_cancel_check

    async def tool():
        return current_cancel_check()

    server = _FakeServer(tool)
    install_request_cancel(server)

    assert await server.call_tool("t", {}, None) is None


def test_cli_ctrl_c_after_the_files_are_written_reports_it_came_too_late(
    minimal_project, tmp_path
) -> None:
    from unittest.mock import patch

    from podcast_mcp.services.pipeline import AudioExportResult

    def finish_after_interrupt(self, formats=None, *, cancel_check=None):
        os.kill(os.getpid(), signal.SIGINT)
        assert cancel_check()
        return AudioExportResult([tmp_path / "out.mp3"], None)

    with patch("podcast_mcp.cli.pipeline.PipelineService.export_audio", finish_after_interrupt):
        result = CliRunner().invoke(
            app, ["pipeline", "export-audio", "--project", str(minimal_project)]
        )

    assert result.exit_code == 0
    assert "Cancel came too late. Exported 1 files to export/." in result.output
    assert "out.mp3" in result.stdout


def test_sigint_cancel_leaves_ctrl_c_alone_off_the_main_thread() -> None:
    from podcast_mcp.cli.cancel import sigint_cancel

    checks: list[bool] = []
    before = signal.getsignal(signal.SIGINT)

    def run() -> None:
        with sigint_cancel() as cancel_requested:
            checks.append(cancel_requested())

    worker = threading.Thread(target=run)
    worker.start()
    worker.join(timeout=5)

    assert checks == [False]
    assert signal.getsignal(signal.SIGINT) is before
