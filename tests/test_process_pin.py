"""Characterization tests that pin ``util/process.py`` behaviour no other test pins (#3932).

They pass on the code before the Runner/Child seam and must keep passing after it: the
desktop spawn path is the old ``_spawn`` body moved, not changed. Where a test needs to see
what is handed to ``subprocess.Popen`` it replaces ``Popen`` with a recorder, so it holds
for any implementation that still ends in ``subprocess.Popen``.
"""

from __future__ import annotations

import errno
import os
import shutil
import signal
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextvars import copy_context
from pathlib import Path
from typing import Any, ClassVar

import pytest

from podcast_mcp.engines.render_clock import spawn_or_too_long
from podcast_mcp.util import process
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.host_platform import IOS, MACOS, UNKNOWN, WINDOWS

_OK = [sys.executable, "-c", "pass"]


class FakeProc:
    """Stands in for ``subprocess.Popen``: records its arguments and what is done to it."""

    created: ClassVar[list[FakeProc]] = []
    next_pid = 900_000

    def __init__(self, cmd: Any, **kwargs: Any) -> None:
        self.cmd = cmd
        self.kwargs = kwargs
        type(self).next_pid += 1
        self.pid = type(self).next_pid
        self.returncode: int | None = None
        self.calls: list[str] = []
        self.exit_code = 0
        self.communicate_result: tuple[Any, Any] = (None, None)
        self.communicate_error: BaseException | None = None
        self.communicate_args: tuple[Any, Any] | None = None
        self.exited = False
        type(self).created.append(self)

    def __enter__(self) -> FakeProc:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.calls.append("exit")

    def communicate(self, input: Any = None, timeout: Any = None) -> tuple[Any, Any]:
        self.calls.append("communicate")
        self.communicate_args = (input, timeout)
        if self.communicate_error is not None:
            raise self.communicate_error
        return self.communicate_result

    def wait(self, timeout: Any = None) -> int:
        self.calls.append("wait")
        self.returncode = self.exit_code
        return self.exit_code

    def kill(self) -> None:
        self.calls.append("kill")


class ScriptedProc(FakeProc):
    """A ``FakeProc`` whose ``communicate`` behaviour a test sets before ``run`` uses it."""

    script: ClassVar[dict[str, Any]] = {}

    def __init__(self, cmd: Any, **kwargs: Any) -> None:
        super().__init__(cmd, **kwargs)
        self.exit_code = self.script.get("exit_code", 0)
        self.communicate_result = self.script.get("result", (None, None))
        self.communicate_error = self.script.get("error")


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    FakeProc.created = []
    ScriptedProc.script = {}
    yield
    process._detached.clear()


@pytest.fixture
def fake_popen(monkeypatch: pytest.MonkeyPatch) -> type[FakeProc]:
    monkeypatch.setattr(subprocess, "Popen", ScriptedProc)
    return ScriptedProc


def _only(created: list[FakeProc]) -> FakeProc:
    assert len(created) == 1
    return created[0]


# --- the public surface -------------------------------------------------------------------


def test_the_subprocess_names_are_the_stdlib_objects() -> None:
    assert process.DEVNULL is subprocess.DEVNULL
    assert process.PIPE is subprocess.PIPE
    assert process.STDOUT is subprocess.STDOUT
    assert process.CalledProcessError is subprocess.CalledProcessError
    assert process.CompletedProcess is subprocess.CompletedProcess
    assert process.TimeoutExpired is subprocess.TimeoutExpired
    assert process.Popen is subprocess.Popen


def test_spawn_unavailable_is_an_oserror() -> None:
    assert issubclass(process.SpawnUnavailableError, OSError)


def test_spawn_returns_a_real_popen_that_the_caller_owns() -> None:
    with process._spawn(_OK) as proc:
        assert isinstance(proc, subprocess.Popen)
        assert proc.wait() == 0
    with process.popen(_OK) as proc:
        assert isinstance(proc, subprocess.Popen)


# --- argv checking ------------------------------------------------------------------------


def test_argv_is_stringified_into_a_list_and_a_tuple_is_accepted(
    fake_popen: type[FakeProc],
) -> None:
    process.run((Path("/bin/tool"), 5, "x"))
    assert _only(fake_popen.created).cmd == [str(Path("/bin/tool")), "5", "x"]


