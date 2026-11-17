"""Conformance cases for anything a spawn point may return as a ``Child``.

Importable: any child factory can run these cases:

    from process_child_contract import CASES, run_case
    run_case(name, make_child, tmp_path)

``make_child(behaviour, *, cwd=None, env=None, **params)`` returns a started child whose
stdin, stdout and stderr are all pipes carrying bytes. Behaviours (``params``):

- ``echo``: copy stdin to stdout until EOF, exit 0.
- ``lines`` (``n``): write ``line <i>\\n`` for each i below n, exit 0.
- ``stderr_exit`` (``out``, ``err``, ``code``): write both, exit with ``code``.
- ``wait_stdin`` (``code``): read stdin to EOF, exit with ``code``.
- ``block``: run until killed.
- ``flood`` (``lines``, ``err_bytes``): ``frame=<i>\\n`` on stdout, ``err_bytes`` spread over stderr.
- ``report``: write ``cwd=<dir>\\nvar=<CONTRACT_VAR>\\n`` to stdout.

Every case runs under a deadline, so a hung child fails the case instead of hanging CI.
Only behaviour a real child shares with any other is asserted; no Popen-only attribute.
"""

from __future__ import annotations

import contextlib
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from podcast_mcp.util import process
from podcast_mcp.util.process import Child

MakeChild = Callable[..., Child]

