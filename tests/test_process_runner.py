"""The spawn seam of ``util/process.py``: ``_spawn`` is replaceable, ``using_runner`` swaps it."""

from __future__ import annotations

import contextlib
import os
import select
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.util import host_platform, process
from podcast_mcp.util.host_platform import IOS
from podcast_mcp.util.process import Child, Runner, using_runner
from process_child_contract import CASES, MakeChild, run_case

DESKTOP_SPAWN = process._spawn

_SCRIPTS = {
    "echo": (
        "import os\n"
        "while True:\n"
        "    d = os.read(0, 65536)\n"
        "    if not d:\n"
        "        break\n"
        "    os.write(1, d)\n"
    ),
    "lines": (
        "import sys\n"
        "for i in range(int(sys.argv[1])):\n"
        "    sys.stdout.buffer.write(b'line %d\\n' % i)\n"
    ),
    "stderr_exit": (
        "import sys\n"
        "sys.stdout.buffer.write(sys.argv[1].encode())\n"
        "sys.stdout.buffer.flush()\n"
        "sys.stderr.buffer.write(sys.argv[2].encode())\n"
        "sys.stderr.buffer.flush()\n"
        "sys.exit(int(sys.argv[3]))\n"
    ),
    "wait_stdin": "import sys\nsys.stdin.buffer.read()\nsys.exit(int(sys.argv[1]))\n",
    "block": "import time\ntime.sleep(600)\n",
    "flood": (
        "import sys\n"
        "n, size = int(sys.argv[1]), int(sys.argv[2])\n"
        "for i in range(n):\n"
        "    sys.stdout.buffer.write(b'frame=%d\\n' % i)\n"
        "    sys.stdout.buffer.flush()\n"
        "    sys.stderr.buffer.write(b'x' * (size // n))\n"
        "    sys.stderr.buffer.flush()\n"
    ),
    "report": (
        "import os\n"
        "print('cwd=' + os.getcwd())\n"
        "print('var=' + os.environ.get('CONTRACT_VAR', ''))\n"
    ),
}


def _args(behaviour: str, params: dict[str, Any]) -> list[str]:
    if behaviour == "lines":
        return [str(params["n"])]
    if behaviour == "stderr_exit":
        return [params["out"].decode(), params["err"].decode(), str(params["code"])]
    if behaviour == "wait_stdin":
        return [str(params["code"])]
    if behaviour == "flood":
        return [str(params["lines"]), str(params["err_bytes"])]
    return []


