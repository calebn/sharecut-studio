"""Shared ctypes bridge for the app's native ``sc_<tool>_*`` C ABIs (docs/desktop-packaging.md).

``native_ffmpeg`` and ``native_whisper`` parameterise it; nothing is loaded at import.
"""

from __future__ import annotations

import ctypes
import errno
import logging
import os
import threading
from collections.abc import Mapping
from typing import Any, BinaryIO

from podcast_mcp.util import host_platform
from podcast_mcp.util.process import Streams

CANCEL_POLL_SEC = 0.05

_PROTOTYPES = {
    "abi_version": ctypes.CFUNCTYPE(ctypes.c_int),
    "start": ctypes.CFUNCTYPE(
        ctypes.c_int64,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_char_p),
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
    ),
    "wait": ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int64),
    "cancel": ctypes.CFUNCTYPE(None, ctypes.c_int64),
}


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


class NativeABI:
    """One native tool ABI: symbol prefix, argv[0] map, stderr label, version, error type."""

    def __init__(
        self,
        *,
        prefix: str,
        tools: Mapping[str, bytes],
        label: str,
        abi_version: int,
        log: logging.Logger,
        unavailable: type[OSError],
    ) -> None:
        self.prefix = prefix
        self.tools = tools
        self.label = label
        self.abi_version = abi_version
        self.log = log
        self.unavailable = unavailable

    def bind(self, lib: Any) -> dict[str, Any]:
        bound: dict[str, Any] = {}
        for suffix, prototype in _PROTOTYPES.items():
            name = self.prefix + suffix
            try:
                function = getattr(lib, name)
            except AttributeError as exc:
                raise self.unavailable(errno.ENOSYS, f"{name} is not exported") from exc
            address = ctypes.cast(function, ctypes.c_void_p).value
            if not address:
                raise self.unavailable(errno.ENOSYS, f"{name} has no address")
            bound[suffix] = prototype(address)
        return bound

    def load_library(self, lib: Any = None) -> Any:
        """The native functions of ``lib`` (default: this process), ABI version checked."""
        if lib is None:
            if host_platform.current().media_tools != "in_process":
                raise self.unavailable(errno.ENOSYS, "this host has no in-process media tools")
            lib = ctypes.CDLL(None)
        version = self.bind(lib)["abi_version"]()
        if version != self.abi_version:
            raise self.unavailable(
                errno.ENOSYS,
                f"{self.prefix.rstrip('_')} ABI version {version}, expected {self.abi_version}",
            )
        return lib

    def is_available(self) -> bool:
        try:
            self.load_library()
        except OSError as exc:
            if host_platform.current().media_tools == "in_process":
                self.log.info("native %s unavailable: %s", self.label, exc)
            return False
        return True


class NativeBackend:
    """``InProcessBackend`` over one ``NativeABI``; the contract is in docs/desktop-packaging.md."""

    def __init__(self, abi: NativeABI, lib: Any = None) -> None:
        self._abi = abi
        self._fns = abi.bind(abi.load_library(lib))

    def run(self, argv: list[str], streams: Streams, cancel: threading.Event) -> int:
        """Run one tool to completion: start, forward ``cancel`` through a watcher, wait, reap."""
        abi = self._abi
        tool = abi.tools.get(argv[0]) if argv else None
        if tool is None:
            return self._fail(streams, f"not a native tool: {argv[:1]!r}")
        encoded = [tool, *(os.fsencode(arg) for arg in argv[1:])]
        if any(b"\0" in arg for arg in encoded):
            raise ValueError("argv contains a NUL byte")
        in_fd, out_fd, err_fd = (_fd(stream) for stream in streams)
        array = (ctypes.c_char_p * (len(encoded) + 1))(*encoded, None)
        session = self._fns["start"](len(encoded), array, in_fd, out_fd, err_fd)
        if session < 1:
            reason = _errno_text(session) if session < 0 else "no session"
            return self._fail(streams, f"{abi.prefix}start failed: {reason}")
        done = threading.Event()
        watcher = threading.Thread(
            target=self._watch,
            args=(session, cancel, done),
            name=f"native-{abi.label}-cancel",
            daemon=True,
        )
        try:
            watcher.start()
        except BaseException:
            self._fns["cancel"](session)
            self._fns["wait"](session)
            raise
        try:
            code = self._fns["wait"](session)
        finally:
            done.set()
            watcher.join()
        if not 0 <= code <= 255:
            reason = _errno_text(code) if code < 0 else f"exit code {code}"
            return self._fail(streams, f"{abi.prefix}wait failed: {reason}")
        return code

    def _watch(self, session: int, cancel: threading.Event, done: threading.Event) -> None:
        """Poll until ``done``; on ``cancel`` call the native cancel once and stop."""
        while not done.is_set():
            if cancel.wait(CANCEL_POLL_SEC):
                self._fns["cancel"](session)
                return

    def _fail(self, streams: Streams, reason: str) -> int:
        self._abi.log.error("native %s: %s", self._abi.label, reason)
        if streams.stderr is not None:
            try:
                streams.stderr.write(f"{self._abi.label}: {reason}\n".encode())
                streams.stderr.flush()
            except (OSError, ValueError):
                pass
        return 1