DEADLINE_SECONDS = 60.0
MIB = 1 << 20
PAYLOAD = bytes(range(256)) * (MIB // 256)


class Spy:
    """Delegates to a child, counting ``kill`` and optionally failing ``communicate``."""

    def __init__(self, child: Child, communicate_error: BaseException | None = None) -> None:
        self.child = child
        self.kills = 0
        self._communicate_error = communicate_error

    @property
    def stdin(self) -> Any:
        return self.child.stdin

    @property
    def stdout(self) -> Any:
        return self.child.stdout

    @property
    def stderr(self) -> Any:
        return self.child.stderr

    @property
    def returncode(self) -> int | None:
        return self.child.returncode

    @property
    def pid(self) -> int | None:
        return self.child.pid

    def poll(self) -> int | None:
        return self.child.poll()

    def wait(self, timeout: float | None = None) -> int:
        return self.child.wait(timeout)

    def communicate(self, input: Any = None, timeout: float | None = None) -> Any:
        if self._communicate_error is not None:
            raise self._communicate_error
        return self.child.communicate(input, timeout)

    def kill(self) -> None:
        self.kills += 1
        self.child.kill()

    def __enter__(self) -> Spy:
        self.child.__enter__()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.child.__exit__(*exc)


def _drain(stream: Any, sink: list[bytes]) -> threading.Thread:
    def pump() -> None:
        sink.append(stream.read())

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    return thread


def case_shape(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("wait_stdin", code=0)
    assert isinstance(child, Child)
    assert child.pid is None or isinstance(child.pid, int)
    assert child.returncode is None
    child.stdin.close()
    assert child.wait() == 0


def case_stdin_back_pressure(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("echo")
    failures: list[BaseException] = []

    def feed() -> None:
        try:
            child.stdin.write(PAYLOAD)
        except BaseException as exc:
            failures.append(exc)
        finally:
            child.stdin.close()

    writer = threading.Thread(target=feed, daemon=True)
    writer.start()
    assert child.stdout.read() == PAYLOAD
    writer.join()
    assert not failures
    assert child.wait() == 0


def case_stdout(make_child: MakeChild, tmp: Path) -> None:
    expected = [b"line %d\n" % i for i in range(500)]
    child = make_child("lines", n=500)
    assert list(child.stdout) == expected
    assert child.stdout.read(10) == b""
    assert child.wait() == 0

    child = make_child("lines", n=500)
    assert child.stdout.read() == b"".join(expected)
    assert child.wait() == 0


def case_stderr(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("stderr_exit", out=b"", err=b"boom\n", code=2)
    assert child.wait() == 2
    assert child.stderr.read() == b"boom\n"


def case_wait_and_poll(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("wait_stdin", code=7)
    assert child.poll() is None
    try:
        child.wait(timeout=0.2)
    except process.TimeoutExpired:
        pass
    else:
        raise AssertionError("wait(timeout) returned for a running child")
    assert child.poll() is None
    assert child.returncode is None
    child.stdin.close()
    code = child.wait()
    assert code == 7
    assert child.returncode == 7
    assert child.poll() == 7


def case_kill_unblocks_reader(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("block")
    seen: list[bytes] = []
    reader = _drain(child.stdout, seen)
    time.sleep(0.1)
    started = time.monotonic()
    child.kill()
    assert time.monotonic() - started < 2.0
    reader.join(2.0)
    assert not reader.is_alive()
    assert seen == [b""]
    child.kill()
    child.wait()
    child.kill()


def case_context_manager(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("wait_stdin", code=0)
    with child as entered:
        assert entered is child
    assert child.returncode is not None
    assert child.stdin.closed
    assert child.stdout.closed
    assert child.stderr.closed


def case_both_pipes(make_child: MakeChild, tmp: Path) -> None:
    child = make_child("flood", lines=64, err_bytes=MIB)
    err: list[bytes] = []
    drain = _drain(child.stderr, err)
    frames = [line.rstrip(b"\n") for line in child.stdout]
    drain.join()
    assert frames == [b"frame=%d" % i for i in range(64)]
    assert len(err[0]) == MIB
    assert child.wait() == 0


def case_run_contract(make_child: MakeChild, tmp: Path) -> None:
    def runner_of(
        spy_box: list[Spy], behaviour: str, error: BaseException | None = None, **params: Any
    ) -> Callable[..., Spy]:
        def runner(cmd: list[str], **kwargs: Any) -> Spy:
            spy = Spy(make_child(behaviour, **params), error)
            spy_box.append(spy)
            return spy

        return runner

    boxes: list[Spy] = []
    with process.using_runner(runner_of(boxes, "stderr_exit", out=b"out", err=b"err", code=3)):
        try:
            process.run(["tool", "arg"], check=True, capture_output=True)
        except process.CalledProcessError as exc:
            assert exc.returncode == 3
            assert exc.output == b"out"
            assert exc.stderr == b"err"
            assert exc.cmd == ["tool", "arg"]
        else:
            raise AssertionError("check=True did not raise")

    boxes = []
    with process.using_runner(runner_of(boxes, "block")):
        try:
            process.run(["tool"], capture_output=True, timeout=0.3)
        except process.TimeoutExpired:
            pass
        else:
            raise AssertionError("timeout did not raise")
    assert boxes[0].kills >= 1
    assert boxes[0].returncode is not None

    boxes = []
    interrupt = KeyboardInterrupt()
    with process.using_runner(runner_of(boxes, "block", interrupt)):
        try:
            process.run(["tool"], capture_output=True)
        except KeyboardInterrupt as exc:
            assert exc is interrupt
        else:
            raise AssertionError("KeyboardInterrupt was swallowed")
    assert boxes[0].kills == 1

    boxes = []
    with process.using_runner(runner_of(boxes, "stderr_exit", out=b"ok", err=b"", code=0)):
        done = process.run(["tool", Path("p")], capture_output=True)
    assert done.args == ["tool", "p"]
    assert done.returncode == 0
    assert done.stdout == b"ok"


def case_argv_cwd_env(make_child: MakeChild, tmp: Path) -> None:
    seen: list[tuple[list[str], dict[str, Any]]] = []

    def runner(cmd: list[str], **kwargs: Any) -> Child:
        seen.append((cmd, kwargs))
        return make_child("report", cwd=kwargs.get("cwd"), env=kwargs.get("env"))

    env = {**os.environ, "CONTRACT_VAR": "on"}
    with process.using_runner(runner):
        child = process.popen(["tool", Path("p"), 3], cwd=tmp, env=env)  # type: ignore[list-item]
        report = child.stdout.read().decode().splitlines()
        child.wait()
    cmd, kwargs = seen[0]
    assert cmd == ["tool", "p", "3"]
    assert all(type(part) is str for part in cmd)
    assert set(kwargs) == {"stdin", "stdout", "stderr", "cwd", "env", "start_new_session"}
    assert Path(report[0].removeprefix("cwd=")).resolve() == tmp.resolve()
    assert report[1] == "var=on"


CASES: dict[str, Callable[..., None]] = {
    "shape": case_shape,
    "stdin_back_pressure": case_stdin_back_pressure,
    "stdout": case_stdout,
    "stderr": case_stderr,
    "wait_and_poll": case_wait_and_poll,
    "kill_unblocks_reader": case_kill_unblocks_reader,
    "context_manager": case_context_manager,
    "both_pipes": case_both_pipes,
    "run_contract": case_run_contract,
    "argv_cwd_env": case_argv_cwd_env,
}


def run_case(name: str, make_child: MakeChild, tmp: Path) -> None:
    """Run one case under a deadline; kill every child it made and restore the spawn point."""
    made: list[Child] = []

    def tracked(behaviour: str, **params: Any) -> Child:
        child = make_child(behaviour, **params)
        made.append(child)
        return child

    outcome: list[BaseException] = []

    def body() -> None:
        try:
            CASES[name](tracked, tmp)
        except BaseException as exc:
            outcome.append(exc)

    installed = process._spawn
    worker = threading.Thread(target=body, daemon=True, name=f"contract-{name}")
    worker.start()
    try:
        worker.join(DEADLINE_SECONDS)
        hung = worker.is_alive()
    finally:
        process._spawn = installed
        for child in made:
            with contextlib.suppress(Exception):
                child.kill()
    if hung:
        raise AssertionError(f"{name} did not finish within {DEADLINE_SECONDS}s")
    if outcome:
        raise outcome[0]
