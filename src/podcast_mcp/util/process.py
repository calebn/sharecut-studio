"""Audited subprocess helpers for FFmpeg/CLI wrappers.

Call sites must pass argv as a sequence (never a shell string). `shell=True`
is rejected. This concentrates Bandit B603/B404/B607 review on one module.

``detached_children()`` starts every child spawned through ``run`` / ``popen`` (on any
thread) in its own session, so a terminal Ctrl+C reaches only this process and the work
stops through its ``cancel_check`` instead of each child dying on its own (#1164).
``kill_detached_children()`` kills those children's process groups, so leaving early
never orphans one.

An argv whose first item is exactly an in-process tool sentinel never reaches ``Popen``: on a
``media_tools == "in_process"`` row with a backend installed by ``using_in_process_backend`` it
runs on an ``InProcessChild``, anywhere else it raises ``SpawnUnavailableError``.

Both are properties of the desktop ``_spawn``. A runner installed with ``using_runner``
replaces ``_spawn``, so its children are not niceness-wrapped, not registered by
``detached_children`` and not seen by ``kill_detached_children``, and the host gate
(``can_spawn_processes``) is the runner's job.

This module also owns the ``subprocess`` error types; see docs/contributing.md.
"""

from __future__ import annotations

import contextlib
import ctypes
import errno
import io
import locale
import logging
import os
import shutil
import signal
import subprocess  # nosec B404
import threading
import time
import weakref
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, BinaryIO, NamedTuple, Protocol, cast, runtime_checkable

from podcast_mcp.util import host_platform

DEVNULL = subprocess.DEVNULL
PIPE = subprocess.PIPE
STDOUT = subprocess.STDOUT
CalledProcessError = subprocess.CalledProcessError
CompletedProcess = subprocess.CompletedProcess
SubprocessError = subprocess.SubprocessError
TimeoutExpired = subprocess.TimeoutExpired
Popen = subprocess.Popen

IN_PROCESS_FFMPEG = "in-process:ffmpeg"
IN_PROCESS_FFPROBE = "in-process:ffprobe"
_IN_PROCESS_TOOLS = frozenset({IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE})
KILL_GRACE_SEC = 5.0

_log = logging.getLogger(__name__)

# Niceness for children started in this context (and in pool threads that copy it).
_niceness: ContextVar[int] = ContextVar("process_niceness", default=0)

_detach_lock = threading.RLock()
_detach_depth = 0
_detached: weakref.WeakSet[subprocess.Popen[Any]] = weakref.WeakSet()


_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_ERROR_INVALID_PARAMETER = 87
_STILL_ACTIVE = 259
_MAX_WINDOWS_PID = 0xFFFFFFFF


def _kernel32() -> tuple[Any, Callable[[], int]] | None:
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        return kernel32, ctypes.get_last_error  # type: ignore[attr-defined]
    except (AttributeError, ImportError, OSError):
        return None


def _windows_pid_alive(pid: int, kernel32: Any, last_error: Callable[[], int]) -> bool:
    """False only when Windows says ``pid`` is no process or has exited; never signals it."""
    try:
        handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return last_error() != _ERROR_INVALID_PARAMETER
        try:
            code = ctypes.c_uint32()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == _STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    except (ctypes.ArgumentError, OSError):
        return True


def pid_is_alive(pid: int) -> bool:
    """Return False only when a positive PID is certainly gone."""
    if pid <= 0:
        return True
    if host_platform.current().is_nt:
        if pid > _MAX_WINDOWS_PID:
            return True
        probe = _kernel32()
        if probe is None:
            return True
        return _windows_pid_alive(pid, *probe)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (OSError, OverflowError):
        return True
    return True


@contextmanager
def low_priority(niceness: int = 10) -> Iterator[None]:
    """Start children at a lower CPU priority while inside this block (background work).

    Per context, not process-wide: a user's own render started meanwhile keeps its priority.
    No effect where there is no ``nice`` (Windows).
    """
    token = _niceness.set(niceness)
    try:
        yield
    finally:
        _niceness.reset(token)


def current_niceness() -> int:
    """The niceness :func:`low_priority` set in this context (0 outside it)."""
    return _niceness.get()