def desktop_child(
    behaviour: str, *, cwd: Any = None, env: Any = None, **params: Any
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # nosec B603
        [sys.executable, "-c", _SCRIPTS[behaviour], *_args(behaviour, params)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
    )


class _Killed(Exception):
    pass


class _Gone(Exception):
    pass


class _Ends:
    """The child side of the three pipes, readable and writable without ever blocking for good."""

    def __init__(self, stdin_r: int, stdout_w: int, stderr_w: int, killed: threading.Event) -> None:
        self.fds = {0: stdin_r, 1: stdout_w, 2: stderr_w}
        self.killed = killed

    def read(self) -> bytes:
        while True:
            if self.killed.is_set():
                raise _Killed
            ready, _, _ = select.select([self.fds[0]], [], [], 0.02)
            if ready:
                return os.read(self.fds[0], 65536)

    def write(self, fd: int, data: bytes) -> None:
        view = memoryview(data)
        while view:
            if self.killed.is_set():
                raise _Killed
            _, ready, _ = select.select([], [self.fds[fd]], [], 0.02)
            if not ready:
                continue
            try:
                view = view[os.write(self.fds[fd], view[:65536]) :]
            except BlockingIOError:
                continue
            except BrokenPipeError:
                raise _Gone from None

    def idle(self) -> None:
        if self.killed.wait(0.02):
            raise _Killed

    def close(self) -> None:
        for fd in self.fds.values():
            with contextlib.suppress(OSError):
                os.close(fd)


def _body(behaviour: str, ends: _Ends, params: dict[str, Any], cwd: Any, env: Any) -> int:
    if behaviour == "echo":
        while data := ends.read():
            ends.write(1, data)
        return 0
    if behaviour == "lines":
        for i in range(params["n"]):
            ends.write(1, b"line %d\n" % i)
        return 0
    if behaviour == "stderr_exit":
        ends.write(1, params["out"])
        ends.write(2, params["err"])
        return int(params["code"])
    if behaviour == "wait_stdin":
        while ends.read():
            pass
        return int(params["code"])
    if behaviour == "block":
        while True:
            ends.idle()
    if behaviour == "flood":
        n = params["lines"]
        for i in range(n):
            ends.write(1, b"frame=%d\n" % i)
            ends.write(2, b"x" * (params["err_bytes"] // n))
        return 0
    if behaviour == "report":
        where = str(cwd) if cwd is not None else os.getcwd()
        var = (env if env is not None else os.environ).get("CONTRACT_VAR", "")
        ends.write(1, f"cwd={where}\nvar={var}\n".encode())
        return 0
    raise AssertionError(behaviour)


class FakeChild:
    """A pure-Python child: a thread behind three ``os.pipe`` pairs."""

    def __init__(self, behaviour: str, cwd: Any, env: Any, params: dict[str, Any]) -> None:
        stdin_r, stdin_w = os.pipe()
        stdout_r, stdout_w = os.pipe()
        stderr_r, stderr_w = os.pipe()
        os.set_blocking(stdout_w, False)
        os.set_blocking(stderr_w, False)
        self.stdin = os.fdopen(stdin_w, "wb")
        self.stdout = os.fdopen(stdout_r, "rb")
        self.stderr = os.fdopen(stderr_r, "rb")
        self.returncode: int | None = None
        self.pid: int | None = None
        self._killed = threading.Event()
        self._done = threading.Event()
        self._code = 0
        self._ends = _Ends(stdin_r, stdout_w, stderr_w, self._killed)
        self._collect: list[threading.Thread] = []
        self._collected: dict[str, bytes] = {}
        self._thread = threading.Thread(
            target=self._main, args=(behaviour, params, cwd, env), daemon=True
        )
        self._thread.start()

    def _main(self, behaviour: str, params: dict[str, Any], cwd: Any, env: Any) -> None:
        try:
            self._code = _body(behaviour, self._ends, params, cwd, env)
        except _Killed:
            self._code = -9
        except _Gone:
            self._code = -13
        finally:
            self._ends.close()
            self._done.set()

    def poll(self) -> int | None:
        if self.returncode is None and self._done.is_set():
            self.returncode = self._code
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if not self._done.wait(timeout):
            raise subprocess.TimeoutExpired("fake", timeout)  # type: ignore[arg-type]
        code = self.poll()
        assert code is not None
        return code

    def kill(self) -> None:
        if not self._done.is_set():
            self._killed.set()

    def communicate(self, input: bytes | None = None, timeout: float | None = None) -> Any:
        if not self._collect:
            self._collect.append(self._thread_of(self._feed, input))
            for name in ("stdout", "stderr"):
                self._collect.append(self._thread_of(self._read, name))
        for thread in self._collect:
            thread.join(timeout)
            if thread.is_alive():
                raise subprocess.TimeoutExpired("fake", timeout)  # type: ignore[arg-type]
        self.wait(timeout)
        return self._collected.get("stdout", b""), self._collected.get("stderr", b"")

    @staticmethod
    def _thread_of(target: Callable[..., None], *args: Any) -> threading.Thread:
        thread = threading.Thread(target=target, args=args, daemon=True)
        thread.start()
        return thread

    def _feed(self, data: bytes | None) -> None:
        try:
            if data:
                self.stdin.write(data)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                self.stdin.close()

    def _read(self, name: str) -> None:
        self._collected[name] = getattr(self, name).read()

    def __enter__(self) -> FakeChild:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stdout.close()
        self.stderr.close()
        with contextlib.suppress(BrokenPipeError):
            self.stdin.close()
        self.wait()


def fake_child(behaviour: str, *, cwd: Any = None, env: Any = None, **params: Any) -> FakeChild:
    return FakeChild(behaviour, cwd, env, params)


@pytest.fixture(autouse=True)
def desktop_spawn_restored() -> Iterator[None]:
    assert process._spawn is DESKTOP_SPAWN
    yield
    assert process._spawn is DESKTOP_SPAWN


_FACTORIES: dict[str, MakeChild] = {"desktop": desktop_child, "candidate": fake_child}


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("kind", list(_FACTORIES))
def test_child_contract(kind: str, name: str, tmp_path: Path) -> None:
    if kind == "candidate" and not host_platform.current().is_posix:
        pytest.skip("the fake child waits on pipes with select")
    run_case(name, _FACTORIES[kind], tmp_path)


def test_default_is_the_desktop_spawn(host: Callable[..., None]) -> None:
    host(IOS)
    assert process._spawn is DESKTOP_SPAWN
    with pytest.raises(process.SpawnUnavailableError):
        process.popen(["tool"])


def _runner(box: list[tuple[list[str], dict[str, Any]]] | None = None) -> Runner:
    def runner(cmd: list[str], **kwargs: Any) -> Child:
        if box is not None:
            box.append((cmd, kwargs))
        return fake_child("stderr_exit", out=b"out", err=b"err", code=0)

    return runner  # type: ignore[return-value]


def test_using_runner_swaps_and_restores() -> None:
    runner = _runner()
    with using_runner(runner):
        assert process._spawn is runner
    assert process._spawn is DESKTOP_SPAWN


def test_using_runner_restores_after_an_exception() -> None:
    runner = _runner()
    with pytest.raises(RuntimeError, match="boom"):
        with using_runner(runner):
            raise RuntimeError("boom")
    assert process._spawn is DESKTOP_SPAWN


def test_a_second_runner_is_refused_and_the_first_stays_installed() -> None:
    first, second = _runner(), _runner()
    with using_runner(first):
        with pytest.raises(RuntimeError, match="already installed"):
            with using_runner(second):
                pytest.fail("entered")
        assert process._spawn is first
    assert process._spawn is DESKTOP_SPAWN


def test_a_patched_spawn_is_not_swapped_over() -> None:
    patched = _runner()
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(process, "_spawn", patched)
        with pytest.raises(RuntimeError, match="already installed"):
            with using_runner(_runner()):
                pytest.fail("entered")
        assert process._spawn is patched


def test_installed_runner_is_seen_by_other_threads() -> None:
    seen: list[Any] = []
    runner = _runner()
    with using_runner(runner):
        thread = threading.Thread(target=lambda: seen.append(process._spawn))
        thread.start()
        thread.join()
    assert seen == [runner]


def test_run_goes_through_the_installed_runner() -> None:
    box: list[tuple[list[str], dict[str, Any]]] = []
    with using_runner(_runner(box)):
        done = process.run(["tool", Path("x")], capture_output=True, input=b"in", cwd="d")
    assert (done.stdout, done.stderr, done.args) == (b"out", b"err", ["tool", "x"])
    assert box == [
        (
            ["tool", "x"],
            {
                "stdin": process.PIPE,
                "stdout": process.PIPE,
                "stderr": process.PIPE,
                "text": None,
                "cwd": "d",
                "env": None,
                "start_new_session": False,
            },
        )
    ]


def test_popen_goes_through_the_installed_runner() -> None:
    box: list[tuple[list[str], dict[str, Any]]] = []
    with using_runner(_runner(box)):
        with process.popen(["tool", "a"], stdout=process.PIPE, start_new_session=True) as child:
            assert child.stdout.read() == b"out"
    assert box == [
        (
            ["tool", "a"],
            {
                "stdin": None,
                "stdout": process.PIPE,
                "stderr": None,
                "cwd": None,
                "env": None,
                "start_new_session": True,
            },
        )
    ]


def test_a_runner_owns_the_gate_niceness_and_detach_registry(host: Callable[..., None]) -> None:
    host(IOS)
    box: list[tuple[list[str], dict[str, Any]]] = []
    with using_runner(_runner(box)), process.low_priority(5), process.detached_children():
        process.run(["tool"], capture_output=True)
    assert [cmd for cmd, _ in box] == [["tool"]]
    assert box[0][1]["start_new_session"] is False
    assert list(process._detached) == []
