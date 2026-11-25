"""NativeFFmpegBackend against a fake ``sc_ffmpeg_*`` library built from ctypes callbacks."""

from __future__ import annotations

import contextlib
import ctypes
import ctypes.util
import errno
import gc
import importlib.util
import inspect
import io
import os
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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


SESSION_THREAD = "fake-native-session"
_LIVE: list[Any] | None = None  # the fakes built inside the current ``reaping`` block


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
    """The five ``sc_ffmpeg_*`` symbols as ctypes callbacks; start dups fds like native does."""

    def __init__(
        self,
        *,
        code: int = 0,
        version: int = 2,
        build_id: bytes | None = b"9.0.2+abcd",
        start_result: int | None = None,
        wait_result: int | None = None,
        honour_cancel: bool = True,
        out: bytes = b"",
        err: bytes = b"",
    ) -> None:
        if _LIVE is not None:
            _LIVE.append(self)
        self.code = code
        self.start_result = start_result
        self.wait_result = wait_result
        self.honour_cancel = honour_cancel
        self.out = out
        self.err = err
        self.argvs: list[list[bytes]] = []
        self.fds: list[tuple[int, int, int]] = []
        self.stdin_data = b""
        self.sessions: dict[int, Session] = {}
        self.cancelled = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.waited: list[int] = []
        self.cancel_calls: list[int] = []
        self.started = threading.Semaphore(0)
        self._next = 1
        self.sc_ffmpeg_abi_version = ctypes.CFUNCTYPE(ctypes.c_int)(lambda: version)
        self.build_id = build_id
        self.sc_ffmpeg_build_id = ctypes.CFUNCTYPE(ctypes.c_char_p)(lambda: self.build_id)
        self.sc_ffmpeg_start = START(self._start)
        self.sc_ffmpeg_wait = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64)(self._wait)
        self.sc_ffmpeg_cancel = ctypes.CFUNCTYPE(None, ctypes.c_int64)(self._cancel)

    def _start(self, argc: int, argv: Any, in_fd: int, out_fd: int, err_fd: int) -> int:
        if self.start_result is not None:
            return self.start_result
        assert argv[argc] is None
        session = Session()
        session.argv = [argv[i] for i in range(argc)]
        self.argvs.append(session.argv)
        self.fds.append((in_fd, out_fd, err_fd))
        session.dups = [os.dup(fd) if fd >= 0 else -1 for fd in (in_fd, out_fd, err_fd)]
        session.thread = threading.Thread(
            target=self._ffmpeg,
            args=(session, *session.dups),
            name=SESSION_THREAD,
            daemon=True,
        )
        session.thread.start()
        session_id = self._next
        self._next += 1
        self.sessions[session_id] = session
        self.started.release()
        return session_id

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
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
        self.cancel_calls.append(session_id)
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


class WokenByCancel(Blocking):
    """The native thread blocks in ``os.read``/``os.write``; cancel calls ``unblock`` (the kick)."""

    def __init__(self, mode: str, unblock: Any) -> None:
        super().__init__()
        self.mode = mode
        self.unblock = unblock
        self.entered = threading.Event()

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
            self.entered.set()
            if self.mode == "read":
                os.read(in_fd, 1)
            else:
                os.write(out_fd, b"x" * 65536)
        finally:
            self._close(session, in_fd, out_fd, err_fd)

    def _cancel(self, session_id: int) -> None:
        # Not super(): that would close the dups itself; here ``unblock`` must wake the thread.
        self.cancel_calls.append(session_id)
        self.sessions[session_id].cancelled.set()
        self.unblock()


class Gated(FakeNative):
    """The tool runs only once ``release`` is set."""

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        self.release.wait(BOUND_SEC)
        super()._ffmpeg(session, in_fd, out_fd, err_fd)


class CountingEvent(threading.Event):
    def __init__(self) -> None:
        super().__init__()
        self.waits = 0

    def wait(self, timeout: float | None = None) -> bool:
        self.waits += 1
        return super().wait(timeout)