@contextmanager
def detached_children() -> Iterator[None]:
    """Start children in their own session (process group) while inside this block.

    Process-wide, so pool worker threads spawn detached children too. A detached child
    gets stdin from ``/dev/null``: it must not read or reconfigure the terminal it left.
    """
    global _detach_depth
    with _detach_lock:
        _detach_depth += 1
    try:
        yield
    finally:
        with _detach_lock:
            _detach_depth -= 1


def kill_detached_children() -> None:
    """SIGKILL the process group of every detached child that is still running.

    Safe from a signal handler on the main thread (the lock is re-entrant).
    """
    with _detach_lock:
        procs = list(_detached)
    for proc in procs:
        _kill_unless_reaped(proc)


def _kill_unless_reaped(proc: subprocess.Popen[Any]) -> None:
    """Kill ``proc``'s group only while its pid still names it.

    Popen reaps a child and sets ``returncode`` under its own reap lock, so holding that lock
    makes the check and the kill one step: a reaped pid the OS hands to another process is
    never signalled. When a waiter holds it (a blocking ``wait`` on another thread, or the
    main thread this handler interrupted), the child is not reaped yet, so the kill is safe
    apart from the waiter's few instructions between ``waitpid`` and setting ``returncode``.
    """
    reap_lock = getattr(proc, "_waitpid_lock", None) or threading.Lock()  # POSIX CPython only
    held = reap_lock.acquire(blocking=False)
    try:
        if proc.returncode is not None:
            return
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except OSError:
        return
    finally:
        if held:
            reap_lock.release()


def _check_argv(argv: Sequence[str | bytes | Path]) -> list[str]:
    if not isinstance(argv, (list, tuple)):
        raise TypeError("argv must be a list or tuple (no shell strings)")
    if not argv:
        raise ValueError("argv must not be empty")
    return [str(a) for a in argv]


def _with_niceness(cmd: list[str]) -> list[str]:
    """``cmd`` under ``nice`` when this context asked for a lower priority.

    ``nice`` lowers the priority before the program starts, so every thread it creates
    inherits it (``setpriority`` on the pid afterwards only reaches the main thread).
    Relative, so a child never runs above the server's own niceness.
    """
    niceness = _niceness.get()
    nice = shutil.which("nice") if niceness and host_platform.current().is_posix else None
    return [nice, "-n", str(niceness), *cmd] if nice else cmd


@runtime_checkable
class Child(Protocol):
    """What ``run`` and ``popen`` need of a started program; ``subprocess.Popen`` is one."""

    stdin: Any
    stdout: Any
    stderr: Any
    returncode: int | None
    pid: int | None

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def communicate(self, input: Any = None, timeout: float | None = None) -> tuple[Any, Any]: ...

    def kill(self) -> None: ...

    def __enter__(self) -> Any: ...

    def __exit__(self, *exc: Any) -> Any: ...


class Runner(Protocol):
    """A replacement for the module's ``_spawn``: starts ``cmd`` and returns its :class:`Child`."""

    def __call__(
        self,
        cmd: list[str],
        *,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
        text: bool | None = None,
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        start_new_session: bool = False,
    ) -> Child: ...


class SpawnUnavailableError(OSError):
    """This host cannot start other programs (``ENOSYS``). Callers that already catch ``OSError`` report it."""


class Streams(NamedTuple):
    """The backend's ends of the three streams; ``None`` is /dev/null."""

    stdin: BinaryIO | None
    stdout: BinaryIO | None
    stderr: BinaryIO | None


class InProcessBackend(Protocol):
    """Runs one ffmpeg or ffprobe argv inside this process (a Kit adapter, or a test fake)."""

    def run(self, argv: list[str], streams: Streams, cancel: threading.Event) -> int:
        """Read stdin to EOF, write stdout and stderr, return the exit code.

        Must return soon after ``cancel`` is set; ``cancel`` may be set more than once.
        """
        ...


_in_process_backend: InProcessBackend | None = None


@contextmanager
def using_in_process_backend(backend: InProcessBackend) -> Iterator[None]:
    """Serve in-process tool argv from ``backend`` while inside this block.

    Process-wide. Raises ``RuntimeError`` when one is already installed.
    """
    global _in_process_backend
    with _runner_lock:
        if _in_process_backend is not None:
            raise RuntimeError("an in-process backend is already installed")
        _in_process_backend = backend
    try:
        yield
    finally:
        with _runner_lock:
            _in_process_backend = None


