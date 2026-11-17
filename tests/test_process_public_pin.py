"""Characterization of the public surface of ``util/process.py`` and of ``run``/``popen``
through the real desktop spawn, so a later runner dispatch cannot change either.

Complements ``test_process_pin.py`` (spawn arguments, gate, niceness, detach) and
``test_process.py`` (real ``run``): only what those do not cover lives here.
"""

from __future__ import annotations

import inspect
import subprocess
import sys
import threading
import time

import pytest

from podcast_mcp.engines import ffmpeg as ffmpeg_module
from podcast_mcp.util import process
from podcast_mcp.util.host_platform import IOS

_PY = [sys.executable, "-c"]


def _params(fn: object) -> dict[str, tuple[str, object]]:
    return {
        name: (p.kind.name, p.default)
        for name, p in inspect.signature(fn).parameters.items()  # type: ignore[arg-type]
    }


def test_run_signature_is_pinned() -> None:
    empty = inspect.Parameter.empty
    assert _params(process.run) == {
        "argv": ("POSITIONAL_OR_KEYWORD", empty),
        "check": ("KEYWORD_ONLY", False),
        "capture_output": ("KEYWORD_ONLY", False),
        "text": ("KEYWORD_ONLY", None),
        "input": ("KEYWORD_ONLY", None),
        "cwd": ("KEYWORD_ONLY", None),
        "env": ("KEYWORD_ONLY", None),
        "timeout": ("KEYWORD_ONLY", None),
        "stdout": ("KEYWORD_ONLY", None),
        "stderr": ("KEYWORD_ONLY", None),
        "start_new_session": ("KEYWORD_ONLY", False),
    }


def test_popen_signature_is_pinned() -> None:
    empty = inspect.Parameter.empty
    assert _params(process.popen) == {
        "argv": ("POSITIONAL_OR_KEYWORD", empty),
        "stdin": ("KEYWORD_ONLY", None),
        "stdout": ("KEYWORD_ONLY", None),
        "stderr": ("KEYWORD_ONLY", None),
        "cwd": ("KEYWORD_ONLY", None),
        "env": ("KEYWORD_ONLY", None),
        "start_new_session": ("KEYWORD_ONLY", False),
    }


def test_using_runner_and_protocol_names_are_public() -> None:
    assert list(_params(process.using_runner)) == ["runner"]
    assert inspect.isgeneratorfunction(inspect.unwrap(process.using_runner))
    for name in ("Runner", "Child"):
        assert getattr(getattr(process, name), "_is_protocol", False)
    assert list(_params(process.Runner.__call__)) == [
        "self",
        "cmd",
        "stdin",
        "stdout",
        "stderr",
        "text",
        "cwd",
        "env",
        "start_new_session",
    ]
    assert {"stdin", "stdout", "stderr", "returncode", "pid"} <= set(process.Child.__annotations__)
    assert {"poll", "wait", "communicate", "kill"} <= set(dir(process.Child))


def test_reexported_names_are_the_subprocess_objects() -> None:
    for name in (
        "DEVNULL",
        "PIPE",
        "STDOUT",
        "CalledProcessError",
        "CompletedProcess",
        "SubprocessError",
        "TimeoutExpired",
        "Popen",
    ):
        assert getattr(process, name) is getattr(subprocess, name)
    assert issubclass(process.SpawnUnavailableError, OSError)
    assert callable(process.detached_children) and callable(process.low_priority)
    assert callable(process.kill_detached_children) and callable(process.pid_is_alive)


def test_desktop_run_and_popen_use_the_desktop_spawn_and_return_real_objects() -> None:
    assert process._spawn.__name__ == "_spawn"
    done = process.run([*_PY, "pass"])
    assert type(done) is subprocess.CompletedProcess
    child = process.popen([*_PY, "pass"])
    assert type(child) is subprocess.Popen
    assert child.wait() == 0


def test_run_capture_input_text_and_check_on_a_real_child() -> None:
    code = "import sys; d = sys.stdin.buffer.read(); sys.stdout.buffer.write(d); sys.stderr.write('e'); sys.exit(4)"
    got = process.run([*_PY, code], input=b"abc", capture_output=True)
    assert (got.returncode, got.stdout, got.stderr) == (4, b"abc", b"e")
    with pytest.raises(process.CalledProcessError) as raised:
        process.run([*_PY, code], input=b"abc", capture_output=True, check=True)
    assert raised.value.returncode == 4 and raised.value.stdout == b"abc"


def test_run_timeout_kills_the_real_child() -> None:
    start = time.monotonic()
    with pytest.raises(process.TimeoutExpired):
        process.run([*_PY, "import time; time.sleep(60)"], timeout=0.3)
    assert time.monotonic() - start < 20


def test_popen_pipes_are_read_incrementally_and_the_child_can_be_killed() -> None:
    code = (
        "import sys, time\n"
        "print('one', flush=True)\n"
        "sys.stderr.write('err\\n'); sys.stderr.flush()\n"
        "time.sleep(60)\n"
    )
    child = process.popen([*_PY, code], stdout=process.PIPE, stderr=process.PIPE)
    try:
        assert child.stdout is not None and child.stderr is not None
        box: list[bytes] = []
        reader = threading.Thread(target=lambda: box.append(child.stdout.readline()))  # type: ignore[union-attr]
        reader.start()
        reader.join(30)
        assert box == [b"one\n"]
        assert child.poll() is None
        assert child.stderr.readline() == b"err\n"
        child.kill()
        assert child.wait(30) != 0
        assert child.stdout.read() == b""
    finally:
        child.kill()
        child.wait()
        for stream in (child.stdout, child.stderr):
            if stream:
                stream.close()


def test_popen_stdin_pipe_feeds_the_child() -> None:
    child = process.popen(
        [*_PY, "import sys; sys.stdout.write(sys.stdin.read().upper())"],
        stdin=process.PIPE,
        stdout=process.PIPE,
    )
    out, _ = child.communicate(b"hi", timeout=30)
    assert out == b"HI" and child.returncode == 0


@pytest.mark.parametrize("call", ["run", "popen"])
def test_ios_row_fails_closed_before_any_spawn(
    host, monkeypatch: pytest.MonkeyPatch, call: str
) -> None:
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("spawned"))
    host(IOS)
    with pytest.raises(process.SpawnUnavailableError) as raised:
        getattr(process, call)([*_PY, "pass"])
    assert isinstance(raised.value, OSError)
    assert raised.value.errno == __import__("errno").ENOSYS


def test_engine_modules_bind_run_and_popen_by_name_so_patching_them_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # tests/test_first_audio_stream_decoders.py patches ffmpeg_module.run/.popen and drives
    # the engine through them; this pins the binding that makes that possible.
    assert ffmpeg_module.run is process.run
    assert ffmpeg_module.popen is process.popen
    seen: list[object] = []
    monkeypatch.setattr(ffmpeg_module, "run", lambda argv, **kw: seen.append(argv))
    ffmpeg_module.run(["x"])
    assert seen == [["x"]]
    assert process.run is not ffmpeg_module.run
