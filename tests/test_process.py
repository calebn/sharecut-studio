from __future__ import annotations

import os
import sys
import threading
from typing import Any

import pytest

from podcast_mcp.util import process as process_module
from podcast_mcp.util.process import (
    CalledProcessError,
    TimeoutExpired,
    detached_children,
    kill_detached_children,
    low_priority,
    pid_is_alive,
    popen,
    run,
)

_SLEEP = [sys.executable, "-c", "import time; time.sleep(30)"]


@pytest.mark.parametrize("pid", [0, -1])
def test_nonpositive_pid_is_unknown_without_signalling(
    pid: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(os, "kill", lambda *_args: pytest.fail("nonpositive PID was signalled"))
    assert pid_is_alive(pid) is True


@pytest.mark.parametrize("error", [PermissionError, OSError, OverflowError])
def test_probe_errors_leave_owner_unknown(
    error: type[Exception], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(_pid: int, _signal: int) -> None:
        raise error("cannot determine process state")

    monkeypatch.setattr(os, "kill", fail)
    monkeypatch.setattr(process_module, "_kernel32", lambda: None)
    assert pid_is_alive(1234) is True


HANDLE = 77


class _Kernel32:
    def __init__(self, *, opens: bool = True, exit_code: int | None = 259, error: int = 0) -> None:
        self.opens, self.exit_code, self.error = opens, exit_code, error
        self.closed: list[int] = []
        self.asked: list[tuple[int, bool, int]] = []

    def OpenProcess(self, access: int, inherit: bool, pid: int) -> int | None:
        self.asked.append((access, inherit, pid))
        return HANDLE if self.opens else None

    def GetExitCodeProcess(self, handle: int, out: Any) -> int:
        if self.exit_code is None:
            return 0
        out._obj.value = self.exit_code
        return 1

    def CloseHandle(self, handle: int) -> int:
        self.closed.append(handle)
        return 1


@pytest.mark.parametrize(
    ("kernel32", "alive"),
    [
        pytest.param(_Kernel32(), True, id="still_active"),
        pytest.param(_Kernel32(exit_code=0), False, id="exited_zero"),
        pytest.param(_Kernel32(exit_code=1), False, id="exited_one"),
        pytest.param(_Kernel32(exit_code=None), True, id="exit_code_unreadable"),
        pytest.param(_Kernel32(opens=False, error=87), False, id="no_such_process"),
        pytest.param(_Kernel32(opens=False, error=5), True, id="access_denied"),
        pytest.param(_Kernel32(opens=False, error=1450), True, id="unknown_error"),
    ],
)
def test_windows_liveness_is_false_only_when_the_process_is_certainly_gone(
    kernel32: _Kernel32, alive: bool
) -> None:
    assert process_module._windows_pid_alive(4321, kernel32, lambda: kernel32.error) is alive
    assert kernel32.asked == [(process_module._PROCESS_QUERY_LIMITED_INFORMATION, False, 4321)]
    assert kernel32.closed == ([HANDLE] if kernel32.opens else [])


def test_pid_is_alive_on_windows_asks_the_windows_probe_and_never_signals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kernel32 = _Kernel32(exit_code=0)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(process_module, "_kernel32", lambda: (kernel32, lambda: 0))
    monkeypatch.setattr(os, "kill", lambda *_a: pytest.fail("os.kill terminates on Windows"))

    assert pid_is_alive(4321) is False


def test_windows_liveness_a_ctypes_failure_is_unknown() -> None:
    class Failing(_Kernel32):
        def OpenProcess(self, access: int, inherit: bool, pid: int) -> int | None:
            raise OSError("kernel32 call failed")

    assert process_module._windows_pid_alive(4321, Failing(), lambda: 0) is True


def test_pid_is_alive_on_windows_leaves_a_pid_beyond_32_bits_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(process_module, "_kernel32", lambda: pytest.fail("probed a 33-bit pid"))

    assert pid_is_alive(2**32) is True


def test_pid_is_alive_on_windows_without_kernel32_is_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(process_module, "_kernel32", lambda: None)

    assert pid_is_alive(4321) is True


def test_run_rejects_non_sequence_argv() -> None:
    with pytest.raises(TypeError, match="argv must be a list or tuple"):
        run("echo hi")  # type: ignore[arg-type]


def test_run_rejects_empty_argv() -> None:
    with pytest.raises(ValueError, match="argv must not be empty"):
        run([])


def test_run_harmless_command() -> None:
    r = run([sys.executable, "-c", "print(1)"], capture_output=True, text=True)
    assert r.returncode == 0
    assert r.stdout.strip() == "1"


def test_run_boolean_options_keep_subprocess_semantics() -> None:
    failing = [sys.executable, "-c", "import sys; print('failed'); sys.exit(3)"]
    result = run(failing, check=False, capture_output=True, text=True)
    assert result.returncode == 3
    assert result.stdout.strip() == "failed"
    assert isinstance(result.stdout, str)
    with pytest.raises(CalledProcessError) as exc:
        run(failing, check=True, capture_output=True, text=False)
    assert exc.value.returncode == 3
    assert exc.value.stdout.strip() == b"failed"


def test_popen_rejects_and_runs() -> None:
    with pytest.raises(TypeError, match="argv must be a list or tuple"):
        popen("echo hi")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="argv must not be empty"):
        popen([])
    proc = popen([sys.executable, "-c", "pass"], stdout=None, stderr=None)
    assert proc.wait() == 0


def test_run_kills_the_child_on_timeout_and_rejects_mixed_capture() -> None:
    with pytest.raises(TimeoutExpired):
        run(_SLEEP, timeout=0.1)
    with pytest.raises(ValueError, match="capture_output"):
        run([sys.executable, "-c", "pass"], capture_output=True, stdout=sys.stdout)


def test_run_feeds_input() -> None:
    echo = [sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"]
    assert run(echo, input="hi", capture_output=True, text=True).stdout.strip() == "HI"


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_detached_children_start_in_their_own_session_without_the_terminal() -> None:
    probe = [
        sys.executable,
        "-c",
        "import os, sys; print(os.getsid(0) == os.getpid(), sys.stdin.read() == '')",
    ]
    with detached_children():
        assert run(probe, capture_output=True, text=True).stdout.split() == ["True", "True"]
    assert run(probe, capture_output=True, text=True, input="x").stdout.split()[0] == "False"


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_kills_only_children_started_detached() -> None:
    attached = popen(_SLEEP)
    try:
        with detached_children():
            detached = popen(_SLEEP)
            finished = popen([sys.executable, "-c", "pass"])
            finished.wait()
            kill_detached_children()
            assert detached.wait(timeout=5) != 0
        kill_detached_children()
        assert attached.poll() is None
    finally:
        attached.kill()
        attached.wait()


def test_specs_from_extensions_skips_blank_and_falls_back() -> None:
    from podcast_mcp.export.audio import ExportFormatSpec, specs_from_extensions

    specs = specs_from_extensions(["", ".", "flac"])
    assert [s.ext for s in specs] == ["flac"]
    assert specs_from_extensions(["", "."]) == [ExportFormatSpec(ext="wav")]
    spec = ExportFormatSpec.from_dict({"ext": "aac", "extra_args": "-movflags"})
    assert spec.extra_args == ("-movflags",)


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_never_signals_a_reaped_pid(monkeypatch) -> None:
    killed: list[int] = []
    with detached_children():
        done = popen([sys.executable, "-c", "pass"])
        done.wait()
        monkeypatch.setattr(os, "killpg", lambda pid, _sig: killed.append(pid))
        kill_detached_children()
    assert done.pid not in killed


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_kills_a_child_another_thread_is_waiting_on() -> None:
    with detached_children():
        child = popen(_SLEEP)
        started = False
        waiter: threading.Thread | None = None
        try:
            wait_lock_acquired = threading.Event()
            original_wait_lock = child._waitpid_lock

            class ObservedWaitLock:
                def acquire(self, blocking=True, timeout=-1):
                    acquired = original_wait_lock.acquire(blocking, timeout)
                    if blocking and acquired:
                        wait_lock_acquired.set()
                    return acquired

                def release(self):
                    original_wait_lock.release()

                def __enter__(self):
                    self.acquire()
                    return self

                def __exit__(self, *_exc_info):
                    self.release()
                    return False

            child._waitpid_lock = ObservedWaitLock()
            waiter_errors: list[BaseException] = []

            def wait_for_child() -> None:
                try:
                    child.wait()
                except BaseException as exc:
                    waiter_errors.append(exc)

            waiter = threading.Thread(target=wait_for_child)
            waiter.start()
            started = True
            assert wait_lock_acquired.wait(timeout=5), "waiter did not acquire the reap lock"
            kill_detached_children()
            waiter.join(timeout=5)
            assert not waiter.is_alive()
            assert waiter_errors == []
            assert child.returncode != 0
        finally:
            if child.poll() is None:
                child.kill()
            if started and waiter is not None:
                waiter.join(timeout=5)
            child.wait(timeout=5)


@pytest.mark.skipif(os.name != "posix", reason="no nice")
def test_a_child_started_in_low_priority_runs_nicer_and_one_outside_does_not():
    base = os.getpriority(os.PRIO_PROCESS, 0)
    probe = [sys.executable, "-c", "import os; print(os.getpriority(os.PRIO_PROCESS, 0))"]
    with low_priority(5):
        nicer = int(run(probe, capture_output=True, text=True).stdout)
    plain = int(run(probe, capture_output=True, text=True).stdout)
    assert nicer == min(19, base + 5)
    assert plain == base
