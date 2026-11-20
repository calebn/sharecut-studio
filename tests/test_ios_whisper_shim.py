"""Host tests of the iOS whisper shim core (sc_whisper_core.c) against a fake glue, via ctypes."""

from __future__ import annotations

import ctypes
import errno
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from podcast_mcp.util import native_whisper

ROOT = Path(__file__).resolve().parents[1]
CORE_DIR = ROOT / "gui" / "desktop" / "src-tauri" / "ios" / "whisper"
FAKE_GLUE = ROOT / "tests" / "data" / "ios_whisper_shim" / "fake_glue.c"
SANITIZER = os.environ.get("SC_SHIM_SANITIZER", "")
BOUND_SEC = 20.0
COMPILER = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
CXX = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
GOOD = ["whisper-cli", "-m", "m.bin", "-f", "a.wav", "-ojf", "-of", "out", "-np"]

pytestmark = [
    pytest.mark.skipif(COMPILER is None, reason="no C compiler"),
    pytest.mark.skipif(sys.platform == "win32", reason="POSIX only"),
]


def _flags() -> list[str]:
    if SANITIZER == "address":
        return ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"]
    if SANITIZER == "thread":
        return ["-fsanitize=thread"]
    return []


def _cc(args: list[str]) -> None:
    assert COMPILER is not None
    done = subprocess.run([COMPILER, *args], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    assert not done.stderr.strip(), done.stderr


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    tmp = tmp_path_factory.mktemp("whisper_shim")
    common = ["-fPIC", "-g", "-O1", "-pthread", "-Wall", "-Wextra", "-I", str(CORE_DIR), *_flags()]
    _cc([*common, "-c", str(CORE_DIR / "sc_whisper_core.c"), "-o", str(tmp / "core.o")])
    _cc(
        [
            *common,
            "-include",
            "sc_whisper_exit_map.h",
            "-c",
            str(FAKE_GLUE),
            "-o",
            str(tmp / "glue.o"),
        ]
    )
    out = tmp / "libwhispershim.so"
    _cc(
        ["-shared", *_flags(), "-pthread", "-o", str(out), str(tmp / "core.o"), str(tmp / "glue.o")]
    )
    return out


class Shim:
    def __init__(self, path: Path) -> None:
        self.cdll = native_whisper.load_library(ctypes.CDLL(str(path)))
        c = self.cdll
        c.sc_whisper_start.restype = ctypes.c_int64
        c.sc_whisper_start.argtypes = [
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        ]
        c.sc_whisper_wait.restype = ctypes.c_int
        c.sc_whisper_wait.argtypes = [ctypes.c_int64]
        c.sc_whisper_cancel.restype = None
        c.sc_whisper_cancel.argtypes = [ctypes.c_int64]
        c.fake_counters.argtypes = [ctypes.POINTER(ctypes.c_int)]
        c.fake_last_argv.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]

    def start(self, argv: list[str], out_fd: int = -1, err_fd: int = -1) -> int:
        encoded = [arg.encode() for arg in argv]
        array = (ctypes.c_char_p * (len(encoded) + 1))(*encoded, None)
        return int(self.cdll.sc_whisper_start(len(encoded), array, -1, out_fd, err_fd))

    def run(self, argv: list[str]) -> tuple[int, bytes, bytes]:
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        try:
            session = self.start(argv, out_w, err_w)
            os.close(out_w)
            os.close(err_w)
            assert session >= 1, session
            code = int(self.cdll.sc_whisper_wait(session))
            return code, os.read(out_r, 65536), os.read(err_r, 65536)
        finally:
            os.close(out_r)
            os.close(err_r)

    def counters(self) -> tuple[int, int, int]:
        values = (ctypes.c_int * 3)()
        self.cdll.fake_counters(values)
        return values[0], values[1], values[2]

    def last_argv(self) -> list[str]:
        words = []
        for index in range(self.counters()[2]):
            buf = ctypes.create_string_buffer(64)
            self.cdll.fake_last_argv(index, buf, len(buf))
            words.append(buf.value.decode())
        return words


