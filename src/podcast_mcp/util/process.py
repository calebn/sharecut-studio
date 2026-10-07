"""Audited subprocess helpers for FFmpeg/CLI wrappers.

Call sites must pass argv as a sequence (never a shell string). `shell=True`
is rejected. This concentrates Bandit B603/B404/B607 review on one module.

``detached_children()`` starts every child spawned through ``run`` / ``popen`` (on any
thread) in its own session, so a terminal Ctrl+C reaches only this process and the work
stops through its ``cancel_check`` instead of each child dying on its own (#1164).
``kill_detached_children()`` kills those children's process groups, so leaving early
never orphans one.
"""

from __future__ import annotations

import os
import signal
import subprocess  # nosec B404
import threading
import weakref
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

DEVNULL = subprocess.DEVNULL
PIPE = subprocess.PIPE
STDOUT = subprocess.STDOUT
CalledProcessError = subprocess.CalledProcessError
CompletedProcess = subprocess.CompletedProcess
TimeoutExpired = subprocess.TimeoutExpired
Popen = subprocess.Popen

_detach_lock = threading.RLock()
_detach_depth = 0
_detached: weakref.WeakSet[subprocess.Popen[Any]] = weakref.WeakSet()


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
