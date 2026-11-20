"""NativeWhisperBackend against a fake ``sc_whisper_*`` library built from ctypes callbacks."""

from __future__ import annotations

import ctypes
import errno
import importlib.util
import tempfile
import threading
from dataclasses import replace
from typing import Any

import pytest

from podcast_mcp.util import host_platform, native_ffmpeg, native_whisper, process
from podcast_mcp.util.host_platform import IOS, MACOS
from podcast_mcp.util.native_whisper import NativeWhisperBackend, NativeWhisperUnavailable
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, IN_PROCESS_WHISPER, Streams

ROW = replace(IOS, media_tools="in_process")
BOUND_SEC = 3.0
START = ctypes.CFUNCTYPE(
    ctypes.c_int64,
    ctypes.c_int,
    ctypes.POINTER(ctypes.c_char_p),
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
)


class FakeWhisper:
    """The four ``sc_whisper_*`` symbols as ctypes callbacks; one session runs until cancelled."""

    def __init__(
        self,
        *,
        code: int = 0,
        version: int = 1,
        start_result: int | None = None,
        wait_result: int | None = None,
        block: bool = False,
    ) -> None:
        self.code = code
        self.start_result = start_result
        self.wait_result = wait_result
        self.block = block
        self.argvs: list[list[bytes]] = []
        self.cancelled = threading.Event()
        self.waited: list[int] = []
        self.sc_whisper_abi_version = ctypes.CFUNCTYPE(ctypes.c_int)(lambda: version)
        self.sc_whisper_start = START(self._start)
        self.sc_whisper_wait = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64)(self._wait)
        self.sc_whisper_cancel = ctypes.CFUNCTYPE(None, ctypes.c_int64)(self._cancel)

    def _start(self, argc: int, argv: Any, in_fd: int, out_fd: int, err_fd: int) -> int:
        if self.start_result is not None:
            return self.start_result
        assert argv[argc] is None
        self.argvs.append([argv[i] for i in range(argc)])
        return len(self.argvs)

    def _wait(self, session: int) -> int:
        self.waited.append(session)
        if self.block:
            self.cancelled.wait(BOUND_SEC)
        return self.code if self.wait_result is None else self.wait_result

    def _cancel(self, session: int) -> None:
        self.cancelled.set()


class FakeFFmpeg:
    def __init__(self) -> None:
        self.sc_ffmpeg_abi_version = ctypes.CFUNCTYPE(ctypes.c_int)(lambda: 1)
        self.sc_ffmpeg_start = START(lambda *a: 1)
        self.sc_ffmpeg_wait = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64)(lambda s: 0)
        self.sc_ffmpeg_cancel = ctypes.CFUNCTYPE(None, ctypes.c_int64)(lambda s: None)


@pytest.fixture
def host():
    with host_platform.using(ROW):
        yield


@pytest.fixture
def uninstall():
    yield
    stack = native_whisper._installed
    native_whisper._installed = None
    if stack is not None:
        stack.close()


def run_whisper(fake: FakeWhisper, argv: list[str], **kw: Any) -> process.CompletedProcess[Any]:
    with process.using_in_process_whisper_backend(NativeWhisperBackend(fake)):
        return process.run(argv, **kw)


def test_importing_native_whisper_loads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("loaded at import")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    monkeypatch.setattr(ctypes, "PyDLL", boom)
    spec = importlib.util.spec_from_file_location("native_whisper_fresh", native_whisper.__file__)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(importlib.util.module_from_spec(spec))


def test_argv_zero_is_whisper_cli_and_the_rest_is_encoded(host: None) -> None:
    fake = FakeWhisper()
    argv = [IN_PROCESS_WHISPER, "-m", "model.bin", "-f", "café.wav", "-ojf", "-np", "-l", "en"]
    assert run_whisper(fake, argv, capture_output=True).returncode == 0
    assert fake.argvs == [
        [
            b"whisper-cli",
            *(b"-m", b"model.bin", b"-f", "café.wav".encode()),
            *(b"-ojf", b"-np", b"-l", b"en"),
        ]
    ]


def test_exit_codes_pass_through(host: None) -> None:
    assert run_whisper(FakeWhisper(code=0), [IN_PROCESS_WHISPER]).returncode == 0
    assert run_whisper(FakeWhisper(code=255), [IN_PROCESS_WHISPER]).returncode == 255


def test_an_unknown_tool_is_exit_one_and_starts_nothing() -> None:
    fake = FakeWhisper()
    with tempfile.TemporaryFile() as err:
        backend = NativeWhisperBackend(fake)
        assert backend.run([IN_PROCESS_FFMPEG], Streams(None, None, err), threading.Event()) == 1
        assert fake.argvs == []
        err.seek(0)
        assert len(err.read().splitlines()) == 1


def test_cancel_is_forwarded_once_to_native(host: None) -> None:
    fake = FakeWhisper(block=True)
    cancel = threading.Event()
    codes: list[int] = []
    runner = threading.Thread(
        target=lambda: codes.append(
            NativeWhisperBackend(fake).run([IN_PROCESS_WHISPER], Streams(None, None, None), cancel)
        )
    )
    runner.start()
    cancel.set()
    assert fake.cancelled.wait(BOUND_SEC)
    runner.join(BOUND_SEC)
    assert not runner.is_alive()
    assert codes == [0]
    assert fake.waited == [1]


