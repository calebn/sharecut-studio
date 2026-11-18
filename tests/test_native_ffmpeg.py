"""NativeFFmpegBackend against a fake ``sc_ffmpeg_*`` library built from ctypes callbacks."""

from __future__ import annotations

import ctypes
import errno
import importlib.util
import inspect
import io
import os
import subprocess
import tempfile
import threading
import time
from dataclasses import replace
from typing import Any

import pytest

from podcast_mcp.util import binaries, host_platform, native_ffmpeg, process
from podcast_mcp.util.host_platform import IOS, MACOS
from podcast_mcp.util.native_ffmpeg import NativeFFmpegBackend, NativeFFmpegUnavailable
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE, Streams

ROW = replace(IOS, media_tools="in_process")
BOUND_SEC = (
    3.0  # every blocking wait in the fakes is bounded, so a broken forwarder fails by assertion
)
START = ctypes.CFUNCTYPE(
    ctypes.c_int64,
    ctypes.c_int,
    ctypes.POINTER(ctypes.c_char_p),
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
)


class Session:
    def __init__(self) -> None:
        self.thread: threading.Thread | None = None
        self.dups: list[int] = []
        self.closed = False
        self.close_lock = threading.Lock()
        self.cancelled = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.argv: list[bytes] = []


class FakeNative:
    """The four ``sc_ffmpeg_*`` symbols as ctypes callbacks; start dups fds like native does.

    State is per session id in ``sessions``; the plain events are set when any session reaches that state.
    """

    def __init__(
        self,
        *,
        code: int = 0,
        version: int = 1,
        start_result: int | None = None,
        wait_result: int | None = None,
        honour_cancel: bool = True,
        out: bytes = b"",
        err: bytes = b"",
        start_delay: float = 0.0,
    ) -> None:
        self.code = code
        self.start_result = start_result
        self.wait_result = wait_result
        self.honour_cancel = honour_cancel
        self.out = out
        self.err = err
        self.start_delay = start_delay
        self.argvs: list[list[bytes]] = []
        self.fds: list[tuple[int, int, int]] = []
        self.stdin_data = b""
        self.sessions: dict[int, Session] = {}
        self.cancelled = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.waited: list[int] = []
        self.start_durations: list[float] = []
        self.started = threading.Semaphore(0)
        self._next = 1
        self.sc_ffmpeg_abi_version = ctypes.CFUNCTYPE(ctypes.c_int)(lambda: version)
        self.sc_ffmpeg_start = START(self._start)
        self.sc_ffmpeg_wait = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64)(self._wait)
        self.sc_ffmpeg_cancel = ctypes.CFUNCTYPE(None, ctypes.c_int64)(self._cancel)

    def _start(self, argc: int, argv: Any, in_fd: int, out_fd: int, err_fd: int) -> int:
        began = time.monotonic()
        if self.start_result is not None:
            return self.start_result
        assert argv[argc] is None
        session = Session()
        session.argv = [argv[i] for i in range(argc)]
        self.argvs.append(session.argv)
        self.fds.append((in_fd, out_fd, err_fd))
        session.dups = [os.dup(fd) if fd >= 0 else -1 for fd in (in_fd, out_fd, err_fd)]
        session.thread = threading.Thread(
            target=self._ffmpeg, args=(session, *session.dups), daemon=True
        )
        session.thread.start()
        session_id = self._next
        self._next += 1
        self.sessions[session_id] = session
        self.start_durations.append(time.monotonic() - began)
        self.started.release()
        return session_id

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
            if self.start_delay:
                threading.Event().wait(self.start_delay)
            if in_fd >= 0:
                chunks = []
                while chunk := os.read(in_fd, 65536):
                    chunks.append(chunk)
                self.stdin_data = b"".join(chunks)
            if out_fd >= 0 and self.out:
                os.write(out_fd, self.out)
            if err_fd >= 0 and self.err:
                os.write(err_fd, self.err)
        finally:
            self._close(session, in_fd, out_fd, err_fd)

    def _close(self, session: Session, *fds: int) -> None:
        with session.close_lock:
            if not session.closed:
                session.closed = True
                for fd in fds:
                    if fd >= 0:
                        os.close(fd)
        session.finished.set()
        self.finished.set()

    def _wait(self, session_id: int) -> int:
        session = self.sessions[session_id]
        assert session.thread is not None
        self.waited.append(session_id)
        session.thread.join(BOUND_SEC)
        return self.code if self.wait_result is None else self.wait_result

    def _cancel(self, session_id: int) -> None:
        """Conformant: stop and close the session's dups at once. Otherwise ignore the call."""
        session = self.sessions.get(session_id)
        if session is not None and self.honour_cancel:
            session.cancelled.set()
            self.cancelled.set()
            self._close(session, *session.dups)


