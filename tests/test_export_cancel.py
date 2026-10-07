"""Agents and the CLI can cancel a running export; the previous export stays intact (#1164).

Real ffmpeg encodes a 15 min master (mastering is stubbed by the ``slow_export`` fixture).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time

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


# Runs the real CLI in a child process with mastering stubbed: the stub returns the fixture's
# 15 min master after an ffmpeg that takes ``mastering_sec`` of wall time (0 skips it).
_CLI_DRIVER = """
import sys
from pathlib import Path

from podcast_mcp.cli.main import app
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.pipeline import steps
from podcast_mcp.util.process import run

master, mastering_sec, mastering_out, *argv = sys.argv[1:]


def ensure_current_master(project, defaults):
    if float(mastering_sec) > 0:
        run(
            [FFmpegEngine().ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc",
             "-t", mastering_sec, "-af", "arealtime", mastering_out],
            check=True,
        )
    return Path(master)


steps.ensure_current_master = ensure_current_master
app(argv, prog_name="podcast")
"""


class _TerminalCli:
    """The CLI in its own session, so ``ctrl_c`` signals its whole process group the way
    a terminal Ctrl+C does (ffmpeg included, unless it was started in a session of its own)."""

    def __init__(self, slow_export, tmp_path, *, mastering_sec: float = 0) -> None:
        self.mastering_out = tmp_path / "mastering-in-progress.wav"
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-c",
                _CLI_DRIVER,
                str(slow_export.master),
                str(mastering_sec),
                str(self.mastering_out),
                *_export_cmd(slow_export, MP3_FORMATS),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.marker = str(tmp_path)

    def alive(self) -> bool:
        if self.proc.poll() is None:
            return True
        out, err = self.proc.communicate()
        raise AssertionError(f"CLI exited {self.proc.returncode} early: {out} {err}")

    def wait_until_mastering(self) -> None:
        deadline = time.monotonic() + 30
        while not self.mastering_out.exists():
            assert self.alive() and time.monotonic() < deadline, "mastering never started"
            time.sleep(0.02)

    def ctrl_c(self) -> None:
        os.killpg(self.proc.pid, signal.SIGINT)

    def finish(self, timeout: float = 30) -> tuple[int, str, str]:
        out, err = self.proc.communicate(timeout=timeout)
        return self.proc.returncode, out, err

    def ffmpeg_left_running(self) -> list[str]:
        ps = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True, check=True)
        return [line for line in ps.stdout.splitlines() if "ffmpeg" in line and self.marker in line]


def test_terminal_ctrl_c_mid_encode_cancels_the_export_and_keeps_the_previous_one(
    slow_export, tmp_path
) -> None:
    cli = _TerminalCli(slow_export, tmp_path)
    slow_export.wait_until_encoding(alive=cli.alive)
    cli.ctrl_c()
    code, out, err = cli.finish()

    assert code == 130, err
    assert "Export cancelled. Files from an earlier export are unchanged." in err
    assert "Traceback" not in err
    assert out.strip() == ""
    assert slow_export.files() == slow_export.previous
    assert cli.ffmpeg_left_running() == []


def test_terminal_ctrl_c_during_mastering_lets_the_master_finish_then_cancels(
    slow_export, tmp_path
) -> None:
    cli = _TerminalCli(slow_export, tmp_path, mastering_sec=1.5)
    cli.wait_until_mastering()
    cli.ctrl_c()
    code, _out, err = cli.finish()

    assert code == 130, err
    assert "Export cancelled. Files from an earlier export are unchanged." in err
    assert slow_export.files() == slow_export.previous


def test_second_terminal_ctrl_c_quits_at_once_and_kills_ffmpeg(slow_export, tmp_path) -> None:
    cli = _TerminalCli(slow_export, tmp_path, mastering_sec=60)
    cli.wait_until_mastering()
    cli.ctrl_c()
    time.sleep(0.3)
    assert cli.alive(), "the first Ctrl+C must not stop an uninterruptible master"
    started = time.monotonic()
    cli.ctrl_c()
    code, out, err = cli.finish(timeout=15)

    assert time.monotonic() - started < 5
    assert code == 130, err
    assert "Traceback" not in err
    assert out.strip() == ""
    assert cli.ffmpeg_left_running() == []
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


def test_an_encode_stopped_by_the_same_interrupt_is_a_cancel_not_a_failure(tmp_path) -> None:
    from podcast_mcp.engines.ffmpeg import _run_cancellable

    with pytest.raises(CancelledProgress, match="cancelled"):
        _run_cancellable([sys.executable, "-c", "raise SystemExit(255)"], lambda: True)


def test_a_failed_encode_without_a_cancel_still_fails() -> None:
    from podcast_mcp.engines.ffmpeg import _run_cancellable
    from podcast_mcp.util.process import CalledProcessError

    with pytest.raises(CalledProcessError):
        _run_cancellable([sys.executable, "-c", "raise SystemExit(255)"], lambda: False)


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_second_ctrl_c_kills_detached_children_then_reaches_the_previous_handler() -> None:
    from podcast_mcp.cli.cancel import sigint_cancel
    from podcast_mcp.util.process import popen

    passed_on: list[int] = []
    before = signal.signal(signal.SIGINT, lambda signum, _frame: passed_on.append(signum))
    try:
        with sigint_cancel() as cancel_requested:
            child = popen([sys.executable, "-c", "import time; time.sleep(30)"])
            os.kill(os.getpid(), signal.SIGINT)
            assert cancel_requested() and child.poll() is None and passed_on == []
            os.kill(os.getpid(), signal.SIGINT)
            assert child.wait(timeout=5) != 0
            assert passed_on == [signal.SIGINT]
    finally:
        signal.signal(signal.SIGINT, before)


def test_mcp_bounce_render_and_pipeline_run_stop_on_the_requests_cancel(minimal_project) -> None:
    from unittest.mock import patch

    from podcast_mcp.services.media import BounceService

    project = str(minimal_project)

    def cancelled() -> bool:
        return True

    with render_cancel_scope(cancelled):
        with patch.object(BounceService, "bounce", return_value=[]) as bounce:
            mcp_server.bounce_audio_tool(project)
        assert bounce.call_args.kwargs["cancel_check"] is cancelled
        with pytest.raises(CancelledProgress, match="Pipeline cancelled"):
            mcp_server.render_preview(project)
        with (
            patch("podcast_mcp.gui.jobs.studio_job_manager", return_value=None),
            pytest.raises(CancelledProgress, match="Pipeline cancelled"),
        ):
            mcp_server.pipeline_run(project, only_step="mix_with_music", use_working_set=False)