@pytest.mark.parametrize("result", [0, -errno.ENOMEM])
def test_a_native_start_error_is_exit_one_with_one_stderr_line(host: None, result: int) -> None:
    done = run_whisper(FakeWhisper(start_result=result), [IN_PROCESS_WHISPER], capture_output=True)
    assert done.returncode == 1
    lines = done.stderr.decode().splitlines()
    assert len(lines) == 1 and lines[0].startswith("whisper: sc_whisper_start failed")


@pytest.mark.parametrize("bad", [-errno.ESRCH, -(1 << 31), 256, 1000])
def test_a_wait_error_or_out_of_range_code_is_exit_one_with_one_stderr_line(
    host: None, bad: int
) -> None:
    done = run_whisper(FakeWhisper(wait_result=bad), [IN_PROCESS_WHISPER], capture_output=True)
    assert done.returncode == 1
    lines = done.stderr.decode().splitlines()
    assert len(lines) == 1 and lines[0].startswith("whisper: sc_whisper_wait failed")


def test_not_installed_is_spawn_unavailable(host: None) -> None:
    with pytest.raises(process.SpawnUnavailableError):
        process.run([IN_PROCESS_WHISPER], capture_output=True)


def test_a_host_without_in_process_tools_is_spawn_unavailable() -> None:
    with process.using_in_process_whisper_backend(NativeWhisperBackend(FakeWhisper())):
        with host_platform.using(replace(MACOS, media_tools="executables")):
            with pytest.raises(process.SpawnUnavailableError):
                process.run([IN_PROCESS_WHISPER], capture_output=True)


def test_double_install_is_refused() -> None:
    with process.using_in_process_whisper_backend(NativeWhisperBackend(FakeWhisper())):
        with pytest.raises(RuntimeError):
            with process.using_in_process_whisper_backend(NativeWhisperBackend(FakeWhisper())):
                pass
        assert process.in_process_whisper_backend_installed()
    assert not process.in_process_whisper_backend_installed()


def test_the_ffmpeg_and_whisper_slots_are_independent(host: None) -> None:
    with process.using_in_process_whisper_backend(NativeWhisperBackend(FakeWhisper())):
        assert process.in_process_whisper_backend_installed()
        assert not process.in_process_backend_installed()
        with pytest.raises(process.SpawnUnavailableError):
            process.run([IN_PROCESS_FFMPEG], capture_output=True)
        with process.using_in_process_backend(native_ffmpeg.NativeFFmpegBackend(FakeFFmpeg())):
            assert process.run([IN_PROCESS_WHISPER], capture_output=True).returncode == 0
    with process.using_in_process_backend(native_ffmpeg.NativeFFmpegBackend(FakeFFmpeg())):
        assert process.in_process_backend_installed()
        assert not process.in_process_whisper_backend_installed()
        with pytest.raises(process.SpawnUnavailableError):
            process.run([IN_PROCESS_WHISPER], capture_output=True)


def test_desktop_probe_never_touches_ctypes(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("ctypes touched on desktop")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert native_whisper.is_available() is False


def test_probe_finds_the_symbols_through_the_process_handle(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert native_whisper.is_available() is False
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeWhisper())
    assert native_whisper.is_available() is True


def test_ffmpeg_symbols_alone_do_not_make_whisper_available(
    host: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeFFmpeg())
    assert native_ffmpeg.is_available() is True
    assert native_whisper.is_available() is False


def test_a_wrong_abi_version_is_not_available(host: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda name: FakeWhisper(version=2))
    assert native_whisper.is_available() is False
    with pytest.raises(NativeWhisperUnavailable):
        native_whisper.load_library()


def test_a_library_missing_one_symbol_is_unavailable() -> None:
    fake = FakeWhisper()
    del fake.sc_whisper_cancel
    with pytest.raises(NativeWhisperUnavailable):
        NativeWhisperBackend(fake)


def test_install_native_backend_installs_once_and_serves_spawns(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    fake = FakeWhisper()
    monkeypatch.setattr(ctypes, "CDLL", lambda name: fake)
    assert native_whisper.install_native_backend() is True
    assert native_whisper.install_native_backend() is True
    assert native_whisper.is_installed() is True
    assert native_ffmpeg.is_installed() is False
    assert process.run([IN_PROCESS_WHISPER], capture_output=True).returncode == 0
    assert len(fake.argvs) == 1


def test_install_native_backend_declines_without_the_library(host: None, uninstall: None) -> None:
    assert native_whisper.install_native_backend() is False
    assert native_whisper.is_installed() is False


def test_install_native_backend_declines_on_a_desktop_row(
    monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda *a, **k: FakeWhisper())
    with host_platform.using(replace(MACOS, media_tools="executables")):
        assert native_whisper.install_native_backend() is False


def test_install_native_backend_declines_when_another_whisper_backend_is_installed(
    host: None, monkeypatch: pytest.MonkeyPatch, uninstall: None
) -> None:
    monkeypatch.setattr(ctypes, "CDLL", lambda *a, **k: FakeWhisper())
    with process.using_in_process_whisper_backend(NativeWhisperBackend(FakeWhisper())):
        assert native_whisper.install_native_backend() is False
    assert native_whisper._installed is None