def test_popen_stringifies_path_argv_and_leaves_the_caller_list_alone(
    fake_popen: type[FakeProc],
) -> None:
    argv: list[Any] = [Path("/bin/tool"), "x"]
    process.popen(argv)
    assert _only(fake_popen.created).cmd == [str(Path("/bin/tool")), "x"]
    assert argv == [Path("/bin/tool"), "x"]


def test_a_bad_argv_is_rejected_before_anything_is_spawned(fake_popen: type[FakeProc]) -> None:
    for call in (process.run, process.popen):
        with pytest.raises(TypeError):
            call(b"echo hi")  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            call(())
    assert fake_popen.created == []


def test_capture_output_with_stdout_or_stderr_is_rejected_before_spawning(
    fake_popen: type[FakeProc],
) -> None:
    with pytest.raises(ValueError, match="may not be used with capture_output"):
        process.run(_OK, capture_output=True, stderr=process.DEVNULL)
    with pytest.raises(ValueError, match="may not be used with capture_output"):
        process.run(_OK, capture_output=True, stdout=process.DEVNULL)
    assert fake_popen.created == []


# --- what the child is started with -------------------------------------------------------


def test_popen_is_called_with_exactly_these_keywords_and_never_a_shell(
    fake_popen: type[FakeProc],
) -> None:
    process.run(_OK)
    assert _only(fake_popen.created).kwargs == {
        "stdin": None,
        "stdout": None,
        "stderr": None,
        "text": None,
        "cwd": None,
        "env": None,
        "start_new_session": False,
        "shell": False,
    }


def test_run_hands_stdio_text_cwd_env_and_session_to_the_child_unchanged(
    fake_popen: type[FakeProc], tmp_path: Path
) -> None:
    sink = object()
    process.run(
        _OK,
        text=True,
        cwd=tmp_path,
        env={"A": "1"},
        stdout=sink,
        stderr=process.STDOUT,
        start_new_session=True,
    )
    kwargs = _only(fake_popen.created).kwargs
    assert (kwargs["text"], kwargs["cwd"], kwargs["env"]) == (True, tmp_path, {"A": "1"})
    assert (kwargs["stdout"], kwargs["stderr"], kwargs["start_new_session"]) == (
        sink,
        process.STDOUT,
        True,
    )


def test_popen_hands_stdio_cwd_env_and_session_to_the_child_and_has_no_text_mode(
    fake_popen: type[FakeProc], tmp_path: Path
) -> None:
    sink = object()
    process.popen(
        _OK,
        stdin=process.PIPE,
        stdout=sink,
        stderr=process.DEVNULL,
        cwd=str(tmp_path),
        env={"B": "2"},
        start_new_session=True,
    )
    kwargs = _only(fake_popen.created).kwargs
    assert kwargs["stdin"] is process.PIPE
    assert (kwargs["stdout"], kwargs["stderr"]) == (sink, process.DEVNULL)
    assert (kwargs["cwd"], kwargs["env"], kwargs["start_new_session"]) == (
        str(tmp_path),
        {"B": "2"},
        True,
    )
    assert kwargs["text"] is None
    with pytest.raises(TypeError):
        process.popen(_OK, text=True)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        process.popen(_OK, timeout=1)  # type: ignore[call-arg]


def test_capture_output_pipes_both_streams(fake_popen: type[FakeProc]) -> None:
    process.run(_OK, capture_output=True)
    kwargs = _only(fake_popen.created).kwargs
    assert kwargs["stdout"] is process.PIPE
    assert kwargs["stderr"] is process.PIPE


def test_stdin_is_a_pipe_whenever_input_is_given_even_an_empty_string(
    fake_popen: type[FakeProc],
) -> None:
    process.run(_OK)
    process.run(_OK, input="")
    process.run(_OK, input=b"")
    process.run(_OK, input=b"data")
    stdins = [proc.kwargs["stdin"] for proc in fake_popen.created]
    assert stdins == [None, process.PIPE, process.PIPE, process.PIPE]


def test_input_and_timeout_reach_communicate(fake_popen: type[FakeProc]) -> None:
    process.run(_OK, input=b"in", timeout=2.5)
    assert _only(fake_popen.created).communicate_args == (b"in", 2.5)


