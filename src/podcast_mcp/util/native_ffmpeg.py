"""ctypes bridge to the app's native ``sc_ffmpeg_*`` C ABI (docs/desktop-packaging.md).

Nothing is loaded at import; a native error is never reported as success.
"""

from __future__ import annotations

import ctypes
import errno
import logging
import os
import threading
from typing import Any, BinaryIO

from podcast_mcp.util import host_platform
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE, Streams

ABI_VERSION = 1
_TOOL_NAMES = {IN_PROCESS_FFMPEG: b"ffmpeg", IN_PROCESS_FFPROBE: b"ffprobe"}
_SYMBOLS = ("sc_ffmpeg_abi_version", "sc_ffmpeg_start", "sc_ffmpeg_wait", "sc_ffmpeg_cancel")
_CANCEL_POLL_SEC = 0.05

_PROTOTYPES = {
    "sc_ffmpeg_abi_version": ctypes.CFUNCTYPE(ctypes.c_int),
    "sc_ffmpeg_start": ctypes.CFUNCTYPE(
        ctypes.c_int64,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_char_p),
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
    ),
    "sc_ffmpeg_wait": ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64),
    "sc_ffmpeg_cancel": ctypes.CFUNCTYPE(None, ctypes.c_int64),
}

_log = logging.getLogger(__name__)


class NativeFFmpegUnavailable(OSError):
    """The native ``sc_ffmpeg_*`` library is not in this process, or speaks another ABI."""


def _bind(lib: Any) -> dict[str, Any]:
    bound: dict[str, Any] = {}
    for name in _SYMBOLS:
        try:
            function = getattr(lib, name)
        except AttributeError as exc:
            raise NativeFFmpegUnavailable(errno.ENOSYS, f"{name} is not exported") from exc
        address = ctypes.cast(function, ctypes.c_void_p).value
        if not address:
            raise NativeFFmpegUnavailable(errno.ENOSYS, f"{name} has no address")
        bound[name] = _PROTOTYPES[name](address)
    return bound


def load_library(lib: Any = None) -> Any:
    """The ``sc_ffmpeg_*`` functions of ``lib`` (default: this process), ABI version checked."""
    if lib is None:
        if host_platform.current().media_tools != "in_process":
            raise NativeFFmpegUnavailable(errno.ENOSYS, "this host has no in-process media tools")
        lib = ctypes.CDLL(None)
    bound = _bind(lib)
    version = bound["sc_ffmpeg_abi_version"]()
    if version != ABI_VERSION:
        raise NativeFFmpegUnavailable(
            errno.ENOSYS, f"sc_ffmpeg ABI version {version}, expected {ABI_VERSION}"
        )
    return lib


def is_available() -> bool:
    try:
        load_library()
    except NativeFFmpegUnavailable as exc:
        if host_platform.current().media_tools == "in_process":
            _log.info("native ffmpeg unavailable: %s", exc)
        return False
    return True


def _errno_text(result: int) -> str:
    try:
        return os.strerror(-result)
    except (OverflowError, ValueError):
        return f"error {result}"


def _fd(stream: BinaryIO | None) -> int:
    if stream is None:
        return -1
    stream.flush()
    return stream.fileno()


class NativeFFmpegBackend:
    """``InProcessBackend`` over the ``sc_ffmpeg_*`` C ABI (docs/desktop-packaging.md#ios-native-ffmpeg-abi).

    Contract with the native side:

    - Native ``dup()``s each fd >= 0 during ``start`` and closes its dups when the session ends;
      the caller owns its own fds and native never closes them. Streams are flushed first.
    - ``cancel`` must return promptly, stop the session and close the session's dups (each at most
      once) at once, even if ``wait`` returns later.
    - A caller's pipe reader sees EOF only when the native's dups are closed AND the caller-side
      write end is released. ``process`` releases that end when ``wait`` returns, or after
      ``KILL_GRACE_SEC`` at the latest, so EOF after a kill can take up to that grace.
    - A native error is never success: it becomes exit code 1 with one stderr line.
    """

    def __init__(self, lib: Any = None) -> None:
        self._fns = _bind(load_library(lib))

    def run(self, argv: list[str], streams: Streams, cancel: threading.Event) -> int:
        """Run one tool to completion: start, forward ``cancel`` through a watcher, wait, reap."""
        tool = _TOOL_NAMES.get(argv[0]) if argv else None
        if tool is None:
            return self._fail(streams, f"not a native tool: {argv[:1]!r}")
        encoded = [tool, *(os.fsencode(arg) for arg in argv[1:])]
        if any(b"\0" in arg for arg in encoded):
            raise ValueError("argv contains a NUL byte")
        in_fd, out_fd, err_fd = (_fd(stream) for stream in streams)
        array = (ctypes.c_char_p * (len(encoded) + 1))(*encoded, None)
        session = self._fns["sc_ffmpeg_start"](len(encoded), array, in_fd, out_fd, err_fd)
        if session < 1:
            reason = _errno_text(session) if session < 0 else "no session"
            return self._fail(streams, f"sc_ffmpeg_start failed: {reason}")
        done = threading.Event()
        watcher = threading.Thread(
            target=self._watch,
            args=(session, cancel, done),
            name="native-ffmpeg-cancel",
            daemon=True,
        )
        try:
            watcher.start()
        except BaseException:
            self._fns["sc_ffmpeg_cancel"](session)
            self._fns["sc_ffmpeg_wait"](session)
            raise
        try:
            code = self._fns["sc_ffmpeg_wait"](session)
        finally:
            done.set()
            watcher.join()
        if not 0 <= code <= 255:
            reason = _errno_text(code) if code < 0 else f"exit code {code}"
            return self._fail(streams, f"sc_ffmpeg_wait failed: {reason}")
        return code

    def _watch(self, session: int, cancel: threading.Event, done: threading.Event) -> None:
        """Poll until ``done``; on ``cancel`` call ``sc_ffmpeg_cancel`` once and stop."""
        while not done.is_set():
            if cancel.wait(_CANCEL_POLL_SEC):
                self._fns["sc_ffmpeg_cancel"](session)
                return

    @staticmethod
    def _fail(streams: Streams, reason: str) -> int:
        _log.error("native ffmpeg: %s", reason)
        if streams.stderr is not None:
            try:
                streams.stderr.write(f"ffmpeg: {reason}\n".encode())
                streams.stderr.flush()
            except (OSError, ValueError):
                pass
        return 1
