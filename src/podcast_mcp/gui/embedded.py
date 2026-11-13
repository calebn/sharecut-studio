"""Serve ShareCut Studio from inside a host process (the iOS app's embedded interpreter).

The in-process twin of ``gui/serve.py``: the same ``create_app`` and uvicorn wiring
(``bind.build_gui_server``), without argv or a listen file. The host calls ``start()``
and navigates its web view to the returned port.

The app is built once per process, because ``create_app`` resets the shared job manager.
Only the listener comes and goes: ``stop()`` then ``start()`` rebinds it around the same app,
so jobs and sessions survive. The lifecycle is one of three states under one lock:

    Stopped --start--> Serving(port) --stop--> Stopped
       |
       +--start fails--> Failed(reason) --start--> Serving(port)

A failed start keeps its one-line reason in ``status()`` and the traceback in ``engine.log``
under the host's first log directory.
"""

from __future__ import annotations

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

log = logging.getLogger(__name__)

LOOPBACK = "127.0.0.1"
ENGINE_LOG_NAME = "engine.log"
START_TIMEOUT_SEC = 60.0
STOP_TIMEOUT_SEC = 5.0
GRACEFUL_SHUTDOWN_SEC = 2
_POLL_SEC = 0.02


@dataclass(frozen=True)
class Stopped:
    pass


@dataclass(frozen=True)
class Serving:
    port: int


@dataclass(frozen=True)
class Failed:
    reason: str


EmbeddedState = Stopped | Serving | Failed


class EmbeddedStartError(RuntimeError):
    """The listener did not come up; the message is the one-line reason in ``Failed``."""


class _Listener:
    """A uvicorn server thread serving the app on a duplicate of the held socket.

    uvicorn closes the socket it is given when it stops, so it gets a duplicate; the held
    socket keeps the port bound and listening between runs.
    """

    def __init__(self, app: Any, held: socket.socket) -> None:
        self.sock = held.dup()
        self.server = build_gui_server(
            app, self.sock, log_level="warning", graceful_shutdown_sec=GRACEFUL_SHUTDOWN_SEC
        )
        self.thread = threading.Thread(target=self._serve, name="sharecut-embedded", daemon=True)

    def _serve(self) -> None:
        try:
            self.server.run(sockets=[self.sock])
        except SystemExit:
            pass
        except Exception:
            _write_engine_log("embedded server stopped with an error")

    def alive(self) -> bool:
        return self.thread.is_alive()

    def open(self) -> None:
        self.thread.start()
        deadline = time.monotonic() + START_TIMEOUT_SEC
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
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._app: Any = None
        self._socket: socket.socket | None = None
        self._listener: _Listener | None = None
        self._state: EmbeddedState = Stopped()

    def status(self) -> EmbeddedState:
        with self._lock:
            self._notice_dead_listener()
            return self._state

    def start(self) -> int:
        with self._lock:
            self._notice_dead_listener()
            if isinstance(self._state, Serving):
                return self._state.port
            return self._bind()

    def stop(self) -> None:
        with self._lock:
            self._stop_listener()
            self._state = Stopped()

    def _bind(self) -> int:
        listener: _Listener | None = None
        try:
            if self._app is None:
                from podcast_mcp.gui.server import create_app

                self._app = create_app(host_mcp=False)
            if self._socket is None:
                self._socket = exclusive_listen_socket(LOOPBACK, 0)
            listener = _Listener(self._app, self._socket)
            listener.open()
        except Exception as exc:
            _write_engine_log("embedded start failed")
            if listener is not None:
                listener.close()
            self._release_socket()
            reason = _one_line(exc)
            self._state = Failed(reason)
            raise EmbeddedStartError(reason) from exc
        self._listener = listener
        port = int(self._socket.getsockname()[1])
        self._state = Serving(port)
        return port

    def _release_socket(self) -> None:
        sock, self._socket = self._socket, None
        if sock is not None:
            sock.close()

    def _notice_dead_listener(self) -> None:
        if self._listener is not None and not self._listener.alive():
            self._stop_listener()
            self._state = Failed("the server stopped unexpectedly")

    def _stop_listener(self) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.close()


def _one_line(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    detail = text[0] if text else ""
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


def _write_engine_log(headline: str) -> None:
    stamp = datetime.now(UTC).isoformat(timespec="seconds")
    entry = f"{stamp} {headline}\n{traceback.format_exc()}\n"
    try:
        directory = host_platform.data_roots().log_dirs[0]
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / ENGINE_LOG_NAME).open("a", encoding="utf-8") as handle:
            handle.write(entry)
    except OSError:
        log.exception(headline)


_ENGINE = _Engine()


def start() -> int:
    """Bind ``127.0.0.1:0``, serve the Studio on a daemon thread, return the bound port.

    Already serving: the same port. Raises ``EmbeddedStartError`` when the app or the
    listener cannot come up; ``status()`` then says why.
    """
    return _ENGINE.start()


def stop() -> None:
    """Stop serving. Safe to repeat. The app and the bound port stay, so ``start()`` serves again."""
    _ENGINE.stop()


def status() -> EmbeddedState:
    return _ENGINE.status()