class SlowWait(Blocking):
    """Cancel closes the dups at once, but the session and ``wait`` end only once released."""

    def _gate(self, session: Session) -> threading.Event:
        return self.release

    def _ffmpeg(self, session: Session, in_fd: int, out_fd: int, err_fd: int) -> None:
        try:
            self._gate(session).wait(BOUND_SEC)
        finally:
            self._close(session, in_fd, out_fd, err_fd)

    def _wait(self, session_id: int) -> int:
        self._gate(self.sessions[session_id]).wait(BOUND_SEC)
        return super()._wait(session_id)


class PerSession(SlowWait):
    """Each session is released by its own ``release``; cancelling it sets that release."""

    def _gate(self, session: Session) -> threading.Event:
        return session.release

    def _cancel(self, session_id: int) -> None:
        super()._cancel(session_id)
        session = self.sessions.get(session_id)
        if session is not None:
            session.release.set()


def read_all(child: Any) -> bytes:
    assert child.stdout is not None
    return child.stdout.read()


@contextlib.contextmanager
def reaping():
    global _LIVE
    outer, fakes = _LIVE, []
    _LIVE = fakes
    failed = False
    try:
        yield fakes
    except BaseException:
        failed = True
        raise
    finally:
        _LIVE = outer
        threads = []
        for fake in fakes:
            fake.release.set()
            fake.cancelled.set()
            for session in list(fake.sessions.values()):
                session.release.set()
                session.cancelled.set()
                if session.thread is not None:
                    threads.append(session.thread)
        deadline = time.monotonic() + BOUND_SEC
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        stuck = [t.name for t in threads if t.is_alive()]
        if stuck and not failed:
            pytest.fail(f"fake session threads outlived their test: {stuck}")


@pytest.fixture(autouse=True)
def _reap_fakes():
    with reaping():
        yield


def test_a_fake_left_unreleased_leaves_no_session_thread_behind() -> None:
    with reaping() as fakes:
        fake = SlowWait(honour_cancel=False)
        fake.sc_ffmpeg_start(1, (ctypes.c_char_p * 2)(b"ffmpeg", None), -1, -1, -1)
        assert fake.started.acquire(timeout=BOUND_SEC)
        assert fakes == [fake]
        thread = fake.sessions[1].thread
        assert thread is not None and thread.is_alive() and thread.name == SESSION_THREAD
    assert not thread.is_alive()


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
    monkeypatch.setattr(ctypes.cdll, "LoadLibrary", boom)
    monkeypatch.setattr(ctypes.util, "find_library", boom)
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