_PIPES_OUT = ("stdout", "stderr")


def _encoding() -> str:
    return locale.getpreferredencoding(False)


class _CallerStdin(io.BufferedWriter):
    """The caller's write end of an in-process stdin pipe; ``broken`` makes a write raise EPIPE."""

    broken = False

    def write(self, buffer: Any, /) -> int:
        if self.broken:
            raise BrokenPipeError(errno.EPIPE, os.strerror(errno.EPIPE))
        return super().write(buffer)


class InProcessChild:
    """A :class:`Child` whose program is ``backend.run`` on a daemon thread.

    A PIPE stream is an ``os.pipe`` pair, a file object is handed to the backend as is, and
    DEVNULL or ``None`` give the backend ``None``. ``pid`` is ``None``. A ``kill`` that the
    backend ignores for ``KILL_GRACE_SEC`` ends the child with ``-9`` at once (``wait`` never
    hangs) and abandons its thread. At the abandon it releases the caller's write end of a stdin
    pipe (a backend blocked reading it sees EOF; a later write raises ``BrokenPipeError``) and
    detaches the backend's own pipe ends. The caller's stdout and stderr read ends stay open: a
    reader sees EOF after the abandon only if the backend has closed its own stream ends on
    cancel (the native ABI requires that); a backend that keeps them delays EOF until it
    returns. A backend that returns a non-int has failed with code ``1``.
    A ``kill`` before the backend finishes always reports ``-9``, whatever the backend returns,
    as a SIGKILLed ``Popen`` does; one after completion changes nothing. A ``None`` stream is
    ``/dev/null`` here, never inherited from the parent as ``Popen`` would.
    """

    pid = None

    def __init__(
        self,
        argv: list[str],
        backend: InProcessBackend,
        *,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
        text: bool | None = None,
    ) -> None:
        self.args = argv
        self.returncode: int | None = None
        self.stdin: Any = None
        self.stdout: Any = None
        self.stderr: Any = None
        self._text = bool(text)
        self._cancel = threading.Event()
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._grace: threading.Timer | None = None
        self._owned: list[BinaryIO] = []
        self._owned_fds: list[int] = []
        self._fd_lock = threading.Lock()
        self._fds_closed = False
        self._null_fd: int | None = None
        try:
            if PIPE in (stdin, stdout, stderr):
                self._null_fd = os.open(os.devnull, os.O_RDWR)
            stdin_end = self._end("stdin", stdin)
            stdout_end = self._end("stdout", stdout)
            stderr_end = stdout_end if stderr == STDOUT else self._end("stderr", stderr)
            ends = Streams(stdin_end, stdout_end, stderr_end)
            self._thread = threading.Thread(
                target=self._main, args=(backend, ends), daemon=True, name="in-process-child"
            )
            self._thread.start()
        except BaseException:
            self._close_owned()
            raise

    def _end(self, name: str, spec: Any) -> Any:
        if spec is None or spec == DEVNULL:
            return None
        if spec != PIPE:
            return spec
        read_fd, write_fd = os.pipe()
        reading = name == "stdin"
        if reading:
            ours: Any = _CallerStdin(io.FileIO(write_fd, "wb"))
        else:
            ours = os.fdopen(read_fd, "rb")
        their_fd = read_fd if reading else write_fd
        theirs = os.fdopen(their_fd, "rb" if reading else "wb", closefd=False)
        setattr(self, name, ours)
        self._owned.append(theirs)
        self._owned_fds.append(their_fd)
        return theirs

    def _close_owned(self) -> None:
        for end in self._owned:
            with contextlib.suppress(OSError):
                end.close()
        with self._fd_lock:
            fds, self._owned_fds = ([] if self._fds_closed else self._owned_fds), []
            if not self._fds_closed and self._null_fd is not None:
                fds.append(self._null_fd)
            self._fds_closed = True
        for fd in fds:
            with contextlib.suppress(OSError):
                os.close(fd)

    def _detach_owned(self) -> None:
        """Point the backend's pipe ends at /dev/null without closing their file objects.

        Closing a buffered end that a stuck backend is blocked in waits on its lock. The pipe
        ends are released at once (the caller's reads see EOF once the backend has closed its own
        ends too); the descriptor numbers stay valid until the backend returns, so a late write
        cannot land on a reused descriptor.
        """
        with self._fd_lock:
            if self._fds_closed or self._null_fd is None:
                return
            for fd in self._owned_fds:
                os.dup2(self._null_fd, fd)

    def _release_caller_stdin(self) -> None:
        """Release the caller's write end of stdin so a read blocked on it in the backend sees EOF.

        /dev/null replaces the pipe on the same descriptor number, which the writer still owns
        and closes once, so a concurrent write cannot reach a reused descriptor. Later writes
        raise ``BrokenPipeError``.
        """
        stdin = self.stdin
        if not isinstance(stdin, _CallerStdin):
            return
        stdin.broken = True
        with self._fd_lock:
            if self._fds_closed or self._null_fd is None:
                return
            with contextlib.suppress(OSError, ValueError):
                os.dup2(self._null_fd, stdin.fileno())

    def _finish(self, code: int) -> None:
        with self._lock:
            if self.returncode is None:
                self.returncode = code
        self._close_owned()
        self._done.set()
        if self._grace is not None:
            self._grace.cancel()

    def _main(self, backend: InProcessBackend, ends: Streams) -> None:
        try:
            code = backend.run(self.args, ends, self._cancel)
        except BaseException:
            _log.exception("in-process backend failed: %s", self.args[0])
            code = 1
        if not isinstance(code, int) or isinstance(code, bool):
            _log.error("in-process backend returned %r, not an int: %s", code, self.args[0])
            code = 1
        if self._cancel.is_set():
            code = -9
        self._finish(code)

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if not self._done.wait(timeout):
            raise TimeoutExpired(self.args, timeout or 0.0)
        return cast(int, self.returncode)

    def kill(self) -> None:
        if self._done.is_set() or self._cancel.is_set():
            return
        self._cancel.set()
        self._grace = threading.Timer(KILL_GRACE_SEC, self._abandon)
        self._grace.daemon = True
        try:
            self._grace.start()
        except RuntimeError:
            self._grace = None
            self._abandon()

    def _abandon(self) -> None:
        if not self._done.is_set():
            _log.error("in-process backend ignored kill: %s", self.args[0])
            with self._lock:
                if self.returncode is None:
                    self.returncode = -9
            self._detach_owned()
            self._release_caller_stdin()
            self._done.set()

    def communicate(self, input: Any = None, timeout: float | None = None) -> tuple[Any, Any]:
        deadline = None if timeout is None else time.monotonic() + timeout
        results: dict[str, Any] = {}

        def feed() -> None:
            data = input.encode(_encoding()) if isinstance(input, str) else input
            with contextlib.suppress(OSError, ValueError):
                if data:
                    self.stdin.write(data)
            with contextlib.suppress(OSError, ValueError):
                self.stdin.close()

        def drain(name: str) -> None:
            results[name] = getattr(self, name).read()

        jobs = [
            threading.Thread(target=drain, args=(n,), daemon=True)
            for n in _PIPES_OUT
            if getattr(self, n)
        ]
        if self.stdin is not None:
            jobs.append(threading.Thread(target=feed, daemon=True))
        for job in jobs:
            job.start()
        for job in jobs:
            job.join(None if deadline is None else max(0.0, deadline - time.monotonic()))
            if job.is_alive():
                raise TimeoutExpired(self.args, timeout or 0.0)
        self.wait(None if deadline is None else max(0.0, deadline - time.monotonic()))
        out, err = results.get("stdout"), results.get("stderr")
        for name in _PIPES_OUT:
            if getattr(self, name) is not None:
                getattr(self, name).close()
        if self._text:
            out = out.decode(_encoding()) if out is not None else None
            err = err.decode(_encoding()) if err is not None else None
        return out, err

    def __enter__(self) -> InProcessChild:
        return self

    def __exit__(self, *exc: Any) -> None:
        for end in (self.stdin, self.stdout, self.stderr):
            if end is not None:
                with contextlib.suppress(OSError):
                    end.close()
        if self.returncode is None:
            self.kill()
        self.wait()


