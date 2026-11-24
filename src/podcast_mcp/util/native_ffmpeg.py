"""ctypes bridge to the app's native ``sc_ffmpeg_*`` C ABI (docs/desktop-packaging.md).

Nothing is loaded at import; a native error is never reported as success.
"""

from __future__ import annotations

import contextlib
import ctypes
import errno
import logging
import re
import threading
from typing import Any

from podcast_mcp.util import native_abi, process
from podcast_mcp.util.process import IN_PROCESS_FFMPEG, IN_PROCESS_FFPROBE

ABI_VERSION = 2
UNKNOWN_BUILD_ID = "unknown"
_BUILD_ID = re.compile(r"[A-Za-z0-9._+-]{1,128}")
_CANCEL_POLL_SEC = native_abi.CANCEL_POLL_SEC

_log = logging.getLogger(__name__)


class NativeFFmpegUnavailable(OSError):
    """The native ``sc_ffmpeg_*`` library is not in this process, or speaks another ABI."""


_ABI = native_abi.NativeABI(
    prefix="sc_ffmpeg_",
    tools={IN_PROCESS_FFMPEG: b"ffmpeg", IN_PROCESS_FFPROBE: b"ffprobe"},
    label="ffmpeg",
    abi_version=ABI_VERSION,
    log=_log,
    unavailable=NativeFFmpegUnavailable,
    extra={"build_id": ctypes.CFUNCTYPE(ctypes.c_char_p)},
)


def load_library(lib: Any = None) -> Any:
    """The ``sc_ffmpeg_*`` functions of ``lib`` (default: this process), ABI version checked."""
    return _ABI.load_library(lib)


def build_id() -> str:
    """The native core's build id; raises ``NativeFFmpegUnavailable`` when absent or invalid."""
    lib = _ABI.load_library()
    raw = _ABI.bind(lib)["build_id"]()
    if raw is None:
        raise NativeFFmpegUnavailable(errno.ENOSYS, "sc_ffmpeg_build_id returned NULL")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise NativeFFmpegUnavailable(errno.ENOSYS, "sc_ffmpeg_build_id is not ASCII") from exc
    if _BUILD_ID.fullmatch(text) is None or text == UNKNOWN_BUILD_ID:
        raise NativeFFmpegUnavailable(errno.ENOSYS, "sc_ffmpeg_build_id is not a valid build id")
    return text


def is_available() -> bool:
    return _ABI.is_available()


def is_installed() -> bool:
    """Whether the native backend serves in-process tool argv now (linked is not enough)."""
    return process.in_process_backend_installed()


_installed: contextlib.ExitStack | None = None
_install_lock = threading.Lock()


def install_native_backend() -> bool:
    global _installed
    with _install_lock:
        if _installed is not None:
            return True
        if not is_available():
            return False
        try:
            build_id()
        except NativeFFmpegUnavailable as exc:
            _log.warning("native ffmpeg backend not installed: %s", exc)
            return False
        stack = contextlib.ExitStack()
        try:
            stack.enter_context(process.using_in_process_backend(NativeFFmpegBackend()))
        except RuntimeError:
            return False
        _installed = stack
        return True


class NativeFFmpegBackend(native_abi.NativeBackend):
    """``InProcessBackend`` over the ``sc_ffmpeg_*`` C ABI (docs/desktop-packaging.md#ios-native-ffmpeg-abi).

    Contract with the native side:

    - Native ``dup()``s each fd >= 0 during ``start`` and closes its dups when the session ends;
      the caller owns its own fds and native never closes them. Streams are flushed first.
      ``start`` never waits for the tool: it returns a session id without running it.
    - ``cancel`` must return without waiting for the tool, stop the session and close the session's
      originals (each at most once) at once, even if ``wait`` returns later; libav closes its own
      copies. The tool has ``_KILL_GRACE_SEC`` (``process.py``) after ``kill`` to return from ``wait``.
    - A caller's pipe reader sees EOF only when the native's dups are closed AND the caller-side
      write end is released. ``process`` releases that end when ``wait`` returns, or, for a tool
      that ignores the cancel, closes the caller's stdin write end when ``_KILL_GRACE_SEC`` ends,
      so a read blocked on it ends then. The caller's stdout and stderr read ends are not released
      there: a reader sees EOF only when the native's dups are closed.
    - A native error is never success: it becomes exit code 1 with one stderr line.
    """

    def __init__(self, lib: Any = None) -> None:
        super().__init__(_ABI, lib)