def _until(condition: Callable[[], bool]) -> None:
    tick = threading.Event()
    deadline = time.monotonic() + BOUND_SEC * 2
    while not condition():
        assert time.monotonic() < deadline, "the tool never started"
        tick.wait(0.005)


@pytest.fixture
def shim(built: Path) -> Shim:
    return Shim(built)


def test_abi_version_and_symbol_set(shim: Shim) -> None:
    assert shim.cdll.sc_whisper_abi_version() == 1


def test_sessions_get_ids_from_one_and_run_in_a_row(shim: Shim) -> None:
    first = shim.run([*GOOD, "--prompt", "echo"])
    second = shim.run([*GOOD, "--prompt", "echo"])
    assert first == second == (0, b"tool=0 out\n", b"err line\n")
    assert shim.counters()[1] >= 2


def test_good_argv_reaches_the_tool_unchanged(shim: Shim) -> None:
    assert shim.run(GOOD)[0] == 0
    assert shim.last_argv() == GOOD


@pytest.mark.parametrize("argv0", ["whisper", "ffmpeg", "whisper-cli ", "/bin/whisper-cli", ""])
def test_argv0_must_be_whisper_cli(shim: Shim, argv0: str) -> None:
    assert shim.start([argv0, "-m", "x"]) == -errno.EINVAL


def test_empty_and_null_argv_are_einval(shim: Shim) -> None:
    assert shim.cdll.sc_whisper_start(0, None, -1, -1, -1) == -errno.EINVAL
    assert shim.cdll.sc_whisper_start(1, None, -1, -1, -1) == -errno.EINVAL
    assert shim.start(["whisper-cli"], out_fd=-2) == -errno.EBADF


@pytest.mark.parametrize(
    "tail",
    [
        ["-h"],
        ["--version"],
        ["-m"],
        ["-m", "-"],
        ["-f", "-"],
        ["-of", "-"],
        ["-m", "@rsp"],
        ["-f", ""],
        ["a.wav"],
        ["-ojf", "extra.wav"],
        ["--grammar", "g.gbnf"],
        ["-oved", "x"],
        ["-t"],
    ],
)
def test_unsupported_argv_exits_1_with_one_line(shim: Shim, tail: list[str]) -> None:
    code, out, err = shim.run(["whisper-cli", *tail])
    assert (code, out) == (1, b"")
    assert err.startswith(b"sc_whisper: ") and err.count(b"\n") == 1


@pytest.mark.parametrize(
    "tail",
    [
        [
            "-m",
            "m",
            "-f",
            "a",
            "-ojf",
            "-of",
            "o",
            "-np",
            "-l",
            "en",
            "-t",
            "2",
            "--prompt",
            "-dash text",
        ],
        ["-l", "auto"],
        [],
    ],
)
def test_supported_argv_is_accepted(shim: Shim, tail: list[str]) -> None:
    assert shim.run(["whisper-cli", *tail])[0] == 0


def test_return_codes_pass_through_and_are_clamped(shim: Shim) -> None:
    assert shim.run([*GOOD, "--prompt", "ret:3"])[0] == 3
    assert shim.run([*GOOD, "--prompt", "ret:300"])[0] == 1
    assert shim.run([*GOOD, "--prompt", "ret:-2"])[0] == 1
    assert shim.run([*GOOD, "--prompt", "exit:9"])[0] == 9


def test_mapped_exit_and_abort_end_the_session_not_the_process(shim: Shim) -> None:
    assert shim.run([*GOOD, "--prompt", "exit-mapped"])[0] == 7
    assert shim.run([*GOOD, "--prompt", "abort-mapped"])[0] == 134
    assert shim.run([*GOOD, "--prompt", "echo"])[0] == 0


def test_cancel_of_a_running_session_returns_255_even_when_the_tool_returns_0(shim: Shim) -> None:
    runs_before = shim.counters()[1]
    session = shim.start([*GOOD, "--prompt", "block"])
    assert session >= 1
    _until(lambda: shim.counters()[1] > runs_before)
    began = time.monotonic()
    shim.cdll.sc_whisper_cancel(session)
    shim.cdll.sc_whisper_cancel(session)
    assert shim.cdll.sc_whisper_wait(session) == 255
    assert time.monotonic() - began < BOUND_SEC
    shim.cdll.sc_whisper_cancel(session)
    assert shim.cdll.sc_whisper_wait(session) == -errno.ESRCH
    assert shim.run([*GOOD, "--prompt", "echo"])[0] == 0


