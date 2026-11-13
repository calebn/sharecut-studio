"""Serve ShareCut Studio from inside a host process (the iOS app's embedded interpreter).

The in-process twin of ``gui/serve.py``: the same ``create_app`` and uvicorn wiring
(``bind.build_gui_server``), without argv or a listen file. The host calls ``start()``
and navigates its web view to the returned port.

The engine starts once per process. The app is built once, because ``create_app`` resets the
shared job manager, and it is served once, because serving the same app a second time reruns its
lifespan, which stops the job leases and file watchers. So ``stop()`` is final: a later
``start()`` is refused and the host reopens the app. The port is bound once and held until
then, so a retry after a failed start (the app never served) gets the same port.

The state is ``Idle``, ``Serving(port)``, ``Failed(reason)`` (never served, retry allowed) or
``Stopped(reason)`` (served and ended, terminal), under one lock. A failed start keeps its
one-line reason in ``status()`` and the traceback in ``engine.log`` under the host's first log
directory.
"""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
import time
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from podcast_mcp.gui.bind import build_gui_server, exclusive_listen_socket
from podcast_mcp.util import host_platform
from podcast_mcp.util.atomic_json import write_bytes_atomic

log = logging.getLogger(__name__)

LOOPBACK = "127.0.0.1"
ENGINE_LOG_NAME = "engine.log"
START_TIMEOUT_SEC = 60.0
STOP_TIMEOUT_SEC = 5.0
STOPPED_BY_HOST = "the engine was stopped; reopen the app"
STOPPED_UNEXPECTEDLY = "the server stopped unexpectedly; reopen the app"
GRACEFUL_SHUTDOWN_SEC = 2
_POLL_SEC = 0.02


@dataclass(frozen=True)
class Idle:
    """Nothing has served yet."""


@dataclass(frozen=True)
class Stopped:
    """The engine served and ended; it cannot serve again in this process."""

    reason: str


@dataclass(frozen=True)
class Serving:
    port: int


@dataclass(frozen=True)
class Failed:
    reason: str


EmbeddedState = Idle | Serving | Failed | Stopped


class EmbeddedStartError(RuntimeError):
    """The listener did not come up, or the engine already ended; the message is the one-line reason."""


class _Listener:
    """A uvicorn server thread serving the app on a duplicate of the held socket.

    uvicorn closes the socket it is given when it stops, so it gets a duplicate; the held
    socket keeps the port bound across a failed start.
    """

    def __init__(self, app: Any, held: socket.socket) -> None:
        self.sock = held.dup()
        self.server = build_gui_server(
            app, self.sock, log_level="warning", graceful_shutdown_sec=GRACEFUL_SHUTDOWN_SEC
        )
        self.thread = threading.Thread(target=self._serve, name="sharecut-embedded", daemon=True)

    def _serve(self) -> None:
        with contextlib.suppress(SystemExit):
            self.server.run(sockets=[self.sock])

    def open(self, timeout_sec: float) -> None:
        self.thread.start()
        deadline = time.monotonic() + timeout_sec
        while not self.server.started:
            if not self.thread.is_alive():
                raise EmbeddedStartError("the server stopped while starting")
            if time.monotonic() > deadline:
                raise EmbeddedStartError("the server did not start in time")
            time.sleep(_POLL_SEC)

    def close(self) -> None:
        self.server.should_exit = True
        if self.thread.is_alive():
            self.thread.join(STOP_TIMEOUT_SEC)
        if self.thread.is_alive():
            self.server.force_exit = True
            self.thread.join(STOP_TIMEOUT_SEC)
        self.sock.close()


class _Engine:
    def __init__(self, start_timeout_sec: float = START_TIMEOUT_SEC) -> None:
        self._lock = threading.Lock()
        self._start_timeout_sec = start_timeout_sec
        self._app: Any = None
        self._socket: socket.socket | None = None
        self._listener: _Listener | None = None
        self._state: EmbeddedState = Idle()

    def status(self) -> EmbeddedState:
        with self._lock:
            self._notice_dead_listener()
            return self._state

    def start(self) -> int:
        with self._lock:
            self._notice_dead_listener()
            if isinstance(self._state, Serving):
                return self._state.port
            if isinstance(self._state, Stopped):
                raise EmbeddedStartError(self._state.reason)
            return self._bind()

    def stop(self) -> None:
        with self._lock:
            self._notice_dead_listener()
            if isinstance(self._state, Serving):
                self._end(STOPPED_BY_HOST)
            elif isinstance(self._state, Failed):
                self._release_socket()
                self._state = Idle()

    def _bind(self) -> int:
        listener: _Listener | None = None
        try:
            if self._app is None:
                from podcast_mcp.gui.server import create_app

                self._app = create_app(host_mcp=False)
            if self._socket is None:
                self._socket = exclusive_listen_socket(LOOPBACK, 0)
            listener = _Listener(self._app, self._socket)
            listener.open(self._start_timeout_sec)
        except Exception as exc:
            _write_engine_log("embedded start failed")
            if listener is not None:
                listener.close()
            reason = _one_line(exc)
            self._state = Failed(reason)
            raise EmbeddedStartError(reason) from exc
        self._listener = listener
        port = int(self._socket.getsockname()[1])
        self._state = Serving(port)
        return port

    def _notice_dead_listener(self) -> None:
        if self._listener is not None and not self._listener.thread.is_alive():
            self._end(STOPPED_UNEXPECTEDLY)

    def _end(self, reason: str) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.close()
        self._release_socket()
        self._state = Stopped(reason)

    def _release_socket(self) -> None:
        sock, self._socket = self._socket, None
        if sock is not None:
            sock.close()


def _one_line(exc: BaseException) -> str:
    if isinstance(exc, EmbeddedStartError):
        return str(exc)
    text = str(exc).strip().splitlines()
    detail = text[0] if text else ""
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


def _write_engine_log(headline: str) -> None:
    stamp = datetime.now(UTC).isoformat(timespec="seconds")
    entry = f"{stamp} {headline}\n{traceback.format_exc()}\n"
    try:
        path = host_platform.data_roots().log_dirs[0] / ENGINE_LOG_NAME
        earlier = path.read_bytes() if path.exists() else b""
        write_bytes_atomic(path, earlier + entry.encode("utf-8"))
    except OSError:
        log.exception(headline)


_ENGINE = _Engine()


def start() -> int:
    """Bind ``127.0.0.1:0``, serve the Studio on a daemon thread, return the bound port.

    Already serving: the same port. Raises ``EmbeddedStartError`` when the app or the
    listener cannot come up (``status()`` then says why; a retry is allowed) and after
    ``stop()`` (the engine starts once per process).
    """
    return _ENGINE.start()


def stop() -> None:
    """Stop serving for good and release the port. Safe to repeat; a later ``start()`` is refused."""
    _ENGINE.stop()


def status() -> EmbeddedState:
    return _ENGINE.status()