def _spawn(
    cmd: list[str],
    *,
    stdin: Any = None,
    stdout: Any = None,
    stderr: Any = None,
    text: bool | None = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    start_new_session: bool = False,
) -> subprocess.Popen[Any]:
    if cmd[0] in _IN_PROCESS_TOOLS:
        backend = _in_process_backend
        if host_platform.current().media_tools != "in_process" or backend is None:
            raise SpawnUnavailableError(errno.ENOSYS, "In-process media tools are not available.")
        return InProcessChild(  # type: ignore[return-value]
            cmd, backend, stdin=stdin, stdout=stdout, stderr=stderr, text=text
        )
    if not host_platform.current().can_spawn_processes:
        raise SpawnUnavailableError(errno.ENOSYS, "This device can't start other programs.")
    cmd = _with_niceness(cmd)

    def popen_(*, detach: bool) -> subprocess.Popen[Any]:
        return subprocess.Popen(  # nosec B603
            cmd,
            stdin=DEVNULL if detach and stdin is None else stdin,
            stdout=stdout,
            stderr=stderr,
            text=text,
            cwd=cwd,
            env=env,
            start_new_session=start_new_session or detach,
            shell=False,
        )

    if not _detach_depth:
        return popen_(detach=False)
    # Spawn and register under the lock so a concurrent kill never misses this child.
    with _detach_lock:
        detach = _detach_depth > 0
        proc = popen_(detach=detach)
        if detach:
            _detached.add(proc)
    return proc