def test_cancel_of_a_queued_session_returns_255_without_running_it(shim: Shim) -> None:
    runs_before = shim.counters()[1]
    holder = shim.start([*GOOD, "--prompt", "block"])
    _until(lambda: shim.counters()[1] > runs_before)
    queued = shim.start([*GOOD, "--prompt", "echo"])
    assert holder >= 1 and queued > holder
    shim.cdll.sc_whisper_cancel(queued)
    assert shim.cdll.sc_whisper_wait(queued) == 255
    shim.cdll.sc_whisper_cancel(holder)
    assert shim.cdll.sc_whisper_wait(holder) == 255
    assert shim.counters()[1] - runs_before == 1


def test_wait_and_cancel_of_unknown_ids(shim: Shim) -> None:
    assert shim.cdll.sc_whisper_wait(10**9) == -errno.ESRCH
    shim.cdll.sc_whisper_cancel(10**9)
    shim.cdll.sc_whisper_cancel(0)


def test_cancel_from_another_thread_wakes_the_waiter(shim: Shim) -> None:
    runs_before = shim.counters()[1]
    session = shim.start([*GOOD, "--prompt", "block"])
    result: list[int] = []
    waiter = threading.Thread(target=lambda: result.append(shim.cdll.sc_whisper_wait(session)))
    waiter.start()
    _until(lambda: shim.counters()[1] > runs_before)
    shim.cdll.sc_whisper_cancel(session)
    waiter.join(BOUND_SEC)
    assert result == [255]


def test_queue_is_capped_with_eagain(shim: Shim) -> None:
    runs_before = shim.counters()[1]
    holder = shim.start([*GOOD, "--prompt", "block"])
    _until(lambda: shim.counters()[1] > runs_before)
    queued = [shim.start([*GOOD, "--prompt", "echo"]) for _ in range(16)]
    assert all(item >= 1 for item in queued)
    assert shim.start([*GOOD, "--prompt", "echo"]) == -errno.EAGAIN
    shim.cdll.sc_whisper_cancel(holder)
    assert shim.cdll.sc_whisper_wait(holder) == 255
    assert [shim.cdll.sc_whisper_wait(item) for item in queued] == [0] * 16


def test_session_streams_are_not_the_process_streams(
    shim: Shim, capfd: pytest.CaptureFixture[str]
) -> None:
    assert shim.run([*GOOD, "--prompt", "echo"])[0] == 0
    session = shim.start([*GOOD, "--prompt", "echo"])
    assert session >= 1
    assert shim.cdll.sc_whisper_wait(session) == 0
    captured = capfd.readouterr()
    assert "out" not in captured.out and "err line" not in captured.err


def test_descriptors_do_not_leak_across_sessions(shim: Shim) -> None:
    shim.run([*GOOD, "--prompt", "echo"])
    before = len(os.listdir("/proc/self/fd" if Path("/proc/self/fd").is_dir() else "/dev/fd"))
    for _ in range(20):
        shim.run([*GOOD, "--prompt", "echo"])
    after = len(os.listdir("/proc/self/fd" if Path("/proc/self/fd").is_dir() else "/dev/fd"))
    assert after <= before


@pytest.mark.skipif(CXX is None, reason="no C++ compiler")
def test_stdio_header_survives_cstdio_in_c_plus_plus(tmp_path: Path) -> None:
    source = tmp_path / "x.cpp"
    source.write_text(
        '#include <cstdio>\n#include <string>\nint f() { printf("a"); return fprintf(stderr, "c"); }\n',
        encoding="utf-8",
    )
    assert CXX is not None
    done = subprocess.run(
        [
            CXX,
            "-E",
            "-I",
            str(CORE_DIR),
            "-include",
            "sc_whisper_stdio.h",
            "-include",
            "sc_whisper_exit_map.h",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    body = done.stdout.split("int f()")[-1]
    assert 'sc_session_printf("a")' in body
    assert "sc_err()" in body