# --- run: waiting, errors, results --------------------------------------------------------


def test_run_returns_a_completed_process_of_the_stringified_argv_and_both_outputs(
    fake_popen: type[FakeProc],
) -> None:
    fake_popen.script = {"result": (b"out", b"err"), "exit_code": 0}
    result = process.run((Path("/bin/x"), "y"), capture_output=True)
    assert isinstance(result, subprocess.CompletedProcess)
    assert result.args == [str(Path("/bin/x")), "y"]
    assert (result.returncode, result.stdout, result.stderr) == (0, b"out", b"err")


def test_run_uncaptured_streams_are_none() -> None:
    result = process.run(_OK)
    assert (result.stdout, result.stderr, result.returncode) == (None, None, 0)


def test_run_does_not_raise_for_a_nonzero_exit_unless_check_is_set(
    fake_popen: type[FakeProc],
) -> None:
    fake_popen.script = {"exit_code": 4}
    assert process.run(_OK).returncode == 4
    assert process.run(_OK, check=False).returncode == 4


def test_check_raises_calledprocesserror_with_cmd_returncode_output_and_stderr(
    fake_popen: type[FakeProc],
) -> None:
    fake_popen.script = {"exit_code": 7, "result": ("so", "se")}
    with pytest.raises(process.CalledProcessError) as raised:
        process.run((Path("/bin/x"), "y"), check=True, capture_output=True, text=True)
    error = raised.value
    assert error.returncode == 7
    assert error.cmd == [str(Path("/bin/x")), "y"]
    assert (error.output, error.stderr) == ("so", "se")


def test_check_with_a_zero_exit_returns_normally(fake_popen: type[FakeProc]) -> None:
    assert process.run(_OK, check=True).returncode == 0


def test_run_waits_for_the_child_before_reading_its_exit_code_and_closes_it(
    fake_popen: type[FakeProc],
) -> None:
    process.run(_OK)
    assert _only(fake_popen.created).calls == ["communicate", "wait", "exit"]


def test_a_timeout_kills_then_reaps_the_child_and_reraises(fake_popen: type[FakeProc]) -> None:
    expired = process.TimeoutExpired(_OK, 1)
    fake_popen.script = {"error": expired}
    with pytest.raises(process.TimeoutExpired) as raised:
        process.run(_OK, timeout=1)
    assert raised.value is expired
    assert _only(fake_popen.created).calls == ["communicate", "kill", "wait", "exit"]


def test_any_other_exception_while_waiting_kills_the_child_without_waiting(
    fake_popen: type[FakeProc],
) -> None:
    interrupt = KeyboardInterrupt()
    fake_popen.script = {"error": interrupt}
    with pytest.raises(KeyboardInterrupt) as raised:
        process.run(_OK)
    assert raised.value is interrupt
    assert _only(fake_popen.created).calls == ["communicate", "kill", "exit"]


def test_run_takes_an_oserror_from_the_spawn_straight_to_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_a: Any, **_k: Any) -> Any:
        raise FileNotFoundError(errno.ENOENT, "nope")

    monkeypatch.setattr(subprocess, "Popen", refuse)
    with pytest.raises(FileNotFoundError):
        process.run(["definitely-not-a-program"])
    with pytest.raises(FileNotFoundError):
        process.popen(["definitely-not-a-program"])


def test_real_text_mode_decodes_and_default_is_bytes() -> None:
    cmd = [sys.executable, "-c", "print('ok')"]
    assert isinstance(process.run(cmd, capture_output=True).stdout, bytes)
    assert isinstance(process.run(cmd, capture_output=True, text=True).stdout, str)
    assert isinstance(process.run(cmd, capture_output=True, text=False).stdout, bytes)


def test_real_run_passes_cwd_env_and_stdout_file_through(tmp_path: Path) -> None:
    probe = [sys.executable, "-c", "import os; print(os.getcwd()); print(os.environ['PIN_X'])"]
    env = {**os.environ, "PIN_X": "val"}
    result = process.run(probe, capture_output=True, text=True, cwd=tmp_path, env=env)
    assert result.stdout.split() == [os.path.realpath(tmp_path), "val"]
    target = tmp_path / "out.txt"
    with target.open("w") as handle:
        process.run([sys.executable, "-c", "print('to-file')"], stdout=handle)
    assert target.read_text().strip() == "to-file"