class Blocking(FakeNative):
    """A session that runs until cancelled (or released)."""

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
            if self.honour_cancel:
                session.cancelled.wait(BOUND_SEC)
            else:
                self.release.wait(BOUND_SEC)
        finally:
            self._close(session, in_fd, out_fd, err_fd)

    def _wait(self, session_id: int) -> int:
        session = self.sessions[session_id]
        assert session.thread is not None
        self.waited.append(session_id)
        session.thread.join(BOUND_SEC)
        return -9 if session.cancelled.is_set() and self.code == 0 else self.code


class SlowWait(Blocking):
    """Cancel closes the dups at once, but the session and ``wait`` end only once released."""

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
            self.release.wait(BOUND_SEC)
        finally:
            self._close(session, in_fd, out_fd, err_fd)

    def _wait(self, session_id: int) -> int:
        self.release.wait(BOUND_SEC)
        return super()._wait(session_id)


@pytest.fixture
def host():
    with host_platform.using(ROW):
        yield


def run_child(fake: FakeNative, argv: list[str], **kw: Any) -> process.CompletedProcess[Any]:
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        return process.run(argv, **kw)


def test_importing_native_ffmpeg_loads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("loaded at import")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    monkeypatch.setattr(ctypes, "PyDLL", boom)
    spec = importlib.util.spec_from_file_location("native_ffmpeg_fresh", native_ffmpeg.__file__)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(importlib.util.module_from_spec(spec))