def test_abi_version_one_is_refused(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeNative(version=1)
    del fake.sc_ffmpeg_build_id
    monkeypatch.setattr(ctypes, "CDLL", lambda name: fake)
    assert native_ffmpeg.is_available() is False
    with pytest.raises(NativeFFmpegUnavailable, match="ABI version 1, expected 2"):
        native_ffmpeg.load_library()


def test_abi_version_two_is_available(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeNative(version=2))
    assert native_ffmpeg.is_available() is True


def test_a_library_missing_build_id_is_refused_by_the_constructor() -> None:
    fake = FakeNative()
    del fake.sc_ffmpeg_build_id
    with pytest.raises(NativeFFmpegUnavailable, match="sc_ffmpeg_build_id"):
        NativeFFmpegBackend(fake)


def _link(monkeypatch: pytest.MonkeyPatch, **kwargs: Any) -> FakeNative:
    fake = FakeNative(**kwargs)
    monkeypatch.setattr(ctypes, "CDLL", lambda name: fake)
    return fake


def test_build_id_and_helpers_return_the_native_id(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _link(monkeypatch)
    assert native_ffmpeg.build_id() == "9.0.2+abcd"
    assert binaries.in_process_build_id() == "9.0.2+abcd"
    assert binaries.in_process_version() == (9, 0, 2)


def test_unlinked_helpers_return_the_sentinel_without_ctypes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("ctypes touched")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert binaries.in_process_build_id() == binaries.IN_PROCESS_BUILD_ID
        assert binaries.in_process_version() == (0, 0, 0)


def test_non_version_id_parses_to_zero(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _link(monkeypatch, build_id=b"dev+abc")
    assert binaries.in_process_version() == (0, 0, 0)


def test_two_ids_give_different_cache_key_tuples(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.ungated_audio import ffmpeg_build_id

    _link(monkeypatch, build_id=b"9.0.2+aaaa")
    first = ffmpeg_build_id()
    _link(monkeypatch, build_id=b"9.0.2+bbbb")
    second = ffmpeg_build_id()
    assert first != second
    assert first == (IN_PROCESS_FFMPEG, (9, 0, 2), "9.0.2+aaaa")


@pytest.mark.parametrize(
    "bad",
    [b"unknown", b"", b"a" * 129, b"a b", b"a\n", "é".encode(), None],
    ids=["unknown", "empty", "129", "space", "newline", "non-ascii", "null"],
)
def test_invalid_build_ids_raise_unavailable(
    host: None, monkeypatch: pytest.MonkeyPatch, bad: bytes | None
) -> None:
    _link(monkeypatch, build_id=bad)
    with pytest.raises(NativeFFmpegUnavailable):
        native_ffmpeg.build_id()


def test_a_128_byte_id_is_valid(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _link(monkeypatch, build_id=b"a" * 128)
    assert native_ffmpeg.build_id() == "a" * 128


def test_unknown_id_is_linked_but_the_pair_is_unavailable(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.support import doctor

    fake = _link(monkeypatch, build_id=b"unknown")
    assert native_ffmpeg.is_available() is True
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        assert binaries.in_process_problem() == binaries.IN_PROCESS_BAD_BUILD_ID
        assert binaries.IN_PROCESS_PAIR.is_available() is False
        info = doctor.ffmpeg_probe_info()["ffmpeg"]
        assert info["ok"] is False
        assert info["version"] == binaries.IN_PROCESS_BAD_BUILD_ID
        with pytest.raises(NativeFFmpegUnavailable):
            binaries.in_process_build_id()


def test_build_id_is_thread_safe(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _link(monkeypatch)
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: native_ffmpeg.build_id(), range(64)))
    assert set(results) == {"9.0.2+abcd"}


class _PlainLib:
    def __init__(self, build_id: Any = None) -> None:
        proto = ctypes.CFUNCTYPE
        self.sc_ffmpeg_abi_version = proto(ctypes.c_int)(lambda: native_ffmpeg.ABI_VERSION)
        self.sc_ffmpeg_start = proto(
            ctypes.c_int64,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        )(lambda *args: 1)
        self.sc_ffmpeg_wait = proto(ctypes.c_int, ctypes.c_int64)(lambda session: 0)
        self.sc_ffmpeg_cancel = proto(None, ctypes.c_int64)(lambda session: None)
        self.sc_ffmpeg_build_id = proto(ctypes.c_char_p)(build_id or (lambda: b"9.0.2+abcd"))


def test_the_backend_keeps_its_library_alive() -> None:
    import weakref

    lib = _PlainLib()
    ref = weakref.ref(lib)
    backend = NativeFFmpegBackend(lib)
    del lib
    assert ref() is not None
    del backend
    assert ref() is None


def test_build_id_keeps_the_library_alive_during_the_call(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import weakref

    alive: list[bool] = []
    holder: list[Any] = []

    def build_id() -> bytes:
        alive.append(holder[0]() is not None)
        return b"9.0.2+abcd"

    def cdll(name: object) -> _PlainLib:
        lib = _PlainLib(build_id)
        holder.append(weakref.ref(lib))
        return lib

    monkeypatch.setattr(ctypes, "CDLL", cdll)
    assert native_ffmpeg.build_id() == "9.0.2+abcd"
    assert alive == [True]


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


def test_a_stream_without_a_fileno_is_exit_one_with_one_stderr_line() -> None:
    fake = FakeNative()
    err = io.BytesIO()
    code = NativeFFmpegBackend(fake).run(
        [IN_PROCESS_FFMPEG], Streams(None, io.BytesIO(), err), threading.Event()
    )
    assert code == 1
    assert len(err.getvalue().splitlines()) == 1
    assert fake.argvs == []


def test_wait_negative_errno_is_exit_one_never_success(host: None) -> None:
    done = run_child(FakeNative(wait_result=-errno.ESRCH), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert len(done.stderr.splitlines()) == 1


@pytest.mark.parametrize("bad", [-3, -1, 256, 300, 1000, -(2**31), 2**31 - 1])
def test_a_wait_outside_0_to_255_is_exit_one(host: None, bad: int) -> None:
    """The backend rejects every int32 the callback can carry; ctypes cannot pass wider ones."""
    done = run_child(FakeNative(wait_result=bad), [IN_PROCESS_FFMPEG], capture_output=True)
    assert done.returncode == 1
    assert len(done.stderr.splitlines()) == 1


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
    gc.collect()
    before = open_fd_count()
    for _ in range(20):
        done = run_child(fake, [IN_PROCESS_FFMPEG], input=b"a", capture_output=True)
        assert done.stdout == b"x"
    gc.collect()
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


def test_a_stream_whose_flush_raises_fails_with_one_stderr_line_and_starts_nothing() -> None:
    fake = FakeNative()
    closed = io.BytesIO()
    closed.close()
    err = io.BytesIO()
    code = NativeFFmpegBackend(fake).run(
        [IN_PROCESS_FFMPEG], Streams(closed, None, err), threading.Event()
    )
    assert code == 1
    assert len(err.getvalue().splitlines()) == 1
    assert fake.argvs == []
    assert not fake.sessions


def test_the_cancel_watcher_thread_exits_once_run_returns() -> None:
    before = set(threading.enumerate())
    seen: list[threading.Thread] = []

    class SeesWatcher(FakeNative):
        def _wait(self, session_id: int) -> int:
            # run has started the watcher before it waits, so it must be alive right here.
            seen.extend(
                t
                for t in threading.enumerate()
                if t not in before and t.name == "native-ffmpeg-cancel" and t.is_alive()
            )
            return super()._wait(session_id)

    NativeFFmpegBackend(SeesWatcher()).run(
        [IN_PROCESS_FFMPEG], Streams(None, None, None), threading.Event()
    )
    assert len(seen) == 1
    seen[0].join(BOUND_SEC)
    assert not seen[0].is_alive()


def test_cancel_set_before_start_is_seen_by_the_watcher() -> None:
    fake = Blocking()
    cancel = threading.Event()
    cancel.set()
    NativeFFmpegBackend(fake).run([IN_PROCESS_FFMPEG], Streams(None, None, None), cancel)
    assert fake.cancelled.is_set()


def test_a_backend_that_ignores_cancel_is_abandoned_after_the_grace(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "_KILL_GRACE_SEC", 0.2)
    fake = Blocking(honour_cancel=False)
    try:
        with process.using_in_process_backend(NativeFFmpegBackend(fake)):
            child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
            child.kill()
            assert child.wait(2) == -9
    finally:
        fake.release.set()
        assert fake.finished.wait(2)


def test_abandon_closes_the_callers_stdin_so_a_blocked_read_ends_and_the_next_session_runs(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "_KILL_GRACE_SEC", 0.2)
    fake = FakeNative(honour_cancel=False)
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        child = process.popen([IN_PROCESS_FFMPEG], stdin=process.PIPE)
        assert fake.started.acquire(timeout=BOUND_SEC)
        child.kill()
        assert child.wait(BOUND_SEC) == -9
        assert child.stdin is not None
        with pytest.raises(BrokenPipeError):
            child.stdin.write(b"x")
        child.stdin.close()
        assert fake.finished.wait(BOUND_SEC)
        second = process.popen([IN_PROCESS_FFMPEG], stdin=process.PIPE)
        assert second.stdin is not None
        second.stdin.close()
        assert second.wait(BOUND_SEC) == 0


def test_a_reader_sees_eof_after_kill_and_abandon_with_a_conformant_native(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "_KILL_GRACE_SEC", 0.2)
    fake = SlowWait()
    with process.using_in_process_backend(NativeFFmpegBackend(fake)):
        child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
        child.kill()
        assert child.wait(2) == -9
        assert fake.cancelled.is_set()
        result: list[bytes] = []
        reader = threading.Thread(target=lambda: result.append(read_all(child)), daemon=True)
        reader.start()
        reader.join(2)
        assert not reader.is_alive()
        assert result == [b""]
    fake.release.set()


def test_a_native_that_ignores_cancel_never_hangs_wait_though_eof_is_delayed(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(process, "_KILL_GRACE_SEC", 0.2)
    fake = Blocking(honour_cancel=False)
    try:
        with process.using_in_process_backend(NativeFFmpegBackend(fake)):
            child = process.popen([IN_PROCESS_FFMPEG], stdout=process.PIPE)
            child.kill()
            assert child.wait(2) == -9
            assert not fake.finished.is_set()
            result: list[bytes] = []
            reader = threading.Thread(target=lambda: result.append(read_all(child)), daemon=True)
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


def test_the_stream_is_flushed_before_start() -> None:
    class Spy(io.BufferedRandom):
        flushed = 0

        def flush(self) -> None:
            Spy.flushed += 1
            super().flush()

    class Recording(FakeNative):
        flushed_at_start: int | None = None

        def _start(self, argc: int, argv: Any, in_fd: int, out_fd: int, err_fd: int) -> int:
            self.flushed_at_start = Spy.flushed
            return super()._start(argc, argv, in_fd, out_fd, err_fd)

    fake = Recording()
    with tempfile.TemporaryFile() as raw:
        spy = Spy(io.FileIO(os.dup(raw.fileno()), "r+"))
        try:
            NativeFFmpegBackend(fake).run(
                [IN_PROCESS_FFMPEG], Streams(None, spy, None), threading.Event()
            )
            assert fake.flushed_at_start is not None
            assert fake.flushed_at_start >= 1
        finally:
            spy.close()


def test_a_lookalike_sentinel_is_not_a_native_tool() -> None:
    fake = FakeNative()
    for name in (IN_PROCESS_FFMPEG + "x", "x" + IN_PROCESS_FFMPEG, IN_PROCESS_FFMPEG.upper()):
        code = NativeFFmpegBackend(fake).run([name], Streams(None, None, None), threading.Event())
        assert code == 1
    assert fake.argvs == []


class ParkedEvent(threading.Event):
    """A cancel event whose ``wait`` parks until ``unpark`` is set, like a watcher mid-poll."""

    def __init__(self) -> None:
        super().__init__()
        self.unpark = threading.Event()
        self.parked = threading.Event()

    def wait(self, timeout: float | None = None) -> bool:
        self.parked.set()
        self.unpark.wait(BOUND_SEC)
        return super().wait(0)


def test_run_does_not_wait_for_the_watcher_to_finish_its_poll() -> None:
    fake = FakeNative()
    cancel = ParkedEvent()
    codes: list[int] = []
    runner = threading.Thread(
        target=lambda: codes.append(
            NativeFFmpegBackend(fake).run([IN_PROCESS_FFMPEG], Streams(None, None, None), cancel)
        ),
        daemon=True,
    )
    runner.start()
    assert cancel.parked.wait(BOUND_SEC)
    runner.join(BOUND_SEC / 2)
    finished_while_parked = not runner.is_alive()
    cancel.unpark.set()
    runner.join(BOUND_SEC)
    assert finished_while_parked
    assert codes == [0]


def test_the_module_never_references_subprocess() -> None:
    source = inspect.getsource(native_ffmpeg)
    assert "subprocess" not in source and "Popen" not in source and "PyDLL(" not in source


def test_the_cancel_poll_constant_is_pinned() -> None:
    assert native_ffmpeg._CANCEL_POLL_SEC == 0.05


def test_cancel_reaches_native_within_a_few_polls() -> None:
    fake = Blocking()
    cancel = CountingEvent()
    runner = threading.Thread(
        target=NativeFFmpegBackend(fake).run,
        args=([IN_PROCESS_FFMPEG], Streams(None, None, None), cancel),
        daemon=True,
    )
    runner.start()
    assert fake.started.acquire(timeout=BOUND_SEC)
    waits_before_cancel = cancel.waits
    cancel.set()
    assert fake.cancelled.wait(BOUND_SEC)
    assert cancel.waits - waits_before_cancel <= 10
    runner.join(BOUND_SEC)
    assert not runner.is_alive()


def test_start_never_waits_for_the_tool() -> None:
    fake = Gated()
    codes: list[int] = []
    runner = threading.Thread(
        target=lambda: codes.append(
            NativeFFmpegBackend(fake).run(
                [IN_PROCESS_FFMPEG], Streams(None, None, None), threading.Event()
            )
        ),
        daemon=True,
    )
    runner.start()
    assert fake.started.acquire(timeout=BOUND_SEC)
    assert not fake.finished.is_set()
    assert runner.is_alive()
    assert not codes
    fake.release.set()
    runner.join(BOUND_SEC)
    assert not runner.is_alive()
    assert codes == [0]


def test_a_dlopen_failure_is_unavailable_not_an_error(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(name: Any) -> None:
        raise OSError(errno.ENOENT, "dlopen failed")

    monkeypatch.setattr(ctypes, "CDLL", refuse)
    assert native_ffmpeg.is_available() is False
    assert binaries._in_process_linked() is False


def test_an_unavailable_library_is_logged_only_on_an_in_process_host(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def refuse(name: Any) -> None:
        raise OSError(errno.ENOENT, "dlopen failed")

    monkeypatch.setattr(ctypes, "CDLL", refuse)
    with caplog.at_level("INFO", logger=native_ffmpeg._log.name):
        with host_platform.using(replace(MACOS, media_tools="executables")):
            assert native_ffmpeg.is_available() is False
        assert not caplog.records
        with host_platform.using(ROW):
            assert native_ffmpeg.is_available() is False
    assert "dlopen failed" in caplog.text


def test_a_missing_symbol_is_missing_not_installed(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.pipeline import bootstrap, config

    monkeypatch.setenv("PODCAST_MCP_CACHE", tempfile.mkdtemp())
    for variable in ("PODCAST_MCP_FFMPEG", "PODCAST_MCP_FFPROBE", "PODCAST_MCP_FFMPEG_BUNDLE"):
        monkeypatch.delenv(variable, raising=False)
    broken = FakeNative()
    del broken.sc_ffmpeg_wait
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: broken)
    assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "missing"
    assert config.component_status()["ffmpeg"]["state"] == "missing"
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: FakeNative())
    # Linked is not installed: the backend must also serve argv (#4014).
    assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "missing"
    assert config.component_status()["ffmpeg"]["state"] == "missing"
    with process.using_in_process_backend(NativeFFmpegBackend(FakeNative())):
        assert bootstrap.component_status()["tools"]["ffmpeg"]["state"] == "installed"
        assert config.component_status()["ffmpeg"]["state"] == "installed"


@pytest.mark.parametrize("b_ends", ["released", "cancelled"])
def test_cancel_hits_only_its_own_overlapping_session(b_ends: str) -> None:
    fake = PerSession()
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
    by_name = {session.argv[1]: (sid, session) for sid, session in fake.sessions.items()}
    assert set(by_name) == {b"a", b"b"}
    (a_id, a), (b_id, b) = by_name[b"a"], by_name[b"b"]
    cancels["a"].set()
    assert a.cancelled.wait(BOUND_SEC)
    assert a.finished.wait(BOUND_SEC)
    threads[0].join(BOUND_SEC)
    assert codes == {"a": 1}
    assert not b.cancelled.is_set()
    assert not b.finished.is_set()
    assert fake.cancel_calls == [a_id]
    if b_ends == "released":
        b.release.set()
        expected_b = 0
    else:
        cancels["b"].set()
        expected_b = 1
    threads[1].join(BOUND_SEC)
    assert codes == {"a": 1, "b": expected_b}
    assert fake.cancel_calls == [a_id] + ([b_id] if b_ends == "cancelled" else [])
    assert sorted(fake.waited) == sorted(fake.sessions)


def test_a_cancel_that_races_the_end_of_the_session_is_not_forwarded() -> None:
    fake = FakeNative()
    done = threading.Event()

    class CancelAfterDone(threading.Event):
        def wait(self, timeout: float | None = None) -> bool:
            done.set()  # the session ends while the watcher is mid-poll, then cancel is seen
            return True

    NativeFFmpegBackend(fake)._watch(7, CancelAfterDone(), done)
    assert fake.cancel_calls == []


@pytest.mark.parametrize("mode", ["read", "write"])
def test_cancel_wakes_a_native_thread_blocked_in_a_pipe_call_and_its_dups_close(mode: str) -> None:
    pipe_r, pipe_w = os.pipe()
    kicked = threading.Event()
    closed: set[int] = set()  # fds already closed, so the cleanup never closes a reused number

    def close_writer() -> None:
        os.close(pipe_w)
        closed.add(pipe_w)

    def kick_then_signal(kick: Any) -> Any:
        # The cancel callback may still be running after the native thread has been woken and
        # finished; the pipes must outlive it, so it signals once it has fully returned.
        def run() -> None:
            try:
                kick()
            finally:
                kicked.set()

        return run

    if mode == "read":
        # stdin: the dup blocks in os.read until every writer is gone; unblock closes the writer.
        fake = WokenByCancel(mode, kick_then_signal(close_writer))
        streams = Streams(os.fdopen(pipe_r, "rb"), None, None)
        caller_fds = [pipe_r]
    else:
        # stdout: fill the pipe so os.write blocks; unblock drains the reader.
        os.set_blocking(pipe_w, False)
        try:
            while True:
                os.write(pipe_w, b"\0" * 65536)
        except BlockingIOError:
            pass
        os.set_blocking(pipe_w, True)

        def drain() -> None:
            os.set_blocking(pipe_r, False)
            try:
                while os.read(pipe_r, 65536):
                    pass
            except BlockingIOError:
                pass

        fake = WokenByCancel(mode, kick_then_signal(drain))
        streams = Streams(None, os.fdopen(pipe_w, "wb", buffering=0), None)
        caller_fds = [pipe_w]
    cancel = threading.Event()
    codes: list[int] = []
    runner = threading.Thread(
        target=lambda: codes.append(
            NativeFFmpegBackend(fake).run([IN_PROCESS_FFMPEG], streams, cancel)
        ),
        daemon=True,
    )
    try:
        runner.start()
        assert fake.started.acquire(timeout=BOUND_SEC)
        assert fake.entered.wait(BOUND_SEC)
        session = fake.sessions[1]
        assert not session.closed
        cancel.set()
        assert session.finished.wait(BOUND_SEC)
        assert kicked.wait(BOUND_SEC)
        runner.join(BOUND_SEC)
        assert not runner.is_alive()
        assert codes == [1]
        assert fake.cancel_calls == [1]
        assert session.closed
        for fd in caller_fds:
            os.fstat(fd)
    finally:
        cancel.set()
        # Never close the pipes under a cancel callback that is still running.
        kicked.wait(BOUND_SEC)
        for stream in streams:
            if stream is not None:
                stream.close()
        closed.update(caller_fds)  # the streams own these and have just closed them
        for fd in (pipe_r, pipe_w):
            if fd not in closed:
                os.close(fd)


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


def test_install_native_backend_is_safe_to_race(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    def slow_open(*args: Any, **kwargs: Any) -> FakeNative:
        threading.Event().wait(0.05)
        return FakeNative()

    monkeypatch.setattr(ctypes, "CDLL", slow_open)
    installs: list[object] = []
    real_using = process.using_in_process_backend

    def counting(backend: Any) -> Any:
        installs.append(backend)
        return real_using(backend)

    monkeypatch.setattr(process, "using_in_process_backend", counting)
    gate = threading.Barrier(2, timeout=BOUND_SEC)
    results: list[bool] = []

    def racer() -> None:
        gate.wait()
        results.append(native_ffmpeg.install_native_backend())

    threads = [threading.Thread(target=racer) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(BOUND_SEC)
    assert results == [True, True]
    assert len(installs) == 1
    assert native_ffmpeg._installed is not None


def test_install_native_backend_declines_without_the_library(host: None, uninstall: None) -> None:
    assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None
    with pytest.raises(process.SpawnUnavailableError):
        process.run([IN_PROCESS_FFMPEG], capture_output=True)


@pytest.mark.parametrize("bad", [b"unknown", b"", b"has space", None])
def test_install_native_backend_declines_a_bad_build_id(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None, bad: bytes | None
) -> None:
    _link(monkeypatch, build_id=bad)
    assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None
    assert process.in_process_backend_installed() is False


def test_install_native_backend_declines_on_a_desktop_row(
    monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: FakeNative())
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None


def test_install_native_backend_declines_when_another_backend_is_installed(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: FakeNative())
    with process.using_in_process_backend(NativeFFmpegBackend(FakeNative())):
        assert native_ffmpeg.install_native_backend() is False
    assert native_ffmpeg._installed is None
