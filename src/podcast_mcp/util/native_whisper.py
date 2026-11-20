"""ctypes bridge to the app's native ``sc_whisper_*`` C ABI (docs/desktop-packaging.md).

Nothing is loaded at import; a native error is never reported as success.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from typing import Any

from podcast_mcp.util import native_abi, process
from podcast_mcp.util.process import IN_PROCESS_WHISPER

ABI_VERSION = 1

_log = logging.getLogger(__name__)


class NativeWhisperUnavailable(OSError):
    """The native ``sc_whisper_*`` library is not in this process, or speaks another ABI."""


_ABI = native_abi.NativeABI(
    prefix="sc_whisper_",
    tools={IN_PROCESS_WHISPER: b"whisper-cli"},
    label="whisper",
    abi_version=ABI_VERSION,
    log=_log,
    unavailable=NativeWhisperUnavailable,
)


def load_library(lib: Any = None) -> Any:
    """The ``sc_whisper_*`` functions of ``lib`` (default: this process), ABI version checked."""
    return _ABI.load_library(lib)


def is_available() -> bool:
    return _ABI.is_available()


def is_installed() -> bool:
    """Whether the native backend serves in-process whisper argv now (linked is not enough)."""
    return process.in_process_whisper_backend_installed()


_installed: contextlib.ExitStack | None = None
_install_lock = threading.Lock()


def install_native_backend() -> bool:
    global _installed
    with _install_lock:
        if _installed is not None:
            return True
        if not is_available():
            return False
        stack = contextlib.ExitStack()
        try:
            stack.enter_context(process.using_in_process_whisper_backend(NativeWhisperBackend()))
        except RuntimeError:
            return False
        _installed = stack
        return True


class NativeWhisperBackend(native_abi.NativeBackend):
    """``InProcessBackend`` over the ``sc_whisper_*`` C ABI (docs/desktop-packaging.md#ios-native-whisper-abi).

    Same fd, cancel and error contract as ``NativeFFmpegBackend``.
    """

    def __init__(self, lib: Any = None) -> None:
        super().__init__(_ABI, lib)
