"""Shared fake backend and case selection for in-process FFmpeg tests."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from inspect import isfunction
from typing import Any, TypeVar

from podcast_mcp.util.process import Streams

_DESKTOP_REASON = "desktop_ffmpeg_reason"
_Test = TypeVar("_Test", bound=Callable[..., object])
_MIB = 1 << 20


def desktop_ffmpeg(reason: str) -> Callable[[_Test], _Test]:
    """Keep an explicitly desktop-dependent case out of the in-process repeat."""
    if not reason.strip():
        raise ValueError("desktop FFmpeg tests need a reason")

    def classify(test: _Test) -> _Test:
        test.__dict__[_DESKTOP_REASON] = reason
        return test

    return classify


def shared_ffmpeg_test(test: object) -> bool:
    return isfunction(test) and not getattr(test, _DESKTOP_REASON, None)


class FakeBackend:
    """Records every call and plays the behaviour named by ``argv[1]`` (default: succeed)."""

    def __init__(self, **params: Any) -> None:
        self.calls: list[list[str]] = []
        self.cancels: list[threading.Event] = []
        self.params = params

    def run(self, argv: list[str], streams: Streams, cancel: threading.Event) -> int:
        self.calls.append(argv)
        self.cancels.append(cancel)
        p = self.params
        behaviour = argv[1] if len(argv) > 1 else "ok"
        if behaviour == "echo":
            while data := os.read(streams.stdin.fileno(), 65536):
                streams.stdout.write(data)
                streams.stdout.flush()
            return 0
        if behaviour == "lines":
            for i in range(p["n"]):
                streams.stdout.write(b"line %d\n" % i)
            streams.stdout.flush()
            return 0
        if behaviour == "stderr_exit":
            streams.stdout.write(p["out"])
            streams.stdout.flush()
            streams.stderr.write(p["err"])
            streams.stderr.flush()
            return p["code"]
        if behaviour == "wait_stdin":
            streams.stdin.read()
            return p["code"]
        if behaviour == "block":
            cancel.wait()
            return -9
        if behaviour == "cancel_zero":
            cancel.wait()
            return 0
        if behaviour == "pcm_short":
            streams.stdout.write(b"\0" * 400)
            streams.stdout.flush()
            cancel.wait()
            return 0
        if behaviour == "ignore_kill":
            threading.Event().wait(30)
            return 0
        if behaviour == "stuck_read":
            streams.stdin.read()
            return 0
        if behaviour == "stuck_write":
            streams.stdout.write(b"x" * (8 * _MIB))
            return 0
        if behaviour == "none":
            return None
        if behaviour == "flood":
            chunk = b"x" * (p["err_bytes"] // p["lines"])
            for i in range(p["lines"]):
                streams.stdout.write(b"frame=%d\n" % i)
                streams.stdout.flush()
                streams.stderr.write(chunk)
                streams.stderr.flush()
            return 0
        if behaviour == "boom":
            raise RuntimeError("backend bug")
        for stream, text in ((streams.stdout, b"out"), (streams.stderr, b"err")):
            if stream is not None:
                stream.write(text)
                stream.flush()
        return p.get("code", 0)