def test_real_stderr_can_be_folded_into_stdout() -> None:
    cmd = [sys.executable, "-c", "import sys; sys.stderr.write('E'); sys.stdout.write('O')"]
    result = process.run(cmd, stdout=process.PIPE, stderr=process.STDOUT, text=True)
    assert sorted(result.stdout) == ["E", "O"]
    assert result.stderr is None


def test_real_run_reports_a_missing_program_as_filenotfounderror() -> None:
    with pytest.raises(FileNotFoundError):
        process.run(["/nonexistent/pin-tool"])


def test_real_check_error_carries_the_captured_stderr_text() -> None:
    cmd = [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(2)"]
    with pytest.raises(process.CalledProcessError) as raised:
        process.run(cmd, check=True, capture_output=True, text=True)
    assert raised.value.stderr == "boom"
    assert raised.value.returncode == 2


# --- the spawn gate -----------------------------------------------------------------------


@pytest.mark.parametrize("row", [IOS, UNKNOWN])
def test_a_host_that_cannot_spawn_refuses_before_niceness_or_detach_work(
    host, row, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    monkeypatch.setattr(shutil, "which", lambda *_a, **_k: pytest.fail("looked for nice"))
    host(row)
    with process.low_priority(5), process.detached_children():
        for call in (process.run, process.popen, process._spawn):
            with pytest.raises(process.SpawnUnavailableError):
                call(["true"])
    assert list(process._detached) == []


def test_run_argument_errors_come_before_the_spawn_gate(host) -> None:
    host(IOS)
    with pytest.raises(TypeError):
        process.run("true")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="capture_output"):
        process.run(["true"], capture_output=True, stdout=process.PIPE)


def test_the_gate_reads_the_host_on_every_call(host, fake_popen: type[FakeProc]) -> None:
    host(IOS)
    with pytest.raises(process.SpawnUnavailableError):
        process.popen(_OK)
    host(MACOS)
    process.popen(_OK)
    assert len(fake_popen.created) == 1


def test_the_gate_error_names_enosys_and_the_device_sentence(host) -> None:
    host(IOS)
    with pytest.raises(process.SpawnUnavailableError) as raised:
        process.popen(_OK)
    assert raised.value.args == (errno.ENOSYS, "This device can't start other programs.")
    assert str(raised.value) == f"[Errno {errno.ENOSYS}] This device can't start other programs."


def test_a_caller_that_catches_oserror_catches_the_gate(host) -> None:
    host(IOS)
    try:
        process.run(["true"])
    except OSError as error:
        assert error.errno == errno.ENOSYS
    else:  # pragma: no cover
        pytest.fail("no error")


# --- spawn_or_too_long: the E2BIG mapping -------------------------------------------------


def test_spawn_or_too_long_passes_the_command_kwargs_and_result_through() -> None:
    seen: list[Any] = []

    def spawn(cmd: list[str], **kwargs: Any) -> str:
        seen.append((cmd, kwargs))
        return "result"

    assert spawn_or_too_long(spawn, ["a", "b"], check=True, capture_output=True) == "result"
    assert seen == [(["a", "b"], {"check": True, "capture_output": True})]


def test_e2big_from_the_spawn_is_a_coded_error_chained_to_the_oserror() -> None:
    refusal = OSError(errno.E2BIG, "Argument list too long")

    def spawn(*_a: Any, **_k: Any) -> Any:
        raise refusal

    with pytest.raises(CodedValueError) as raised:
        spawn_or_too_long(spawn, ["x"])
    assert raised.value.code == "render_command_too_long"
    assert raised.value.__cause__ is refusal


def test_winerror_206_is_too_long_even_though_it_arrives_as_filenotfound() -> None:
    refusal = FileNotFoundError(errno.ENOENT, "missing")
    refusal.winerror = 206  # type: ignore[attr-defined]

    def spawn(*_a: Any, **_k: Any) -> Any:
        raise refusal

    with pytest.raises(CodedValueError) as raised:
        spawn_or_too_long(spawn, ["x"])
    assert raised.value.code == "render_command_too_long"


@pytest.mark.parametrize(
    "refusal",
    [
        FileNotFoundError(errno.ENOENT, "missing"),
        PermissionError(errno.EACCES, "denied"),
        OSError(errno.ENOSYS, "no spawn"),
    ],
)
def test_any_other_oserror_is_not_mapped(refusal: OSError) -> None:
    def spawn(*_a: Any, **_k: Any) -> Any:
        raise refusal

    with pytest.raises(type(refusal)) as raised:
        spawn_or_too_long(spawn, ["x"])
    assert raised.value is refusal


def test_the_spawn_gate_error_passes_spawn_or_too_long_unchanged(host) -> None:
    host(IOS)
    with pytest.raises(process.SpawnUnavailableError):
        spawn_or_too_long(process.run, ["true"])
    with pytest.raises(process.SpawnUnavailableError):
        spawn_or_too_long(process.popen, ["true"])


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="E2BIG limit is Linux's")
def test_a_real_oversized_argv_through_run_and_popen_is_render_command_too_long() -> None:
    cmd = [sys.executable, "-c", "pass", *["x" * 100_000] * 50]
    for call in (process.run, process.popen):
        with pytest.raises(CodedValueError) as raised:
            spawn_or_too_long(call, cmd)
        assert raised.value.code == "render_command_too_long"
        assert isinstance(raised.value.__cause__, OSError)
        assert raised.value.__cause__.errno == errno.E2BIG


