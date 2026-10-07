from __future__ import annotations

import os
import sys

import pytest

from podcast_mcp.util.process import (
    CalledProcessError,
    TimeoutExpired,
    detached_children,
    kill_detached_children,
    popen,
    run,
)

_SLEEP = [sys.executable, "-c", "import time; time.sleep(30)"]


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