def test_desktop_probe_never_touches_ctypes(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("ctypes touched on desktop")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert native_ffmpeg.is_available() is False
        assert binaries._in_process_linked() is False
    with host_platform.using(replace(MACOS, media_tools="unavailable")):
        assert native_ffmpeg.is_available() is False


def test_sentinel_argv_on_desktop_still_raises_without_popen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_popen(*a: Any, **k: Any) -> None:
        raise AssertionError("Popen called")

    monkeypatch.setattr(subprocess, "Popen", no_popen)
    with host_platform.using(replace(MACOS, media_tools="executables")):
        with pytest.raises(process.SpawnUnavailableError):
            process.run([IN_PROCESS_FFMPEG, "-version"], capture_output=True)


def test_probe_on_an_in_process_host_without_the_symbols_is_false(host: None) -> None:
    assert native_ffmpeg.is_available() is False
    assert binaries._in_process_linked() is False


def test_probe_finds_the_symbols_through_the_process_handle(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeNative()
    monkeypatch.setattr(ctypes, "CDLL", lambda name: fake)
    assert native_ffmpeg.is_available() is True
    assert binaries._in_process_linked() is True


def test_abi_version_two_is_not_available(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeNative(version=2))
    assert native_ffmpeg.is_available() is False
    with pytest.raises(NativeFFmpegUnavailable):
        native_ffmpeg.load_library()


def test_a_library_missing_one_symbol_is_unavailable() -> None:
    fake = FakeNative()
    del fake.sc_ffmpeg_cancel
    with pytest.raises(NativeFFmpegUnavailable):
        NativeFFmpegBackend(fake)


def test_exit_codes_0_and_1_pass_through(host: None) -> None:
    assert run_child(FakeNative(code=0), [IN_PROCESS_FFMPEG, "-i", "x"]).returncode == 0
    assert run_child(FakeNative(code=1), [IN_PROCESS_FFMPEG]).returncode == 1
    assert run_child(FakeNative(code=255), [IN_PROCESS_FFMPEG]).returncode == 255


def test_argv_zero_is_the_tool_name_and_the_rest_is_encoded(host: None) -> None:
    fake = FakeNative()
    run_child(fake, [IN_PROCESS_FFPROBE, "-v", "quiet", "café.wav"], capture_output=True)
    run_child(fake, [IN_PROCESS_FFMPEG, "-y"], capture_output=True)
    assert fake.argvs == [
        [b"ffprobe", b"-v", b"quiet", "café.wav".encode()],
        [b"ffmpeg", b"-y"],
    ]


def test_an_unknown_tool_is_exit_one_and_starts_nothing() -> None:
    fake = FakeNative()
    with tempfile.TemporaryFile() as err:
        backend = NativeFFmpegBackend(fake)
        assert backend.run(["/bin/true"], Streams(None, None, err), threading.Event()) == 1
        assert fake.argvs == []
        err.seek(0)
        assert len(err.read().splitlines()) == 1


def test_a_nul_in_argv_raises_before_start() -> None:
    fake = FakeNative()
    with pytest.raises(ValueError):
        NativeFFmpegBackend(fake).run(
            [IN_PROCESS_FFMPEG, "a\0b"], Streams(None, None, None), threading.Event()
        )
    assert fake.argvs == []


def test_a_stream_without_a_fileno_raises_before_start() -> None:
    fake = FakeNative()
    with pytest.raises(OSError):
        NativeFFmpegBackend(fake).run(
            [IN_PROCESS_FFMPEG], Streams(None, io.BytesIO(), None), threading.Event()
        )
    assert fake.argvs == []


def test_wait_negative_errno_is_exit_one_never_success(host: None) -> None:
    done = run_child(FakeNative(wait_result=-errno.ESRCH), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert len(done.stderr.splitlines()) == 1


@pytest.mark.parametrize("bad", [-3, 256, 1000])
def test_a_wait_outside_0_to_255_is_exit_one(host: None, bad: int) -> None:
    done = run_child(FakeNative(wait_result=bad), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert done.stderr


@pytest.mark.parametrize("result", [0, -errno.ENOMEM, -errno.EMFILE])
def test_start_zero_or_negative_is_exit_one(host: None, result: int) -> None:
    fake = FakeNative(start_result=result)
    done = run_child(fake, [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert len(done.stderr.splitlines()) == 1


def test_stdout_reaches_eof_when_the_session_ends(host: None) -> None:
    fake = FakeNative(out=b"hello", err=b"warn")
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        child = process.popen(
            [IN_PROCESS_FFMPEG, "-"],
            stdin=process.PIPE,
            stdout=process.PIPE,
            stderr=process.PIPE,
        )
        out, err = child.communicate(b"input", timeout=5)
    assert (out, err, child.returncode) == (b"hello", b"warn", 0)
    assert fake.stdin_data == b"input"


def open_fd_count() -> int:
    return len(os.listdir("/dev/fd"))


def test_no_fd_leak_over_20_runs(host: None) -> None:
    fake = FakeNative(out=b"x", err=b"y")
    run_child(fake, [IN_PROCESS_FFMPEG], input=b"", capture_output=True)
    before = open_fd_count()
    for _ in range(20):
        done = run_child(fake, [IN_PROCESS_FFMPEG], input=b"a", capture_output=True)
        assert done.stdout == b"x"
    assert open_fd_count() == before


def test_caller_fds_stay_open_after_run() -> None:
    fake = FakeNative(out=b"data")
    with (
        tempfile.TemporaryFile() as src,
        tempfile.TemporaryFile() as out,
        tempfile.TemporaryFile() as err,
    ):
        src.write(b"in")
        src.seek(0)
        code = NativeFFmpegBackend(fake).run(
            [IN_PROCESS_FFMPEG], Streams(src, out, err), threading.Event()
        )
        assert code == 0
        for stream in (src, out, err):
            os.fstat(stream.fileno())
        assert fake.fds[0] == (src.fileno(), out.fileno(), err.fileno())
        assert fake.stdin_data == b"in"


def test_tempfile_stderr_reads_back_after_seek_0() -> None:
    fake = FakeNative(err=b"diagnostic\n")
    with tempfile.TemporaryFile() as err:
        NativeFFmpegBackend(fake).run(
            [IN_PROCESS_FFMPEG], Streams(None, None, err), threading.Event()
        )
        assert err.read() == b""
        err.seek(0)
        assert err.read() == b"diagnostic\n"


def test_cancel_unblocks_wait_within_grace(host: None) -> None:
    fake = Blocking()
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
        child.kill()
        assert child.wait(2) == -9
    assert fake.finished.wait(2)


def test_cancel_set_before_start_is_seen_by_the_watcher() -> None:
    fake = Blocking()
    cancel = threading.Event()
    cancel.set()
    NativeFFmpegBackend(fake).run([IN_PROCESS_FFMPEG], Streams(None, None, None), cancel)
    assert fake.cancelled.is_set()


def test_a_backend_that_ignores_cancel_is_abandoned_after_the_grace(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.2)
    fake = Blocking(honour_cancel=False)
    try:
        with process.using_in_process_backend(NativeFFmpegBackend(fake)):
            child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
            child.kill()
            assert child.wait(2) == -9
    finally:
        fake.release.set()
        assert fake.finished.wait(2)


def test_a_reader_sees_eof_after_kill_and_abandon_with_a_conformant_native(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.2)
    fake = SlowWait()
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
        child.kill()
        assert child.wait(2) == -9
        assert fake.cancelled.is_set()
        result: list[bytes] = []
        reader = threading.Thread(target=lambda: result.append(child.stdout.read()), daemon=True)
        reader.start()
        reader.join(2)
        assert not reader.is_alive()
        assert result == [b""]
    fake.release.set()


def test_a_native_that_ignores_cancel_never_hangs_wait_though_eof_is_delayed(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "KILL_GRACE_SEC", 0.2)
    fake = Blocking(honour_cancel=False)
    try:
        with process.using_in_process_backend(NativeFFmpegBackend(fake)):
            child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
            child.kill()
            assert child.wait(2) == -9
            assert not fake.finished.is_set()
            result: list[bytes] = []
            reader = threading.Thread(
                target=lambda: result.append(child.stdout.read()), daemon=True
            )
            reader.start()
            reader.join(0.5)
            assert reader.is_alive()  # the native still holds its dups: no EOF yet
            fake.release.set()
            reader.join(2)
            assert result == [b""]
    finally:
        fake.release.set()
        assert fake.finished.wait(2)


def test_run_survives_a_thread_start_failure_and_reaps_the_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = Blocking()
    real_start = threading.Thread.start

    def start(self: threading.Thread) -> None:
        if self.name == "native-ffmpeg-cancel":
            raise RuntimeError("can't start new thread")
        real_start(self)

    monkeypatch.setattr(threading.Thread, "start", start)
    with pytest.raises(RuntimeError):
        NativeFFmpegBackend(fake).run(
            [IN_PROCESS_FFMPEG], Streams(None, None, None), threading.Event()
        )
    assert fake.cancelled.is_set()
    assert fake.finished.is_set()
    assert fake.waited == [1]


@pytest.mark.parametrize("result", [-(2**40), -(2**63), -(2**31) - 1])
def test_an_out_of_range_start_result_still_writes_the_stderr_line(host: None, result: int) -> None:
    done = run_child(FakeNative(start_result=result), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert len(done.stderr.splitlines()) == 1


@pytest.mark.parametrize("bad", [-(2**31) - 5])
def test_an_out_of_range_wait_result_cannot_be_returned(host: None, bad: int) -> None:
    done = run_child(FakeNative(wait_result=bad), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1


def test_the_stream_is_flushed_before_start() -> None:
    class Spy(io.BufferedRandom):
        flushed = 0

        def flush(self) -> None:
            Spy.flushed += 1
            super().flush()

    fake = FakeNative()
    with tempfile.TemporaryFile() as raw:
        spy = Spy(io.FileIO(os.dup(raw.fileno()), "r+"))
        try:
            NativeFFmpegBackend(fake).run(
                [IN_PROCESS_FFMPEG], Streams(None, spy, None), threading.Event()
            )
            assert Spy.flushed >= 1  # before close(), which flushes anyway
        finally:
            spy.close()


def test_a_lookalike_sentinel_is_not_a_native_tool() -> None:
    fake = FakeNative()
    for name in (IN_PROCESS_FFMPEG + "x", "x" + IN_PROCESS_FFMPEG, IN_PROCESS_FFMPEG.upper()):
        code = NativeFFmpegBackend(fake).run([name], Streams(None, None, None), threading.Event())
        assert code == 1
    assert fake.argvs == []


def test_the_watcher_thread_is_joined_before_run_returns() -> None:
    fake = FakeNative()
    NativeFFmpegBackend(fake).run([IN_PROCESS_FFMPEG], Streams(None, None, None), threading.Event())
    assert not [t for t in threading.enumerate() if t.name == "native-ffmpeg-cancel"]


def test_the_module_never_references_subprocess() -> None:
    source = inspect.getsource(native_ffmpeg)
    assert "subprocess" not in source and "Popen" not in source and "PyDLL(" not in source


def test_the_cancel_poll_constant_is_pinned() -> None:
    assert native_ffmpeg._CANCEL_POLL_SEC == 0.05


def test_cancel_reaches_native_within_a_few_polls() -> None:
    fake = Blocking()
    cancel = threading.Event()
    runner = threading.Thread(
        target=NativeFFmpegBackend(fake).run,
        args=([IN_PROCESS_FFMPEG], Streams(None, None, None), cancel),
        daemon=True,
    )
    runner.start()
    assert fake.started.acquire(timeout=BOUND_SEC)
    began = time.monotonic()
    cancel.set()
    assert fake.cancelled.wait(BOUND_SEC)
    assert time.monotonic() - began < 10 * native_ffmpeg._CANCEL_POLL_SEC
    runner.join(BOUND_SEC)
    assert not runner.is_alive()


def test_start_never_waits_for_the_tool() -> None:
    fake = FakeNative(start_delay=0.4)
    began = time.monotonic()
    code = NativeFFmpegBackend(fake).run(
        [IN_PROCESS_FFMPEG], Streams(None, None, None), threading.Event()
    )
    assert code == 0
    assert time.monotonic() - began >= 0.4
    assert fake.start_durations and fake.start_durations[0] < 0.25


def test_a_dlopen_failure_is_unavailable_not_an_error(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(name: Any) -> None:
        raise OSError(errno.ENOENT, "dlopen failed")

    monkeypatch.setattr(ctypes, "CDLL", refuse)
    assert native_ffmpeg.is_available() is False
    assert binaries._in_process_linked() is False


def test_a_missing_symbol_is_missing_not_installed(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline import bootstrap, config

    monkeypatch.setenv("PODCAST_MCP_CACHE", tempfile.mkdtemp())
    for variable in ("PODCAST_MCP_FFMPEG", "PODCAST_MCP_FFPROBE", "PODCAST_MCP_FFMPEG_BUNDLE"):
        monkeypatch.delenv(variable, raising=False)
    broken = FakeNative()
    del broken.sc_ffmpeg_wait
    monkeypatch.setattr(ctypes, "CDLL", lambda name: broken)
    assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "missing"
    assert config.component_status()["ffmpeg"]["state"] == "missing"
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeNative())
    assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "installed"
    assert config.component_status()["ffmpeg"]["state"] == "installed"


def test_cancel_hits_only_its_own_overlapping_session() -> None:
    fake = Blocking()
    backend = NativeFFmpegBackend(fake)
    cancels = {"a": threading.Event(), "b": threading.Event()}
    codes: dict[str, int] = {}

    def go(name: str) -> None:
        codes[name] = backend.run(
            [IN_PROCESS_FFMPEG, name], Streams(None, None, None), cancels[name]
        )

    threads = [threading.Thread(target=go, args=(name,), daemon=True) for name in cancels]
    for thread in threads:
        thread.start()
    assert fake.started.acquire(timeout=BOUND_SEC)
    assert fake.started.acquire(timeout=BOUND_SEC)
    by_name = {session.argv[1]: session for session in fake.sessions.values()}
    assert set(by_name) == {b"a", b"b"}
    cancels["a"].set()
    assert by_name[b"a"].cancelled.wait(BOUND_SEC)
    assert by_name[b"a"].finished.wait(BOUND_SEC)
    assert not by_name[b"b"].cancelled.is_set()
    assert not by_name[b"b"].finished.is_set()
    cancels["b"].set()
    for thread in threads:
        thread.join(BOUND_SEC)
    assert codes == {"a": 1, "b": 1}
    assert sorted(fake.waited) == sorted(fake.sessions)


@pytest.fixture
def uninstall():
    yield
    stack = native_ffmpeg._installed
    native_ffmpeg._installed = None
    if stack is not None:
        stack.close()


def test_install_native_backend_installs_once_and_serves_spawns(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    fake = FakeNative(out=b"ok")
    monkeypatch.setattr(ctypes, "CDLL", lambda name: fake)
    assert native_ffmpeg.install_native_backend() is True
    assert native_ffmpeg.install_native_backend() is True
    assert process.run([IN_PROCESS_FFMPEG], capture_output=True).stdout == b"ok"
    assert len(fake.sessions) == 1


def test_install_native_backend_declines_without_the_library(host: None, uninstall: None) -> None:
    assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None
    with pytest.raises(process.SpawnUnavailableError):
        process.run([IN_PROCESS_FFMPEG], capture_output=True)


def test_install_native_backend_declines_on_a_desktop_row(
    monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeNative())
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None


def test_install_native_backend_declines_when_another_backend_is_installed(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeNative())
    with process.using_in_process_backend(NativeFFmpegBackend(FakeNative())):
        assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None