# --- how run and popen reach _spawn -------------------------------------------------------


def test_run_and_popen_spawn_through_the_module_level_spawn_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict[str, Any]]] = []
    child = FakeProc(["fake"])

    def spawn(cmd: list[str], **kwargs: Any) -> FakeProc:
        calls.append((cmd, kwargs))
        return child

    monkeypatch.setattr(process, "_spawn", spawn)
    assert process.popen(["a", Path("b")], stdout=process.DEVNULL, cwd="/c") is child
    process.run(["d"], text=True, input="i", env={"E": "1"}, start_new_session=True)
    assert calls[0] == (
        ["a", "b"],
        {
            "stdin": None,
            "stdout": process.DEVNULL,
            "stderr": None,
            "cwd": "/c",
            "env": None,
            "start_new_session": False,
        },
    )
    assert calls[1] == (
        ["d"],
        {
            "stdin": process.PIPE,
            "stdout": None,
            "stderr": None,
            "text": True,
            "cwd": None,
            "env": {"E": "1"},
            "start_new_session": True,
        },
    )


# --- niceness -----------------------------------------------------------------------------


def _nice_path() -> str:
    nice = shutil.which("nice")
    if nice is None:
        pytest.skip("no nice on this machine")
    return nice


def test_niceness_defaults_to_zero_nests_and_restores() -> None:
    assert process.current_niceness() == 0
    with process.low_priority():
        assert process.current_niceness() == 10
        with process.low_priority(3):
            assert process.current_niceness() == 3
        assert process.current_niceness() == 10
    assert process.current_niceness() == 0


def test_niceness_is_restored_when_the_block_raises() -> None:
    with pytest.raises(RuntimeError), process.low_priority(7):
        raise RuntimeError
    assert process.current_niceness() == 0


def test_niceness_is_per_context_not_process_wide_but_copied_into_a_copied_context() -> None:
    seen: dict[str, int] = {}
    with process.low_priority(6):
        copied = copy_context()
        plain = threading.Thread(target=lambda: seen.update(plain=process.current_niceness()))
        plain.start()
        plain.join()
        copied.run(lambda: seen.update(copied=process.current_niceness()))
    assert seen == {"plain": 0, "copied": 6}


@pytest.mark.skipif(os.name != "posix", reason="no nice")
def test_a_low_priority_child_is_wrapped_in_nice_with_the_level_before_the_command(
    host, fake_popen: type[FakeProc]
) -> None:
    nice = _nice_path()
    host(MACOS)
    with process.low_priority(4):
        process.run(["tool", "-x"])
        process.popen(["tool2"])
    first, second = fake_popen.created
    assert first.cmd == [nice, "-n", "4", "tool", "-x"]
    assert second.cmd == [nice, "-n", "4", "tool2"]


