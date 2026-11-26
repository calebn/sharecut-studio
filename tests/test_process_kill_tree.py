"""Killing a child's whole tree: the process group on POSIX, ``taskkill /T`` on Windows (#1998)."""

from __future__ import annotations

import subprocess
import sys
from typing import Any

import pytest
from tests.polling import wait_for

from podcast_mcp.util import process as process_module
from podcast_mcp.util.host_platform import WINDOWS
from podcast_mcp.util.process import PIPE, detached_children, kill_child, pid_is_alive, popen

_GRANDCHILD = (
    "import subprocess, sys, time\n"
    "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "print(g.pid, flush=True)\n"
    "time.sleep(60)\n"
)


@pytest.mark.skipif(sys.platform == "win32", reason="process groups are POSIX")
def test_kill_child_kills_the_child_and_its_grandchild() -> None:
    with detached_children():
        proc = popen([sys.executable, "-c", _GRANDCHILD], stdin=PIPE, stdout=PIPE)
    assert proc.stdout is not None
    grandchild = int(proc.stdout.readline())
    assert pid_is_alive(grandchild)

    kill_child(proc)
    proc.wait(timeout=5)

    assert wait_for(lambda: not pid_is_alive(grandchild), timeout=5)
    proc.stdout.close()
    assert proc.stdin is not None
    proc.stdin.close()


def test_kill_child_ignores_a_child_that_already_exited() -> None:
    proc = popen([sys.executable, "-c", "pass"])
    proc.wait(timeout=10)

    kill_child(proc)

    assert proc.returncode == 0


def test_kill_child_without_a_pid_kills_through_the_child() -> None:
    class Pidless:
        returncode: int | None = None
        pid = None
        killed = False

        def kill(self) -> None:
            self.killed = True

    child = Pidless()
    kill_child(child)  # type: ignore[arg-type]
    assert child.killed


def test_kill_child_on_windows_kills_the_tree_with_taskkill(
    monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(WINDOWS)
    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    class Child:
        returncode: int | None = None
        pid = 4321

        def kill(self) -> None:
            pytest.fail("a Windows child is killed with its tree, not alone")

    monkeypatch.delattr("os.killpg", raising=False)
    monkeypatch.setattr(process_module.subprocess, "run", fake_run)

    kill_child(Child())  # type: ignore[arg-type]

    assert len(calls) == 1
    assert calls[0][1:] == ["/PID", "4321", "/T", "/F"]
    assert calls[0][0].lower().endswith("taskkill") or calls[0][0].lower().endswith("taskkill.exe")


def test_windows_detached_spawn_starts_a_new_process_group(
    monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(WINDOWS)
    seen: dict[str, Any] = {}

    class FakePopen:
        returncode = None
        pid = 7

        def __init__(self, cmd: list[str], **kwargs: Any) -> None:
            seen.update(kwargs)

    monkeypatch.setattr(process_module.subprocess, "Popen", FakePopen)
    monkeypatch.setattr(process_module.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200, raising=False)

    popen(["prog"], start_new_session=True)

    assert seen["creationflags"] == 0x200


def test_kill_child_on_windows_kills_the_root_alone_when_taskkill_cannot_run(
    monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(WINDOWS)

    def no_taskkill(*_a: Any, **_k: Any) -> None:
        raise FileNotFoundError("taskkill.exe")

    class Child:
        returncode: int | None = None
        pid = 4321
        killed = False

        def kill(self) -> None:
            self.killed = True

    child = Child()
    monkeypatch.delattr("os.killpg", raising=False)
    monkeypatch.setattr(process_module.subprocess, "run", no_taskkill)

    kill_child(child)  # type: ignore[arg-type]

    assert child.killed


def test_kill_child_on_windows_kills_the_root_alone_when_taskkill_fails(
    monkeypatch: pytest.MonkeyPatch, host
) -> None:
    host(WINDOWS)

    def denied(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(cmd, 1)

    class Child:
        returncode: int | None = None
        pid = 4321
        killed = False

        def kill(self) -> None:
            self.killed = True

    child = Child()
    monkeypatch.delattr("os.killpg", raising=False)
    monkeypatch.setattr(process_module.subprocess, "run", denied)

    kill_child(child)  # type: ignore[arg-type]

    assert child.killed
