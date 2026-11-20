"""Host tests of the iOS FFmpeg shim core (sc_ffmpeg_core.c) against a fake glue, via ctypes."""

from __future__ import annotations

import ast
import ctypes
import errno
import fcntl
import os
import random
import re
import select
import shutil
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.util import native_ffmpeg
from podcast_mcp.util.native_ffmpeg import NativeFFmpegBackend, NativeFFmpegUnavailable
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, Streams

ROOT = Path(__file__).resolve().parents[1]
CORE_DIR = ROOT / "gui" / "desktop" / "src-tauri" / "ios" / "ffmpeg"
FAKE_GLUE = ROOT / "tests" / "data" / "ios_ffmpeg_shim" / "fake_glue.c"
SANITIZER = os.environ.get("SC_SHIM_SANITIZER", "")
BOUND_SEC = 20.0
HAS_PROC_FD = Path("/proc/self/fd").is_dir()
FD_DIR = "/proc/self/fd" if HAS_PROC_FD else "/dev/fd"
COMPILER = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
LAUNCH_SEC = 0.25

pytestmark = [
    pytest.mark.skipif(COMPILER is None, reason="no C compiler"),
    pytest.mark.skipif(sys.platform == "win32", reason="POSIX only"),
]


def _compile(out: Path, sources: list[Path | str], flags: list[str], tmp: Path) -> None:
    files: list[str] = []
    for index, source in enumerate(sources):
        if isinstance(source, Path):
            files.append(str(source))
        else:
            path = tmp / f"{out.stem}_{index}.c"
            path.write_text(source, encoding="utf-8")
            files.append(str(path))
    assert COMPILER is not None
    command = [COMPILER, "-shared", "-fPIC", "-g", "-O1", "-pthread", "-Wall", "-Wextra"]
    command += ["-I", str(CORE_DIR), *flags, "-o", str(out), *files]
    done = subprocess.run(command, capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    assert not (done.stderr.strip() and all(isinstance(s, Path) for s in sources)), done.stderr


def _ubsan_builds(tmp: Path) -> bool:
    probe = tmp / "probe.so"
    try:
        _compile(
            probe,
            ["int probe(void) { return 1; }\n"],
            ["-fsanitize=undefined", "-fno-sanitize-recover=all"],
            tmp,
        )
        return ctypes.CDLL(str(probe)).probe() == 1
    except (AssertionError, OSError):
        return False


def _core_flags(tmp: Path) -> list[str]:
    if SANITIZER == "address":
        return ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"]
    if SANITIZER == "thread":
        return ["-fsanitize=thread"]
    if _ubsan_builds(tmp):
        return ["-fsanitize=undefined", "-fno-sanitize-recover=all"]
    return []


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    tmp = tmp_path_factory.mktemp("shim_build")
    out = tmp / "libscshim.so"
    _compile(out, [CORE_DIR / "sc_ffmpeg_core.c", FAKE_GLUE], _core_flags(tmp), tmp)
    return out


def fd_count() -> int:
    return len(os.listdir(FD_DIR))


def read_until(fd: int, marker: bytes | None = None, timeout: float = BOUND_SEC) -> bytes:
    deadline = time.monotonic() + timeout
    data = b""
    while True:
        left = deadline - time.monotonic()
        assert left > 0, f"timed out reading fd {fd}, got {data!r}"
        if not select.select([fd], [], [], left)[0]:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            return data
        data += chunk
        if marker is not None and marker in data:
            return data


class Pipes:
    def __init__(self) -> None:
        self.in_r, self.in_w = os.pipe()
        self.out_r, self.out_w = os.pipe()
        self.err_r, self.err_w = os.pipe()
        self.open = {self.in_r, self.in_w, self.out_r, self.out_w, self.err_r, self.err_w}

    @property
    def child_fds(self) -> tuple[int, int, int]:
        return self.in_r, self.out_w, self.err_w

    def close_fd(self, fd: int) -> None:
        if fd in self.open:
            self.open.discard(fd)
            os.close(fd)

    def hand_over(self) -> None:
        for fd in self.child_fds:
            self.close_fd(fd)

    def close(self) -> None:
        for fd in list(self.open):
            self.close_fd(fd)

    def __enter__(self) -> Pipes:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class Shim:
    def __init__(self, cdll: ctypes.CDLL) -> None:
        self.cdll = native_ffmpeg.load_library(cdll)
        c = self.cdll
        c.sc_ffmpeg_start.restype = ctypes.c_int64
        c.sc_ffmpeg_start.argtypes = [
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        ]
        c.sc_ffmpeg_wait.restype = ctypes.c_int
        c.sc_ffmpeg_wait.argtypes = [ctypes.c_int64]
        c.sc_ffmpeg_cancel.restype = None
        c.sc_ffmpeg_cancel.argtypes = [ctypes.c_int64]
        c.fake_counters.argtypes = [ctypes.POINTER(ctypes.c_int)]
        c.fake_order.argtypes = [ctypes.c_char_p, ctypes.c_int]
        c.fake_release.restype = None
        c.fake_stray_write.restype = None
        c.fake_last_argc.restype = ctypes.c_int
        c.fake_reused_fd.restype = ctypes.c_int
        c.fake_set_reset_delay_ms.argtypes = [ctypes.c_int]
        c.fake_reset_starts.restype = ctypes.c_int
        c.fake_big_writes.restype = ctypes.c_int

    def start_raw(self, array: Any, argc: int, in_fd: int, out_fd: int, err_fd: int) -> int:
        return self.cdll.sc_ffmpeg_start(argc, array, in_fd, out_fd, err_fd)

    def start(self, argv: list[str], in_fd: int = -1, out_fd: int = -1, err_fd: int = -1) -> int:
        encoded = [arg.encode() for arg in argv]
        array = (ctypes.c_char_p * (len(encoded) + 1))(*encoded, None)
        return self.start_raw(array, len(encoded), in_fd, out_fd, err_fd)

    def launch(self, argv: list[str], pipes: Pipes) -> int:
        session = self.start(argv, *pipes.child_fds)
        pipes.hand_over()
        return session

    def wait(self, session: int) -> int:
        return self.cdll.sc_ffmpeg_wait(session)

    def cancel(self, session: int) -> None:
        self.cdll.sc_ffmpeg_cancel(session)

    def release(self) -> None:
        self.cdll.fake_release()

    def counters(self) -> tuple[int, int, int]:
        values = (ctypes.c_int * 3)()
        self.cdll.fake_counters(values)
        return values[0], values[1], values[2]

    def order(self) -> list[str]:
        buf = ctypes.create_string_buffer(8192)
        self.cdll.fake_order(buf, len(buf))
        return [part for part in buf.value.decode().split(",") if part]

    def run(self, argv: list[str], data: bytes = b"") -> tuple[int, bytes, bytes]:
        with Pipes() as pipes:
            if data:
                os.write(pipes.in_w, data)
            pipes.close_fd(pipes.in_w)
            session = self.launch(argv, pipes)
            assert session >= 1, session
            code = self.wait(session)
            return code, read_until(pipes.out_r), read_until(pipes.err_r)

    def hold(self, tag: str, pipes: Pipes) -> int:
        session = self.launch(["ffmpeg", "started", f"tag:{tag}", "hold"], pipes)
        assert session >= 1
        read_until(pipes.err_r, b"started\n")
        return session


@pytest.fixture(scope="module")
def shim(built: Path) -> Shim:
    for fd in inheritable("/dev/null"):
        os.set_inheritable(fd, False)
    instance = Shim(ctypes.CDLL(str(built)))
    code, out, _ = instance.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0\n")
    return instance


def wait_for(predicate: Any, what: str, timeout: float = BOUND_SEC) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        select.select([], [], [], 0.005)


def numbers(lines: list[str]) -> list[int]:
    return [int(m.group(2)) for line in lines if (m := re.fullmatch(r"(pipe|fd):(\d+)", line))]


def normalise(lines: list[str]) -> list[str]:
    return [re.sub(r"^(pipe|fd):\d+$", r"\1:#", line) for line in lines]


def test_abi_version_and_symbols(shim: Shim) -> None:
    assert shim.cdll.sc_ffmpeg_abi_version() == 1
    assert native_ffmpeg.ABI_VERSION == 1


def test_queue_order_ids_and_start_latency(shim: Shim) -> None:
    sessions: list[int] = []
    with Pipes() as first, Pipes() as second, Pipes() as third:
        t0 = time.monotonic()
        sessions.append(shim.hold("1", first))
        sessions.append(shim.launch(["ffmpeg", "tag:2", "echo"], second))
        sessions.append(shim.launch(["ffprobe", "tag:3", "echo"], third))
        assert time.monotonic() - t0 < LAUNCH_SEC + 2.0
        t1 = time.monotonic()
        extra = Pipes()
        sessions.append(shim.launch(["ffmpeg", "tag:4"], extra))
        extra.close()
        assert time.monotonic() - t1 < LAUNCH_SEC
        assert sessions == sorted(set(sessions)) and sessions[0] >= 1
        assert shim.order()[-1:] == ["1"]
        shim.release()
        assert [shim.wait(s) for s in sessions] == [0, 0, 0, 0]
        assert shim.order()[-4:] == ["1", "2", "3", "4"]
        assert read_until(third.out_r).startswith(b"tool=1\n")
    next_session = shim.start(["ffmpeg"])
    assert next_session > sessions[-1]
    assert shim.wait(next_session) == 0


def test_wait_claims_once_and_unknown_is_esrch(shim: Shim) -> None:
    session = shim.start(["ffmpeg", "echo"])
    assert shim.wait(session) == 0
    assert shim.wait(session) == -errno.ESRCH
    assert shim.wait(10**12) == -errno.ESRCH
    shim.cancel(session)
    shim.cancel(10**12)


def test_queue_cap_returns_eagain_without_leaking(shim: Shim) -> None:
    with Pipes() as blocker:
        running = shim.hold("cap", blocker)
        queued = [shim.start(["ffmpeg", "echo"]) for _ in range(16)]
        assert all(s >= 1 for s in queued)
        before = fd_count()
        with Pipes() as pipes:
            inside = fd_count()
            assert shim.start(["ffmpeg", "echo"], *pipes.child_fds) == -errno.EAGAIN
            assert fd_count() == inside
        assert fd_count() == before
        shim.release()
        assert shim.wait(running) == 0
        assert [shim.wait(s) for s in queued] == [0] * 16


def test_start_validation_leaves_no_fds(shim: Shim) -> None:
    before = fd_count()
    assert shim.start([]) == -errno.EINVAL
    assert shim.start(["ffmpeg"], -2) == -errno.EBADF
    assert shim.start(["ffmpeg"], 9999) == -errno.EBADF
    assert shim.start(["sh", "-c", "true"]) == -errno.EINVAL
    holes = (ctypes.c_char_p * 3)(b"ffmpeg", None, None)
    assert shim.start_raw(holes, 2, -1, -1, -1) == -errno.EINVAL
    assert shim.start_raw(None, 1, -1, -1, -1) == -errno.EINVAL
    huge = (ctypes.c_char_p * 2)(b"ffmpeg", None)
    assert shim.start_raw(huge, 1 << 20, -1, -1, -1) == -errno.EINVAL
    with Pipes() as pipes:
        assert shim.start(["ffmpeg"], pipes.in_r, 9999, pipes.err_w) == -errno.EBADF
    assert fd_count() == before


def test_argv_is_copied_at_start(shim: Shim) -> None:
    buffers = [ctypes.create_string_buffer(text) for text in (b"ffmpeg", b"tag:copy", b"echo")]
    with Pipes() as blocker, Pipes() as pipes:
        running = shim.hold("copy-blocker", blocker)
        raw = (ctypes.c_char_p * 4)()
        for i, b in enumerate(buffers):
            raw[i] = ctypes.cast(b, ctypes.c_char_p)
        session = shim.start_raw(raw, 3, -1, pipes.out_w, -1)
        pipes.close_fd(pipes.out_w)
        for b in buffers:
            ctypes.memset(b, ord("X"), len(b.value))
        shim.release()
        assert shim.wait(running) == 0 and shim.wait(session) == 0
        assert read_until(pipes.out_r).splitlines() == [
            b"tool=0",
            b"ffmpeg",
            b"-nostdin",
            b"tag:copy",
            b"echo",
        ]


def test_session_streams_reach_the_caller(shim: Shim) -> None:
    code, out, err = shim.run(
        ["ffmpeg", "progress", "echo", "-i", "pipe:0", "-progress", "pipe:2", "x.wav"]
    )
    assert code == 0
    assert err == b"progress=continue\n" * 3
    assert out.splitlines()[:3] == [b"tool=0", b"ffmpeg", b"-nostdin"]
    code, out, err = shim.run(["ffmpeg", "writeout", "-i", "-", "-f", "wav", "-"], b"in")
    assert (code, err) == (0, b"")
    assert out == b"payload"
    code, out, err = shim.run(["ffprobe", "readin", "-i", "pipe:0"], b"z" * 30000)
    assert (code, err) == (0, b"") and out == b"bytes=30000\n"


def test_fd_counts_equal_after_200_sessions(shim: Shim) -> None:
    before = fd_count()
    for i in range(200):
        argv = ["ffmpeg", "echo", "-i", "pipe:0", "-progress", "pipe:2", "pipe:1"]
        data = b""
        if i % 3 == 0:
            argv.insert(1, "readin")
            data = b"x" * 1000
        elif i % 3 == 1:
            argv = ["ffprobe", "echo", "-i", "-"]
        code, _, _ = shim.run(argv, data)
        assert code == 0
    assert fd_count() == before


CLOSED_FD_SCRIPT = textwrap.dedent(
    """
    import ctypes, fcntl, os, sys
    lib = ctypes.CDLL(sys.argv[1])
    lib.sc_ffmpeg_start.restype = ctypes.c_int64
    lib.sc_ffmpeg_start.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)] + [ctypes.c_int] * 3
    lib.sc_ffmpeg_wait.argtypes = [ctypes.c_int64]
    for fd in (0, 1, 2):
        os.close(fd)
    ends = [os.pipe() for _ in range(3)]
    moved = [(fcntl.fcntl(r, fcntl.F_DUPFD, 10), fcntl.fcntl(w, fcntl.F_DUPFD, 10)) for r, w in ends]
    for r, w in ends:
        os.close(r)
        os.close(w)
    (in_r, in_w), (out_r, out_w), (err_r, err_w) = moved
    argv = [b"ffmpeg", b"echo", b"-i", b"pipe:0", b"-progress", b"pipe:2", b"pipe:1", None]
    array = (ctypes.c_char_p * len(argv))(*argv)
    session = lib.sc_ffmpeg_start(len(argv) - 1, array, in_r, out_w, err_w)
    assert session >= 1, session
    for fd in (in_r, out_w, err_w):
        os.close(fd)
    code = lib.sc_ffmpeg_wait(session)
    for fd in (0, 1, 2):
        try:
            os.fstat(fd)
        except OSError:
            continue
        os._exit(3)
    data = b""
    while chunk := os.read(out_r, 4096):
        data += chunk
    with open(sys.argv[2], "w") as report:
        report.write(repr((code, data.decode().split())))
    os._exit(0)
    """
)


def test_dup_never_lands_on_0_to_2(built: Path, tmp_path: Path) -> None:
    script = tmp_path / "closed_fd.py"
    script.write_text(CLOSED_FD_SCRIPT, encoding="utf-8")
    report = tmp_path / "report.txt"
    done = subprocess.run(
        [sys.executable, "-I", str(script), str(built), str(report)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
        env=os.environ,
    )
    assert done.returncode == 0, done.stderr
    code, words = ast.literal_eval(report.read_text(encoding="utf-8"))
    assert code == 0
    assert words[:3] == ["tool=0", "ffmpeg", "-nostdin"]
    copies = numbers(words)
    assert len(copies) == 3 and len(set(copies)) == 3
    assert all(n >= 3 for n in copies)


def test_cancel_queued_session_never_runs(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as blocker, Pipes() as queued:
        running = shim.hold("q-run", blocker)
        victim = shim.launch(["ffmpeg", "tag:victim", "echo", "-i", "pipe:0", "pipe:1"], queued)
        runs = shim.counters()[1]
        held = fd_count()
        shim.cancel(victim)
        shim.cancel(victim)
        assert fd_count() == held - 5
        assert shim.wait(victim) == 255
        assert read_until(queued.out_r) == b""
        shim.release()
        assert shim.wait(running) == 0
        assert "victim" not in shim.order()
        assert shim.counters()[1] == runs
    assert fd_count() == before


def test_cancel_running_session_interrupts_and_is_prompt(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.hold("running", pipes)
        interrupts = shim.counters()[2]
        t0 = time.monotonic()
        shim.cancel(session)
        assert time.monotonic() - t0 < 1.0
        shim.cancel(session)
        assert shim.wait(session) == 255
        assert shim.counters()[2] == interrupts + 1
        shim.cancel(session)
        assert read_until(pipes.out_r) == b""
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")


def test_cancel_running_session_closes_its_originals_at_once(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "started", "stubborn"], pipes)
        read_until(pipes.err_r, b"started\n")
        held = fd_count()
        shim.cancel(session)
        assert fd_count() == held - 3
        shim.release()
        shim.wait(session)
    assert fd_count() == before


def test_cancel_during_slow_reset_is_not_lost(shim: Shim) -> None:
    with Pipes() as pipes:
        shim.cdll.fake_set_reset_delay_ms(300)
        try:
            starts = shim.cdll.fake_reset_starts()
            session = shim.launch(["ffmpeg", "started", "block"], pipes)
            wait_for(lambda: shim.cdll.fake_reset_starts() > starts, "the slow reset to start")
            shim.cancel(session)
            assert shim.wait(session) == 255
        finally:
            shim.cdll.fake_set_reset_delay_ms(0)


def test_argc_one_still_gets_nostdin(shim: Shim) -> None:
    assert shim.run(["ffmpeg"])[0] == 0
    assert shim.cdll.fake_last_argc() == 2
    assert shim.run(["ffprobe"])[0] == 0
    assert shim.cdll.fake_last_argc() == 1


def test_copy_number_reused_by_the_tool_is_not_closed(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "reuse", "pipe:1"], pipes)
        assert shim.wait(session) == 0
    reused = shim.cdll.fake_reused_fd()
    assert reused >= 3
    os.fstat(reused)
    os.close(reused)


def test_cancel_running_session_blocked_reading_input(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffprobe", "started", "readin", "-i", "pipe:0"], pipes)
        read_until(pipes.err_r, b"started\n")
        shim.cancel(session)
        assert shim.wait(session) == 255
        assert read_until(pipes.err_r) == b""
    assert fd_count() == before


def cancel_until_done(shim: Shim, session: int, seconds: float = 10.0) -> int:
    result: list[int] = []
    thread = threading.Thread(target=lambda: result.append(shim.wait(session)), daemon=True)
    thread.start()
    deadline = time.monotonic() + seconds
    while not result and time.monotonic() < deadline:
        shim.cancel(session)
        thread.join(0.01)
    assert result, "the session stayed blocked across repeated cancels"
    return result[0]


def test_cancel_wakes_a_worker_blocked_in_a_plain_read(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffprobe", "started", "readblock", "-i", "pipe:0"], pipes)
        read_until(pipes.err_r, b"started\n")
        assert cancel_until_done(shim, session) == 255
        assert read_until(pipes.err_r) == b""
    assert fd_count() == before
    code, out, _ = shim.run(["ffprobe", "echo"])
    assert code == 0 and out.startswith(b"tool=1")


def test_cancel_wakes_a_worker_blocked_in_a_plain_write(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        writes = shim.cdll.fake_big_writes()
        session = shim.launch(["ffmpeg", "started", "writeblock"], pipes)
        read_until(pipes.err_r, b"started\n")
        wait_for(lambda: shim.cdll.fake_big_writes() > writes, "the big write to start")
        assert cancel_until_done(shim, session) == 255
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")
    assert fd_count() == before


BLOCKED_MASK_SCRIPT = textwrap.dedent(
    """
    import ctypes, os, select, signal, sys, threading
    lib = ctypes.CDLL(sys.argv[1])
    lib.sc_ffmpeg_start.restype = ctypes.c_int64
    lib.sc_ffmpeg_start.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)] + [ctypes.c_int] * 3
    lib.sc_ffmpeg_wait.argtypes = [ctypes.c_int64]
    lib.sc_ffmpeg_cancel.argtypes = [ctypes.c_int64]
    in_r, in_w = os.pipe()
    err_r, err_w = os.pipe()
    out_r, out_w = os.pipe()
    argv = [b"ffprobe", b"started", b"readblock", b"-i", b"pipe:0", None]
    array = (ctypes.c_char_p * len(argv))(*argv)
    box = []
    def creator():
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR2})
        box.append(lib.sc_ffmpeg_start(len(argv) - 1, array, in_r, out_w, err_w))
    maker = threading.Thread(target=creator)
    maker.start()
    maker.join()
    session = box[0]
    assert session >= 1, session
    for fd in (in_r, out_w, err_w):
        os.close(fd)
    seen = b""
    while not seen.endswith(b"started\\n"):
        assert select.select([err_r], [], [], 20)[0]
        seen += os.read(err_r, 4096)
    result = []
    waiter = threading.Thread(target=lambda: result.append(lib.sc_ffmpeg_wait(session)), daemon=True)
    waiter.start()
    for _ in range(1000):
        lib.sc_ffmpeg_cancel(session)
        waiter.join(0.01)
        if result:
            break
    os._exit(0 if result == [255] else 3)
    """
)


def test_cancel_wakes_a_read_when_the_creating_thread_blocks_sigusr2(
    built: Path, tmp_path: Path
) -> None:
    script = tmp_path / "blocked_mask.py"
    script.write_text(BLOCKED_MASK_SCRIPT, encoding="utf-8")
    done = subprocess.run(
        [sys.executable, "-I", str(script), str(built)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
        env=os.environ,
    )
    assert done.returncode == 0, done.stderr


def test_owner_thread_exit_returns_its_code(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffprobe", "exit:3"], pipes)
        assert shim.wait(session) == 3
    with Pipes() as pipes:
        session = shim.launch(["ffprobe", "exit:300"], pipes)
        assert shim.wait(session) == 300 & 0xFF
    assert shim.run(["ffprobe", "ret:7"])[0] == 7
    assert shim.run(["ffprobe", "ret:-1"])[0] == 1
    assert shim.run(["ffprobe", "ret:256"])[0] == 1
    code, out, _ = shim.run(["ffprobe", "echo"])
    assert code == 0 and out.startswith(b"tool=1")
    assert fd_count() == before


def test_non_owner_thread_exit_marks_failed_and_keeps_the_process(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "thread-exit:7", "-i", "pipe:0"], pipes)
        assert shim.wait(session) == 1
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")
    assert fd_count() == before


def finish_within(shim: Shim, session: int, seconds: float) -> int | None:
    result: list[int] = []
    thread = threading.Thread(target=lambda: result.append(shim.wait(session)), daemon=True)
    thread.start()
    thread.join(seconds)
    return result[0] if result else None


def test_writes_after_cancel_go_to_discard_and_never_block(shim: Shim) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "started", "waitint", "bigerr", "bigout"], pipes)
        read_until(pipes.err_r, b"started\n")
        shim.cancel(session)
        assert finish_within(shim, session, 5.0) == 0
        assert read_until(pipes.err_r, timeout=2.0) == b""
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")
    assert fd_count() == before


def test_randomized_stray_writes_after_the_session_ended_never_touch_a_freed_file(
    shim: Shim,
) -> None:
    before = fd_count()
    with Pipes() as first:
        session = shim.launch(["ffmpeg", "capture", "echo"], first)
        assert shim.wait(session) == 0
        assert read_until(first.out_r).startswith(b"tool=0\n")
        assert read_until(first.err_r) == b""
        strays = [threading.Thread(target=shim.cdll.fake_stray_write) for _ in range(4)]
        for thread in strays:
            thread.start()
        for _ in range(5):
            code, out, _ = shim.run(["ffmpeg", "echo"])
            assert code == 0 and out.startswith(b"tool=0\n")
        for thread in strays:
            thread.join(BOUND_SEC)
            assert not thread.is_alive()
        shim.cdll.fake_stray_write()
        assert read_until(first.out_r, timeout=2.0) == b""
        assert read_until(first.err_r, timeout=2.0) == b""
    assert fd_count() == before


def test_output_the_tool_never_flushed_still_reaches_its_own_session(shim: Shim) -> None:
    code, out, _ = shim.run(["ffmpeg", "unflushed"])
    assert code == 0 and out == b"unflushed\n"


def test_buffered_stray_output_is_dropped_before_the_next_session_starts(shim: Shim) -> None:
    with Pipes() as first:
        session = shim.launch(["ffmpeg", "capture"], first)
        assert shim.wait(session) == 0
        shim.cdll.fake_stray_write()
        assert read_until(first.out_r) == b""
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0\n")


def fd_links() -> dict[int, str]:
    links = {}
    for name in os.listdir(FD_DIR):
        try:
            links[int(name)] = os.readlink(f"{FD_DIR}/{name}")
        except OSError:
            continue
    return links


def inheritable(target: str) -> list[int]:
    return [
        fd
        for fd, link in fd_links().items()
        if fd >= 3 and link == target and os.get_inheritable(fd)
    ]


@pytest.mark.skipif(
    not HAS_PROC_FD,
    reason="needs /proc/self/fd symlinks; /dev/fd entries are not symlinks on macOS "
    "and pipes have no portable path there",
)
def test_the_persistent_stream_descriptors_never_leak_into_children(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.hold("cloexec", pipes)
        try:
            pipe = f"pipe:[{os.fstat(pipes.out_r).st_ino}]"
            assert list(fd_links().values()).count(pipe) >= 2
            assert inheritable(pipe) == []
        finally:
            shim.release()
        assert shim.wait(session) == 0
    assert list(fd_links().values()).count("/dev/null") >= 3
    assert inheritable("/dev/null") == []


def test_writes_after_non_owner_exit_go_to_discard(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "thread-exit:7", "bigerr"], pipes)
        assert finish_within(shim, session, 5.0) == 1
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")


EXHAUST_SCRIPT = textwrap.dedent(
    """
    import ctypes, errno, os, resource, sys
    lib = ctypes.CDLL(sys.argv[1])
    lib.sc_ffmpeg_start.restype = ctypes.c_int64
    lib.sc_ffmpeg_start.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)] + [ctypes.c_int] * 3
    lib.sc_ffmpeg_wait.argtypes = [ctypes.c_int64]
    lib.sc_out.restype = ctypes.c_void_p
    lib.sc_err.restype = ctypes.c_void_p
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, hard))
    held = []
    while True:
        try:
            held.append(os.open("/dev/null", os.O_RDONLY))
        except OSError as exc:
            assert exc.errno == errno.EMFILE
            break
    def count():
        total = 0
        for fd in range(64):
            try:
                os.fstat(fd)
                total += 1
            except OSError:
                pass
        return total
    argv = [b"ffmpeg", b"echo", None]
    array = (ctypes.c_char_p * len(argv))(*argv)
    before = count()
    result = lib.sc_ffmpeg_start(2, array, -1, -1, -1)
    assert result == -errno.EMFILE, result
    after = count()
    assert after == before, (before, after)
    assert lib.sc_out() and lib.sc_err()
    for _ in (1, 2):
        os.close(held.pop())
        mark = count()
        assert lib.sc_ffmpeg_start(2, array, -1, -1, -1) == -errno.EMFILE
        assert count() == mark
    os.close(held.pop())
    session = lib.sc_ffmpeg_start(2, array, -1, -1, -1)
    assert session >= 1, session
    assert lib.sc_ffmpeg_wait(session) == 0
    assert lib.sc_out() and lib.sc_err()
    """
)


def test_start_under_fd_exhaustion_fails_cleanly_and_streams_stay_valid(
    built: Path, tmp_path: Path
) -> None:
    script = tmp_path / "exhaust.py"
    script.write_text(EXHAUST_SCRIPT, encoding="utf-8")
    done = subprocess.run(
        [sys.executable, "-I", str(script), str(built)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
        env=os.environ,
    )
    assert done.returncode == 0, done.stderr


POLICY_OK = [
    (
        ["ffmpeg", "echo", "-i", "pipe:0", "-f", "wav", "pipe:1"],
        ["tool=0", "ffmpeg", "-nostdin", "echo", "-i", "pipe:#", "-f", "wav", "pipe:#"],
    ),
    (
        ["ffmpeg", "echo", "-i", "-", "-"],
        ["tool=0", "ffmpeg", "-nostdin", "echo", "-i", "fd:#", "pipe:#"],
    ),
    (
        ["ffmpeg", "echo", "-i", "fd:0", "-progress", "pipe:2", "-f", "wav", "-"],
        [
            "tool=0",
            "ffmpeg",
            "-nostdin",
            "echo",
            "-i",
            "fd:#",
            "-progress",
            "pipe:#",
            "-f",
            "wav",
            "pipe:#",
        ],
    ),
    (
        ["ffmpeg", "echo", "-progress", "-", "out.wav"],
        ["tool=0", "ffmpeg", "-nostdin", "echo", "-progress", "pipe:#", "out.wav"],
    ),
    (
        ["ffprobe", "echo", "-of", "json", "-"],
        ["tool=1", "ffprobe", "echo", "-of", "json", "fd:#"],
    ),
    (
        ["ffprobe", "echo", "-i", "pipe:0"],
        ["tool=1", "ffprobe", "echo", "-i", "pipe:#"],
    ),
    (
        ["ffmpeg", "echo", "-i", "/tmp/in.wav", "/tmp/out.wav"],
        ["tool=0", "ffmpeg", "-nostdin", "echo", "-i", "/tmp/in.wav", "/tmp/out.wav"],
    ),
    (
        ["ffmpeg", "echo", "-i", "a.wav", "-i", "pipe:0", "-i", "pipe:0", "pipe:1"],
        [
            "tool=0",
            "ffmpeg",
            "-nostdin",
            "echo",
            "-i",
            "a.wav",
            "-i",
            "pipe:#",
            "-i",
            "pipe:#",
            "pipe:#",
        ],
    ),
]

POLICY_REJECT = [
    ["ffmpeg", "echo", "-i", "pipe:3", "out.wav"],
    ["ffmpeg", "echo", "-i", "fd:3", "out.wav"],
    ["ffmpeg", "echo", "-i", "fd:abc", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "pipe:"],
    ["ffmpeg", "echo", "-i", "a.wav", "pipe:01"],
    ["ffmpeg", "echo", "-i", "a.wav", "pipe:-1"],
    ["ffmpeg", "echo", "-i", "a.wav", "-f", "wav", "pipe:1", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "fd:2", "out.wav", "tail"],
    ["ffmpeg", "echo", "-", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-f", "tee", "[f=wav]pipe:1|[f=wav]out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "file:out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "/dev/null"],
    ["ffmpeg", "echo", "-i", "/dev/fd/0", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "/proc/self/fd/1"],
    ["ffmpeg", "echo", "-i", "concat:a.wav|pipe:0", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=fd:1", "out.wav"],
    ["ffprobe", "echo", "-show_streams", "pipe:5"],
    ["ffprobe", "echo", "-", "-of", "json"],
    ["ffmpeg", "echo", "-f", "lavfi", "-i", "amovie=pipe\\:3", "out.wav"],
    ["ffmpeg", "echo", "-f", "lavfi", "-i", "amovie=pipe\\\\:3", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "subtitles=p\\ipe\\\\:4", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie='pipe':3", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", 'movie=f"d":1', "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=fi'le':x", "out.wav"],
    ["ffmpeg", "echo", "-stdin", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "out.wav", "-stdin"],
    ["ffmpeg", "echo", "-i", "dev/fd/3", "out.wav"],
    ["ffmpeg", "echo", "-i", "dev/stdin", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "dev/stdout"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=dev/stderr", "out.wav"],
    ["ffmpeg", "echo", "-i", "proc/self/fd/3", "out.wav"],
    ["ffmpeg", "echo", "-stdin:v", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-stdin:", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-stdin:0", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-f", "image2", "-pattern_type", "glob", "-i", "x*.png", "out.wav"],
    ["ffmpeg", "echo", "-pattern_type", "sequence", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-i", "dev//fd/5", "out.wav"],
    ["ffmpeg", "echo", "-i", "dev/./fd/5", "out.wav"],
    ["ffmpeg", "echo", "-i", "dev/./stdin", "out.wav"],
    ["ffmpeg", "echo", "-i", "proc/./self/fd/5", "out.wav"],
    ["ffmpeg", "echo", "-i", "./dev//fd/5", "out.wav"],
    ["ffmpeg", "echo", "-i", "d\\ev//fd/3", "out.wav"],
    ["ffmpeg", "echo", "-f", "lavfi", "-i", "amovie=dev//fd/3", "out.wav"],
    ["ffmpeg", "echo", "-/filter_complex_threads", "2", "out.wav"],
    ["ffmpeg", "echo", "-/af", "g.txt", "-i", "a.wav", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-filter_script", "g.txt", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-filter_script:a", "g.txt", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-filter_complex_script", "g.txt", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=a;amovie=pipe:3", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x;file:x", "out.wav"],
    ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "title=x", "-f", "tee", "[f=wav]pipe:3"],
]
FORMAT_OPTS_GLOB = "movie=filename=/de?/fd/5:f=image2:format_opts=pattern_type\\=glob"
POLICY_REJECT.extend(
    [
        # Option strings carried inside a filtergraph.
        ["ffmpeg", "echo", "-f", "lavfi", "-i", FORMAT_OPTS_GLOB, "-f", "null", "-"],
        ["ffmpeg", "echo", "-filter_complex", FORMAT_OPTS_GLOB.replace("movie", "amovie", 1), "o"],
        [
            "ffmpeg",
            "echo",
            "-f",
            "lavfi",
            "-i",
            "movie=/d?v/f?/3:f=image2:format_opts='pattern_type=glob'",
            "o",
        ],
        ["ffmpeg", "echo", "-f", "lavfi", "-i", "movie=x.png:format_opts=a=b", "o"],
        ["ffmpeg", "echo", "-f", "lavfi", "-i", "amovie=x.wav", "o.wav"],
        ["ffmpeg", "echo", "-f", "lavfi", "-i", "a;MOVIE=x.png", "o.wav"],
        # Directory hops and relative spellings of /dev and /proc.
        ["ffmpeg", "echo", "-i", "dev/pts/../fd/5", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-progress", "dev/shm/../fd/7", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-fpre", "dev/shm/../fd/8", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "dev/shm/../fd/6"],
        ["ffmpeg", "echo", "-i", "x/../dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "../a.wav", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "/tmp/x/..", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=a/../b", "out.wav"],
        ["ffmpeg", "echo", "-i", "proc/thread-self/fd/5", "out.wav"],
        ["ffmpeg", "echo", "-i", "proc/1/fd/1", "out.wav"],
        ["ffmpeg", "echo", "-i", "/proc/1/fd/1", "out.wav"],
        ["ffmpeg", "echo", "-i", "/proc/thread-self/fd/0", "out.wav"],
        ["ffmpeg", "echo", "-i", "/DEV/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "/Dev/Stdin", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "movie=dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x:dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x(proc/1/fd/1)", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "[a]dev/fd/3[b]", "out.wav"],
        # -metadata exempts only the text before the first = of its own value.
        ["ffmpeg", "echo", "-i", "a.wav", "-passlogfile", "-metadata", "/dev/fd/3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "-metadata", "pipe:3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-user_agent", "-metadata", "pipe:3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "pipe:3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "/dev/fd/3", "o.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadatax", "pipe:3", "o.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata=v", "/dev/fd/3", "o.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "x", "-vf", "movie=fd:1", "o.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "pipe:3=x", "o.wav"],
        # Other -/ options, graph scripts and the filter file operand.
        ["ffmpeg", "echo", "-/filter_complex", "/dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-/filter_complex", "../g.txt", "out.wav"],
        ["ffmpeg", "echo", "-/filter_complex_threads", "2", "out.wav"],
        ["ffmpeg", "echo", "-/filter_complexx", "g.txt", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-/vf", "g.txt", "out.wav"],
        # Protocol words after the anchors, including a slash.
        ["ffmpeg", "echo", "-f", "lavfi", "-i", "amovie=pipe:3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-f", "tee", "[f=wav]pipe:3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", ";file:x", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x,fd:3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "(pipe:3)", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "a|file:b", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "/pipe:3"],
        ["ffmpeg", "echo", "-i", "a.wav", "-vf", "x/file:y", "out.wav"],
        # Protocol words and device directories behind a protocol prefix.
        ["ffmpeg", "echo", "-i", "concat:fd:5", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:pipe:3", "out.wav"],
        ["ffmpeg", "echo", "-i", "cache:fd:5", "out.wav"],
        ["ffmpeg", "echo", "-i", "subfile,,start,0,end,0,,:fd:5", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:file:x", "out.wav"],
        ["ffmpeg", "echo", "-i", "async:fd:9", "out.wav"],
        ["ffmpeg", "echo", "-i", "crypto:fd:9", "out.wav"],
        ["ffmpeg", "echo", "-i", "data:fd:9", "out.wav"],
        ["ffmpeg", "echo", "-i", "unix:fd:9", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:/dev/null", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:/proc/self/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "crypto+pipe:3", "out.wav"],
        ["ffmpeg", "echo", "-i", "crypto+/dev/null", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:a.wav|/dev/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "a.wav", "tee:a.wav|/dev/fd/3"],
        ["ffmpeg", "echo", "-i", "concat:a.wav|proc/self/fd/3", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:a.wav|/dev/null", "out.wav"],
        ["ffmpeg", "echo", "-i", "concat:a.wav|dev/fd/3", "out.wav"],
    ]
)

PLAIN_OK = [
    ["-protocol_whitelist", "file,crypto,data", "-i", "a.wav", "out.wav"],
    ["-i", "/srv/x/dev/notes.wav", "/srv/x/dev/out.wav"],
    ["-i", "/srv/me/mydev/fdr/a.wav", "/srv/me/mydev/fdr/b.wav"],
    ["-i", "/srv/me/proc/a.wav", "/srv/me/mydevproc/b.wav"],
    ["-i", "/srv/c+dev/a.wav", "/srv/c+proc/b.wav"],
    ["-i", "concat:a.wav|b.wav", "out.wav"],
    ["-i", "/srv/me/Gold file: draft.wav", "/srv/me/Sub-file:2.wav"],
    ["-i", "/x/hotpipe:1.wav", "/x/under_fd:2.wav"],
    ["-i", "./pipe:3", "./fd:3.wav"],
    ["-i", "a.wav", "-vf", "drawtext=text=Gold file: draft:x=1", "out.wav"],
    ["-i", "a.wav", "-vf", "drawtext=text=Sub-file:2", "out.wav"],
    ["-/filter_complex", "/tmp/.render-graph-x/graph.txt", "-map", "[out]", "out.wav"],
    ["-i", "a.wav", "-/filter_complex", "/tmp/g/graph.txt", "-map", "[out]", "out.wav"],
    ["-i", "a.wav", "-metadata", "title=a=/dev/fd/3", "out.wav"],
    ["-i", "a.wav", "-metadata", "title=movie=x format_opts=y pipe:3", "out.wav"],
    ["-i", "a.wav", "-metadata:s:a:0", "title=/dev/ and proc/ talk ../x", "out.wav"],
    ["-i", "a.wav", "-metadata", "x", "-metadata", "title=Hi: there", "out.wav"],
    ["-i", "a.wav", "-metadata", "title=a", "-metadata", "artist=file: b", "out.wav"],
]
POLICY_OK.extend(
    (["ffmpeg", "echo", *plain], ["tool=0", "ffmpeg", "-nostdin", "echo", *plain])
    for plain in PLAIN_OK
)
POLICY_OK.append(
    (
        ["ffmpeg", "echo", "-i", "a.wav", "-metadata", "-"],
        ["tool=0", "ffmpeg", "-nostdin", "echo", "-i", "a.wav", "-metadata", "pipe:#"],
    )
)

POLICY_OK.extend(
    [
        (
            ["ffmpeg", "echo", "-metadata", "title=Profile: Jane", "-i", "a.wav", "out.wav"],
            [
                "tool=0",
                "ffmpeg",
                "-nostdin",
                "echo",
                "-metadata",
                "title=Profile: Jane",
                "-i",
                "a.wav",
                "out.wav",
            ],
        ),
        (
            [
                "ffmpeg",
                "echo",
                "-i",
                "a.wav",
                "-metadata:s:a:0",
                "title=/dev/ and proc/ talk",
                "o.wav",
            ],
            [
                "tool=0",
                "ffmpeg",
                "-nostdin",
                "echo",
                "-i",
                "a.wav",
                "-metadata:s:a:0",
                "title=/dev/ and proc/ talk",
                "o.wav",
            ],
        ),
        (
            ["ffmpeg", "echo", "-i", "/x/profile:1.wav", "/x/out.wav"],
            ["tool=0", "ffmpeg", "-nostdin", "echo", "-i", "/x/profile:1.wav", "/x/out.wav"],
        ),
    ]
)


@pytest.mark.parametrize(
    ("argv", "expected"), POLICY_OK, ids=lambda v: " ".join(v) if isinstance(v, list) else ""
)
def test_argv_policy_rewrites_path_positions(
    shim: Shim, argv: list[str], expected: list[str]
) -> None:
    before = fd_count()
    with Pipes() as pipes:
        session = shim.launch(argv, pipes)
        assert session >= 1
        assert shim.wait(session) == 0
        lines = read_until(pipes.out_r).decode().splitlines()
        assert read_until(pipes.err_r) == b""
    assert normalise(lines) == expected
    copies = numbers(lines)
    assert len(set(copies)) == len(copies) and all(n >= 3 for n in copies)
    assert fd_count() == before


@pytest.mark.parametrize("argv", POLICY_REJECT, ids=lambda v: " ".join(v))
def test_argv_policy_rejects_with_one_stderr_line(shim: Shim, argv: list[str]) -> None:
    before = fd_count()
    runs = shim.counters()
    with Pipes() as pipes:
        session = shim.launch(argv, pipes)
        assert session >= 1
        assert shim.wait(session) == 1
        assert read_until(pipes.out_r) == b""
        err = read_until(pipes.err_r)
    assert err.startswith(b"sc_ffmpeg: ") and err.endswith(b"\n") and err.count(b"\n") == 1
    assert shim.counters() == runs
    assert fd_count() == before


def test_argv_copies_are_close_on_exec(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.launch(["ffmpeg", "echo", "hold", "-i", "pipe:0", "pipe:1"], pipes)
        lines = read_until(pipes.out_r, b"pipe:").decode().splitlines()
        assert all(fcntl.fcntl(n, fcntl.F_GETFD) & fcntl.FD_CLOEXEC for n in numbers(lines))
        shim.release()
        assert shim.wait(session) == 0


def test_progress_dash_maps_to_the_out_stream(shim: Shim) -> None:
    argv = ["ffmpeg", "echo", "-progress", "-", "out.wav"]
    with Pipes() as pipes:
        session = shim.start(argv, -1, pipes.out_w, -1)
        pipes.hand_over()
        assert shim.wait(session) == 0
    with Pipes() as pipes:
        session = shim.start(argv, -1, -1, pipes.err_w)
        pipes.hand_over()
        assert shim.wait(session) == 1


def test_argc_boundary_is_4096(shim: Shim) -> None:
    for argc, expected in ((4096, 0), (4097, -errno.EINVAL)):
        array = (ctypes.c_char_p * (argc + 1))(b"ffmpeg", b"echo", *[b"x"] * (argc - 2), None)
        session = shim.start_raw(array, argc, -1, -1, -1)
        assert (shim.wait(session) if session > 0 else session) == expected


def test_second_concurrent_wait_gets_esrch(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.hold("twice", pipes)
        results: list[int] = []
        waiters = [
            threading.Thread(target=lambda: results.append(shim.wait(session))) for _ in "ab"
        ]
        for waiter in waiters:
            waiter.start()
        wait_for(lambda: len(results) == 1, "the losing waiter returns")
        assert results == [-errno.ESRCH]
        shim.release()
        for waiter in waiters:
            waiter.join(BOUND_SEC)
    assert sorted(results) == [-errno.ESRCH, 0]


def test_policy_rejects_a_stream_that_was_not_provided(shim: Shim) -> None:
    with Pipes() as pipes:
        session = shim.start(
            ["ffmpeg", "echo", "-i", "pipe:0", "out.wav"], -1, pipes.out_w, pipes.err_w
        )
        pipes.hand_over()
        assert shim.wait(session) == 1
        assert read_until(pipes.err_r).count(b"\n") == 1
    with Pipes() as pipes:
        session = shim.start(["ffmpeg", "echo", "-i", "pipe:0", "pipe:1"], pipes.in_r, -1, -1)
        pipes.hand_over()
        assert shim.wait(session) == 1


def test_randomized_start_cancel_wait_interleavings(shim: Shim) -> None:
    before = fd_count()
    resets, runs, _ = shim.counters()
    shared: list[int] = []
    lock = threading.Lock()
    failures: list[str] = []

    def actor(seed: int) -> None:
        rng = random.Random(seed)
        try:
            for _ in range(60):
                kind = rng.choice(["echo", "hold", "readin", "block"])
                argv = {
                    "echo": ["ffmpeg", "echo", "-i", "pipe:0", "pipe:1"],
                    "hold": ["ffmpeg", "started", "hold"],
                    "block": ["ffprobe", "started", "block"],
                    "readin": ["ffprobe", "started", "readin", "-i", "pipe:0"],
                }[kind]
                with Pipes() as pipes:
                    session = shim.launch(argv, pipes)
                    if session == -errno.EAGAIN:
                        continue
                    if session < 1:
                        failures.append(f"start returned {session}")
                        return
                    with lock:
                        shared.append(session)
                    action = rng.choice(
                        ["cancel_wait", "cancel_twice", "leave", "other", "release"]
                    )
                    if action == "release":
                        shim.release()
                    if action == "other":
                        with lock:
                            victim = rng.choice(shared)
                        shim.cancel(victim)
                    if action != "leave":
                        shim.cancel(session)
                        if action == "cancel_twice":
                            shim.cancel(session)
                        code = shim.wait(session)
                        if code != -errno.ESRCH and not 0 <= code <= 255:
                            failures.append(f"wait returned {code}")
                        if shim.wait(session) != -errno.ESRCH:
                            failures.append("second wait did not fail")
        except BaseException as exc:
            failures.append(repr(exc))

    threads = [threading.Thread(target=actor, args=(seed,), daemon=True) for seed in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(BOUND_SEC * 3)
        assert not thread.is_alive(), "actor stuck"
    assert not failures, failures
    for session in shared:
        shim.cancel(session)
    for session in shared:
        code = shim.wait(session)
        assert code == -errno.ESRCH or 0 <= code <= 255
    code, out, _ = shim.run(["ffmpeg", "echo"])
    assert code == 0 and out.startswith(b"tool=0")
    after_resets, after_runs, _ = shim.counters()
    assert after_resets - resets == after_runs - runs
    assert fd_count() == before


def test_python_backend_runs_cancels_and_checks_the_abi(
    built: Path, shim: Shim, tmp_path: Path
) -> None:
    backend = NativeFFmpegBackend(shim.cdll)
    with Pipes() as pipes:
        streams = Streams(
            os.fdopen(pipes.in_r, "rb", buffering=0),
            os.fdopen(pipes.out_w, "wb", buffering=0),
            os.fdopen(pipes.err_w, "wb", buffering=0),
        )
        pipes.open -= {pipes.in_r, pipes.out_w, pipes.err_w}
        os.write(pipes.in_w, b"abc")
        os.close(pipes.in_w)
        pipes.open.discard(pipes.in_w)
        argv = [IN_PROCESS_FFMPEG, "progress", "echo", "-i", "-", "-f", "wav", "-"]
        code = backend.run(argv, streams, threading.Event())
        for stream in streams:
            assert stream is not None
            stream.close()
        assert code == 0
        assert read_until(pipes.err_r) == b"progress=continue\n" * 3
        assert normalise(read_until(pipes.out_r).decode().splitlines())[:4] == [
            "tool=0",
            "ffmpeg",
            "-nostdin",
            "progress",
        ]

    cancel = threading.Event()
    result: list[int] = []
    with Pipes() as pipes:
        streams = Streams(
            None,
            os.fdopen(os.dup(pipes.out_w), "wb", buffering=0),
            os.fdopen(os.dup(pipes.err_w), "wb", buffering=0),
        )
        runner = threading.Thread(
            target=lambda: result.append(
                backend.run([IN_PROCESS_FFMPEG, "started", "block"], streams, cancel)
            ),
            daemon=True,
        )
        runner.start()
        read_until(pipes.err_r, b"started\n")
        cancel.set()
        runner.join(BOUND_SEC)
        assert not runner.is_alive() and result == [255]
        for stream in streams:
            if stream is not None:
                stream.close()

    old = tmp_path / "old.so"
    _compile(
        old,
        [
            textwrap.dedent(
                """
                #include <stdint.h>
                int sc_ffmpeg_abi_version(void) { return 2; }
                int64_t sc_ffmpeg_start(int a, const char *const *v, int i, int o, int e) { return -1; }
                int sc_ffmpeg_wait(int64_t s) { return 0; }
                void sc_ffmpeg_cancel(int64_t s) {}
                """
            )
        ],
        [],
        tmp_path,
    )
    with pytest.raises(NativeFFmpegUnavailable, match="ABI version 2"):
        native_ffmpeg.load_library(ctypes.CDLL(str(old)))
    partial = tmp_path / "partial.so"
    _compile(partial, ["int sc_ffmpeg_abi_version(void) { return 1; }\n"], [], tmp_path)
    with pytest.raises(NativeFFmpegUnavailable, match="not exported"):
        native_ffmpeg.load_library(ctypes.CDLL(str(partial)))


def _runtime(kind: str) -> str | None:
    if COMPILER is None or sys.platform != "linux":
        return None
    name = {"address": "libasan.so", "thread": "libtsan.so"}[kind]
    path = subprocess.run(
        [COMPILER, f"-print-file-name={name}"], capture_output=True, text=True, check=False
    ).stdout.strip()
    return path if os.path.isabs(path) and os.path.exists(path) else None


def _rerun(kind: str, select_expr: str, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    runtime = _runtime(kind)
    if runtime is None:
        pytest.skip(f"no {kind} sanitizer runtime")
    env = {
        **os.environ,
        "SC_SHIM_SANITIZER": kind,
        "LD_PRELOAD": runtime,
        "ASAN_OPTIONS": "detect_leaks=0:verify_asan_link_order=0",
        "TSAN_OPTIONS": "report_signal_unsafe=0:halt_on_error=1",
    }
    command = [
        sys.executable,
        "-I",
        "-m",
        "pytest",
        str(Path(__file__)),
        "-p",
        "no:cacheprovider",
        "--no-cov",
        "-q",
        "-x",
        "-k",
        select_expr,
        "--basetemp",
        str(tmp_path / "inner"),
    ]
    return subprocess.run(
        command, env=env, capture_output=True, text=True, check=False, timeout=900
    )


@pytest.mark.timeout(900)
@pytest.mark.skipif(bool(SANITIZER), reason="already running under a sanitizer")
def test_suite_under_address_sanitizer(tmp_path: Path) -> None:
    done = _rerun("address", "not test_suite_under", tmp_path)
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-2000:]


@pytest.mark.timeout(900)
@pytest.mark.skipif(bool(SANITIZER), reason="already running under a sanitizer")
def test_randomized_interleavings_under_thread_sanitizer(tmp_path: Path) -> None:
    done = _rerun("thread", "randomized and not test_suite_under", tmp_path)
    if (
        done.returncode != 0
        and "ThreadSanitizer: unexpected memory mapping" in done.stderr + done.stdout
    ):
        pytest.skip("thread sanitizer cannot run in this process")
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-2000:]