_DESKTOP_SPAWN = _spawn
_runner_lock = threading.Lock()


@contextmanager
def using_runner(runner: Runner) -> Iterator[None]:
    """Make ``run`` and ``popen`` start children through ``runner`` while inside this block.

    Process-wide, so worker threads see it too; for host startup and serial tests, not for
    swapping while other threads are spawning. Raises ``RuntimeError`` when a runner is
    already installed, and restores the desktop spawn on exit.

    The installer owns what ``_spawn`` does on desktop: the ``can_spawn_processes`` gate,
    niceness and the ``detached_children`` registry do not apply to a runner's children, and
    ``kill_detached_children`` does not see them.

    The ``type: ignore`` exists because a runner returns a ``Child``, not a ``Popen``.
    """
    global _spawn
    with _runner_lock:
        if _spawn is not _DESKTOP_SPAWN:
            raise RuntimeError("a runner is already installed")
        _spawn = runner  # type: ignore[assignment]
    try:
        yield
    finally:
        with _runner_lock:
            _spawn = _DESKTOP_SPAWN


def run(
    argv: Sequence[str | bytes | Path],
    *,
    check: bool = False,
    capture_output: bool = False,
    text: bool | None = None,
    input: str | bytes | None = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    stdout: Any = None,
    stderr: Any = None,
    start_new_session: bool = False,
) -> subprocess.CompletedProcess[Any]:
    """Run argv with subprocess-compatible options.

    ``check`` controls nonzero-exit exceptions, ``capture_output`` pipes both
    streams, and ``text`` chooses decoded text rather than bytes. These booleans
    deliberately match :func:`subprocess.run` at existing call sites. Like it, a
    timeout or any exception while waiting kills the child.
    """
    cmd = _check_argv(argv)
    if capture_output:
        if stdout is not None or stderr is not None:
            raise ValueError("stdout and stderr arguments may not be used with capture_output.")
        stdout = stderr = PIPE
    with _spawn(
        cmd,
        stdin=PIPE if input is not None else None,
        stdout=stdout,
        stderr=stderr,
        text=text,
        cwd=cwd,
        env=env,
        start_new_session=start_new_session,
    ) as proc:
        try:
            out, err = proc.communicate(input, timeout=timeout)
        except TimeoutExpired:
            proc.kill()
            proc.wait()
            raise
        except BaseException:
            proc.kill()
            raise
        rc = proc.wait()
        if check and rc:
            raise CalledProcessError(rc, cmd, output=out, stderr=err)
    return CompletedProcess(cmd, rc, out, err)


def popen(
    argv: Sequence[str | bytes | Path],
    *,
    stdin: Any = None,
    stdout: Any = None,
    stderr: Any = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    start_new_session: bool = False,
) -> subprocess.Popen[Any]:
    return _spawn(
        _check_argv(argv),
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        cwd=cwd,
        env=env,
        start_new_session=start_new_session,
    )