def test_no_wrap_without_a_niceness_without_nice_or_off_posix(
    host, fake_popen: type[FakeProc], monkeypatch: pytest.MonkeyPatch
) -> None:
    host(MACOS)
    process.run(["plain"])
    with process.low_priority(0):
        process.run(["zero"])
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    with process.low_priority(5):
        process.run(["no-nice"])
    host(WINDOWS)
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/nice")
    with process.low_priority(5):
        process.run(["windows"])
    assert [proc.cmd for proc in fake_popen.created] == [
        ["plain"],
        ["zero"],
        ["no-nice"],
        ["windows"],
    ]


def test_the_nice_lookup_is_by_the_name_nice(
    host, fake_popen: type[FakeProc], monkeypatch: pytest.MonkeyPatch
) -> None:
    host(MACOS)
    asked: list[str] = []

    def which(name: str, *_a: Any, **_k: Any) -> str:
        asked.append(name)
        return "/x/nice"

    monkeypatch.setattr(shutil, "which", which)
    with process.low_priority(2):
        process.run(["t"])
    assert asked == ["nice"]
    assert _only(fake_popen.created).cmd == ["/x/nice", "-n", "2", "t"]


def test_the_caller_list_is_not_mutated_by_the_nice_wrap(host, fake_popen: type[FakeProc]) -> None:
    _nice_path()
    host(MACOS)
    argv = ["tool"]
    with process.low_priority(4):
        process.popen(argv)
    assert argv == ["tool"]


# --- detached children --------------------------------------------------------------------


@pytest.fixture
def killpg_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int]]:
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: calls.append((pid, sig)), raising=False)
    return calls


def test_a_detached_child_gets_a_new_session_devnull_stdin_and_is_registered(
    fake_popen: type[FakeProc],
) -> None:
    with process.detached_children():
        child = process.popen(_OK)
    kwargs = child.kwargs  # type: ignore[attr-defined]
    assert kwargs["start_new_session"] is True
    assert kwargs["stdin"] is process.DEVNULL
    assert child in process._detached


def test_a_detached_child_keeps_stdin_the_caller_chose(fake_popen: type[FakeProc]) -> None:
    with process.detached_children():
        piped = process.popen(_OK, stdin=process.PIPE)
        run_with_input = None
        process.run(_OK, input=b"x")
        run_with_input = fake_popen.created[-1]
    assert piped.kwargs["stdin"] is process.PIPE  # type: ignore[attr-defined]
    assert run_with_input.kwargs["stdin"] is process.PIPE


def test_outside_the_block_nothing_is_detached_or_registered(fake_popen: type[FakeProc]) -> None:
    child = process.popen(_OK)
    kwargs = child.kwargs  # type: ignore[attr-defined]
    assert kwargs["start_new_session"] is False
    assert kwargs["stdin"] is None
    assert list(process._detached) == []


def test_start_new_session_true_alone_does_not_register_or_null_stdin(
    fake_popen: type[FakeProc],
) -> None:
    child = process.popen(_OK, start_new_session=True)
    kwargs = child.kwargs  # type: ignore[attr-defined]
    assert kwargs["start_new_session"] is True
    assert kwargs["stdin"] is None
    assert list(process._detached) == []


def test_detach_blocks_nest_and_the_depth_is_restored_even_on_error(
    fake_popen: type[FakeProc],
) -> None:
    assert process._detach_depth == 0
    with process.detached_children():
        with process.detached_children():
            assert process._detach_depth == 2
        assert process._detach_depth == 1
        inner = process.popen(_OK)
        assert inner in process._detached
    assert process._detach_depth == 0
    with pytest.raises(RuntimeError), process.detached_children():
        raise RuntimeError
    assert process._detach_depth == 0
    assert process.popen(_OK) not in process._detached


def test_detaching_is_process_wide_so_a_pool_thread_spawns_detached_children(
    fake_popen: type[FakeProc],
) -> None:
    made: list[Any] = []
    thread = threading.Thread(target=lambda: made.append(process.popen(_OK)))
    with process.detached_children():
        thread.start()
        thread.join()
    assert made[0].kwargs["start_new_session"] is True
    assert made[0] in process._detached


