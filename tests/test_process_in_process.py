"""The in-process spawn path of ``util/process.py``: a fake backend stands in for a Kit adapter."""

from __future__ import annotations

import errno
import os
import resource
import shutil
import subprocess
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.source_proxy_audio import _is_in_process_tool
from podcast_mcp.util import process
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.host_platform import IOS, MACOS
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE, Streams
from process_child_contract import CASES, run_case

ROW = replace(IOS, media_tools="in_process")
MIB = 1 << 20


class FakeBackend:
    """Records every call and plays the behaviour named by ``argv[1]`` (default: succeed)."""

    def __init__(self, **params: Any) -> None:
        self.calls: list[list[str]] = []
        self.cancels: list[threading.Event] = []
        self.params = params

    def run(self, argv: list[str], streams: Streams, cancel: threading.Event) -> int:
        self.calls.append(argv)
        self.cancels.append(cancel)
        p = self.params
        behaviour = argv[1] if len(argv) > 1 else "ok"
        if behaviour == "echo":
            while data := os.read(streams.stdin.fileno(), 65536):
                streams.stdout.write(data)
                streams.stdout.flush()
            return 0
        if behaviour == "lines":
            for i in range(p["n"]):
                streams.stdout.write(b"line %d\n" % i)
            streams.stdout.flush()
            return 0
        if behaviour == "stderr_exit":
            streams.stdout.write(p["out"])
            streams.stdout.flush()
            streams.stderr.write(p["err"])
            streams.stderr.flush()
            return p["code"]
        if behaviour == "wait_stdin":
            streams.stdin.read()
            return p["code"]
        if behaviour == "block":
            cancel.wait()
            return -9
        if behaviour == "cancel_zero":
            cancel.wait()
            return 0
        if behaviour == "pcm_short":
            streams.stdout.write(b"\0" * 400)
            streams.stdout.flush()
            cancel.wait()
            return 0
        if behaviour == "ignore_kill":
            threading.Event().wait(30)
            return 0
        if behaviour == "stuck_read":
            streams.stdin.read()
            return 0
        if behaviour == "stuck_write":
            streams.stdout.write(b"x" * (8 * MIB))
            return 0
        if behaviour == "none":
            return None
        if behaviour == "flood":
            chunk = b"x" * (p["err_bytes"] // p["lines"])
            for i in range(p["lines"]):
                streams.stdout.write(b"frame=%d\n" % i)
                streams.stdout.flush()
                streams.stderr.write(chunk)
                streams.stderr.flush()
            return 0
        if behaviour == "boom":
            raise RuntimeError("backend bug")
        for stream, text in ((streams.stdout, b"out"), (streams.stderr, b"err")):
            if stream is not None:
                stream.write(text)
                stream.flush()
        return p.get("code", 0)


@pytest.fixture
def backend(host, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    monkeypatch.setattr(shutil, "which", lambda *_a, **_k: pytest.fail("which"))
    host(ROW)
    fake = FakeBackend()
    with process.using_in_process_backend(fake):
        yield fake


def _contract_child(behaviour: str, *, cwd: Any = None, env: Any = None, **params: Any):
    return process.InProcessChild(
        [IN_PROCESS_FFMPEG, behaviour],
        FakeBackend(**params),
        stdin=process.PIPE,
        stdout=process.PIPE,
        stderr=process.PIPE,
    )


@pytest.mark.parametrize("name", [n for n in CASES if n != "argv_cwd_env"])
def test_the_in_process_child_meets_the_child_contract(name: str, tmp_path: Path) -> None:
    run_case(name, _contract_child, tmp_path)


def test_run_captures_bytes_and_text_and_feeds_input(backend: FakeBackend) -> None:
    done = process.run([IN_PROCESS_FFMPEG, "-y"], capture_output=True)
    assert (done.returncode, done.stdout, done.stderr) == (0, b"out", b"err")
    assert backend.calls == [[IN_PROCESS_FFMPEG, "-y"]]
    done = process.run([IN_PROCESS_FFPROBE], capture_output=True, text=True)
    assert (done.stdout, done.stderr) == ("out", "err")
    echoed = process.run([IN_PROCESS_FFMPEG, "echo"], input=b"abc", stdout=process.PIPE)
    assert echoed.stdout == b"abc"


def test_check_raises_with_the_captured_stderr_and_timeout_kills(backend: FakeBackend) -> None:
    backend.params = {"code": 3}
    with pytest.raises(process.CalledProcessError) as raised:
        process.run([IN_PROCESS_FFMPEG], check=True, capture_output=True)
    assert (raised.value.returncode, raised.value.stderr) == (3, b"err")
    assert process.run([IN_PROCESS_FFMPEG], capture_output=True).returncode == 3
    with pytest.raises(process.TimeoutExpired):
        process.run([IN_PROCESS_FFMPEG, "block"], capture_output=True, timeout=0.2)
    assert backend.cancels[-1].is_set()


def test_stderr_goes_to_a_file_handle_and_devnull_gives_the_backend_none(
    backend: FakeBackend, tmp_path: Path
) -> None:
    with (tmp_path / "errors").open("wb") as errors:
        process.run([IN_PROCESS_FFMPEG], stdout=process.DEVNULL, stderr=errors)
    assert (tmp_path / "errors").read_bytes() == b"err"


def test_popen_streams_stdout_lines_and_reads_chunks(backend: FakeBackend) -> None:
    backend.params = {"n": 3}
    with process.popen([IN_PROCESS_FFPROBE, "lines"], stdout=process.PIPE) as child:
        assert list(child.stdout) == [b"line 0\n", b"line 1\n", b"line 2\n"]
        assert child.wait() == 0
    assert child.pid is None


def test_popen_stdin_is_written_then_closed(backend: FakeBackend) -> None:
    backend.params = {"code": 5}
    child = process.popen([IN_PROCESS_FFMPEG, "wait_stdin"], stdin=process.PIPE)
    child.stdin.write(b"pcm")
    child.stdin.close()
    assert child.wait(5) == 5


def test_kill_is_cooperative_and_a_backend_that_ignores_it_is_abandoned(
    backend: FakeBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.1)
    child = process.popen([IN_PROCESS_FFMPEG, "ignore_kill"], stdout=process.PIPE)
    child.kill()
    child.kill()
    assert child.wait(5) == -9
    assert child.stdout.read() == b""


@pytest.mark.parametrize("behaviour", ["stuck_read", "stuck_write"])
def test_a_backend_stuck_in_a_pipe_call_is_abandoned_and_the_reader_sees_eof(
    backend: FakeBackend, monkeypatch: pytest.MonkeyPatch, behaviour: str
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.2)
    child = process.popen([IN_PROCESS_FFMPEG, behaviour], stdin=process.PIPE, stdout=process.PIPE)
    threading.Event().wait(0.3)
    started = time.monotonic()
    child.kill()
    waited: list[int] = []
    waiter = threading.Thread(target=lambda: waited.append(child.wait()), daemon=True)
    waiter.start()
    waiter.join(0.2 + 2)
    assert waited == [-9], "wait() hung on a backend stuck in a pipe call"
    assert time.monotonic() - started < 0.2 + 2
    drained: list[bytes] = []
    reader = threading.Thread(target=lambda: drained.append(child.stdout.read()), daemon=True)
    reader.start()
    reader.join(5)
    assert drained, "the reader never saw EOF"
    child.stdin.close()


def test_an_abandoned_child_gives_eof_with_no_descriptor_left_to_open(
    backend: FakeBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.1)
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    outcome: dict[str, Any] = {}

    def scenario() -> None:
        with process.popen(
            [IN_PROCESS_FFMPEG, "ignore_kill"], stdin=process.PIPE, stdout=process.PIPE
        ) as child:
            probe = os.open(os.devnull, os.O_RDONLY)
            os.close(probe)
            resource.setrlimit(resource.RLIMIT_NOFILE, (probe, hard))
            try:
                with pytest.raises(OSError) as exhausted:
                    os.open(os.devnull, os.O_RDONLY)
                assert exhausted.value.errno == errno.EMFILE
                child.kill()
                outcome["code"] = child.wait()
            finally:
                resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
            outcome["eof"] = child.stdout.read()

    runner = threading.Thread(target=scenario, daemon=True)
    runner.start()
    runner.join(10)
    assert not runner.is_alive(), "the with-exit hung after the kill"
    assert outcome == {"code": -9, "eof": b""}


def test_a_backend_returning_a_non_int_fails_with_code_one(backend: FakeBackend) -> None:
    done = process.run([IN_PROCESS_FFMPEG, "none"], capture_output=True)
    assert done.returncode == 1
    with pytest.raises(subprocess.CalledProcessError):
        process.run([IN_PROCESS_FFMPEG, "none"], capture_output=True, check=True)


def test_a_kill_before_the_backend_finishes_reports_sigkill_whatever_it_returns(
    backend: FakeBackend,
) -> None:
    child = process.popen([IN_PROCESS_FFMPEG, "cancel_zero"], stdout=process.PIPE)
    child.kill()
    assert child.wait(5) == -9
    assert child.poll() == -9


def test_a_kill_after_completion_keeps_the_real_return_code(backend: FakeBackend) -> None:
    backend.params = {"code": 3}
    child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
    assert child.wait(5) == 3
    child.kill()
    assert child.wait() == 3


def test_the_pcm_watchdog_raises_on_a_killed_in_process_child(backend: FakeBackend) -> None:
    reads = FFmpegEngine._read_pcm_f32(
        [IN_PROCESS_FFMPEG, "pcm_short"], 1, chunk_frames=1000, timeout_sec=0.3, max_frames=1000
    )
    with pytest.raises(RuntimeError, match=r"exit -9.*watchdog"):
        list(reads)


def test_a_backend_that_raises_ends_the_child_with_a_failure(backend: FakeBackend) -> None:
    done = process.run([IN_PROCESS_FFMPEG, "boom"], capture_output=True)
    assert done.returncode == 1


def test_silence_without_patching_run_reaches_the_backend_and_never_popen(
    backend: FakeBackend, tmp_path: Path
) -> None:
    FFmpegEngine().silence(tmp_path / "s.wav", 1.0)
    (argv,) = backend.calls
    assert argv[0] == IN_PROCESS_FFMPEG
    assert argv[-1] == str(tmp_path / "s.wav")


def test_only_the_exact_sentinel_is_dispatched(backend: FakeBackend) -> None:
    for argv in (
        [IN_PROCESS_FFMPEG + "x"],
        ["./" + IN_PROCESS_FFMPEG],
        [" " + IN_PROCESS_FFMPEG],
        ["/bin/sh", "-c", "true"],
    ):
        with pytest.raises(process.SpawnUnavailableError):
            process.run(argv)
    assert backend.calls == []


def test_the_in_process_branch_skips_niceness(backend: FakeBackend) -> None:
    with process.low_priority(5):
        assert process.run([IN_PROCESS_FFMPEG], capture_output=True).returncode == 0


def test_a_second_backend_is_refused(backend: FakeBackend) -> None:
    with pytest.raises(RuntimeError), process.using_in_process_backend(FakeBackend()):
        pass


def test_a_sentinel_on_a_desktop_row_never_reaches_popen(
    host, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planted = tmp_path / IN_PROCESS_FFMPEG
    planted.write_text("#!/bin/sh\ntouch pwned\n")
    planted.chmod(0o755)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    host(MACOS)
    for ready in (False, True):
        with pytest.raises(process.SpawnUnavailableError) as refused:
            if ready:
                with process.using_in_process_backend(FakeBackend()):
                    process.run([IN_PROCESS_FFMPEG])
            else:
                process.popen([IN_PROCESS_FFPROBE])
        assert refused.value.errno == errno.ENOSYS
    assert not (tmp_path / "pwned").exists()


def test_no_backend_or_a_foreign_argv_fails_before_any_pipe(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    monkeypatch.setattr(os, "pipe", lambda: pytest.fail("pipe"))
    host(ROW)
    for call in (process.run, process.popen):
        with pytest.raises(process.SpawnUnavailableError):
            call([IN_PROCESS_FFMPEG], stdout=process.PIPE)
    with process.using_in_process_backend(FakeBackend()):
        with pytest.raises(process.SpawnUnavailableError):
            process.run(["/bin/sh", "-c", "true"])


def test_a_sentinel_free_argv_reaches_popen_unchanged_with_a_backend_installed(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[tuple[Any, dict[str, Any]]] = []

    class Recorder:
        def __init__(self, cmd: Any, **kwargs: Any) -> None:
            seen.append((cmd, kwargs))

    monkeypatch.setattr(subprocess, "Popen", Recorder)
    host(MACOS)
    with process.using_in_process_backend(FakeBackend()):
        process.popen(["tool", "a"], stdout=process.PIPE)
    assert seen == [
        (
            ["tool", "a"],
            {
                "stdin": None,
                "stdout": process.PIPE,
                "stderr": None,
                "text": None,
                "cwd": None,
                "env": None,
                "start_new_session": False,
                "shell": False,
            },
        )
    ]


def test_the_proxy_identity_recognises_only_the_sentinels() -> None:
    assert _is_in_process_tool(IN_PROCESS_FFMPEG)
    assert _is_in_process_tool(IN_PROCESS_FFPROBE)
    assert not _is_in_process_tool("/usr/bin/ffmpeg")
    assert not _is_in_process_tool(IN_PROCESS_FFMPEG + "/")


def test_the_proxy_identity_binds_the_sentinels_and_never_resolves_them(
    backend: FakeBackend, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.source_proxy_audio import SourceProxyInputs
    from test_source_proxy_audio import _project

    project, _track, clip, _plan = _project(tmp_path, monkeypatch)
    captured = SourceProxyInputs.capture_occurrence(
        project, clip.id, FFmpegEngine(), defaults=load_defaults()
    )
    assert captured.identity_payload["binaries"] == [IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE]


def test_the_proxy_identity_of_a_desktop_pair_is_content_hashed(
    backend: FakeBackend, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.source_proxy_audio import SourceProxyInputs
    from test_source_proxy_audio import _project

    monkeypatch.undo()
    tools = []
    for name in ("ffmpeg", "ffprobe"):
        tool = tmp_path / name
        tool.write_bytes(name.encode())
        tools.append(str(tool))
    engine = FFmpegEngine()
    engine.ffmpeg, engine.ffprobe = tools
    project, _track, clip, _plan = _project(tmp_path, monkeypatch)
    captured = SourceProxyInputs.capture_occurrence(
        project, clip.id, engine, defaults=load_defaults()
    )
    binaries = captured.identity_payload["binaries"]
    assert binaries == [sha256_file(Path(tool)) for tool in tools]
    assert not {IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE} & set(binaries)