def test_a_registered_child_is_dropped_once_nothing_else_holds_it(
    fake_popen: type[FakeProc],
) -> None:
    import gc

    with process.detached_children():
        process.popen(_OK)
    fake_popen.created.clear()
    gc.collect()
    assert list(process._detached) == []


def test_the_child_is_registered_before_the_spawn_lock_is_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    held: list[bool] = []

    class Probe(FakeProc):
        def __init__(self, cmd: Any, **kwargs: Any) -> None:
            super().__init__(cmd, **kwargs)
            held.append(process._detach_lock._is_owned())  # type: ignore[attr-defined]

    monkeypatch.setattr(subprocess, "Popen", Probe)
    with process.detached_children():
        process.popen(_OK)
    assert held == [True]


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_sigkills_the_process_group_of_each_live_child(
    fake_popen: type[FakeProc], killpg_calls: list[tuple[int, int]]
) -> None:
    with process.detached_children():
        first = process.popen(_OK)
        second = process.popen(_OK)
    process.kill_detached_children()
    assert sorted(killpg_calls) == sorted(
        [(first.pid, signal.SIGKILL), (second.pid, signal.SIGKILL)]  # type: ignore[attr-defined]
    )


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_skips_an_already_reaped_child(
    fake_popen: type[FakeProc], killpg_calls: list[tuple[int, int]]
) -> None:
    with process.detached_children():
        done = process.popen(_OK)
    done.returncode = 0  # type: ignore[attr-defined]
    process.kill_detached_children()
    assert killpg_calls == []


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_survives_a_group_that_is_already_gone(
    fake_popen: type[FakeProc], monkeypatch: pytest.MonkeyPatch
) -> None:
    def gone(_pid: int, _sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(os, "killpg", gone)
    with process.detached_children():
        process.popen(_OK)
    process.kill_detached_children()


def test_without_killpg_the_child_itself_is_killed(
    fake_popen: type[FakeProc], monkeypatch: pytest.MonkeyPatch
) -> None:
    with process.detached_children():
        child = process.popen(_OK)
    monkeypatch.delattr(os, "killpg", raising=False)
    process.kill_detached_children()
    assert child.calls == ["kill"]  # type: ignore[attr-defined]


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="process groups are POSIX")
def test_kill_detached_children_is_a_no_op_with_nothing_registered(
    killpg_calls: list[tuple[int, int]],
) -> None:
    process.kill_detached_children()
    assert killpg_calls == []


def test_kill_detached_children_can_run_inside_the_lock_it_takes_reentrantly() -> None:
    with process._detach_lock:
        process.kill_detached_children()


# --- pid_is_alive on POSIX ----------------------------------------------------------------


@pytest.mark.parametrize("pid", [0, -1, -4321])
def test_a_nonpositive_pid_is_reported_alive_without_a_signal(
    pid: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(os, "kill", lambda *_a: pytest.fail("signalled"))
    assert process.pid_is_alive(pid) is True


@pytest.mark.skipif(os.name != "posix", reason="POSIX liveness")
def test_posix_liveness_probes_with_signal_zero_and_only_a_missing_process_is_dead(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    host(MACOS)
    sent: list[tuple[int, int]] = []

    def kill(pid: int, sig: int) -> None:
        sent.append((pid, sig))
        raise outcomes.pop(0)

    monkeypatch.setattr(os, "kill", kill)
    outcomes: list[BaseException] = [
        ProcessLookupError(),
        PermissionError(),
        OverflowError(),
        OSError(errno.EIO, "x"),
    ]
    assert [process.pid_is_alive(77) for _ in range(4)] == [False, True, True, True]
    assert sent == [(77, 0)] * 4
    monkeypatch.setattr(os, "kill", lambda *_a: None)
    assert process.pid_is_alive(77) is True


@pytest.mark.skipif(os.name != "posix", reason="POSIX liveness")
def test_a_real_child_is_alive_until_reaped() -> None:
    with process.popen([sys.executable, "-c", "import time; time.sleep(30)"]) as child:
        assert process.pid_is_alive(child.pid) is True
        child.kill()
        child.wait()
    assert process.pid_is_alive(child.pid) is False
