"""Find the Studio that serves a project, and hand it a CLI command (#1733).

Studio and the CLI both write the project file, and a Studio busy with a long job (the mix
build) keeps the project lock. While a Studio serves a project, the CLI therefore hands
each project command to that Studio instead of racing it for the file: Studio is the one
writer, and the change shows on screen as it happens. With no Studio serving the project,
the CLI writes directly.

A serving Studio announces itself with ``artifacts/studio-host.json`` (mode 0600: pid,
address and a per-run token) and withdraws it on exit or when it stops serving the project.
The file can outlive a crashed Studio, so it is only a pointer: ``locate_studio`` asks the
address named in it and accepts the answer only from the same run that wrote it. A Studio
bound to an address no client may ping (127.0.0.2, a LAN address) announces that address
and the machine's name; ``locate_studio`` then only checks that something listens there and
refuses, since Studio cannot take the command.
"""

from __future__ import annotations

import dataclasses
import errno
import http.client
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import stat
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import quote

from podcast_mcp import settings
from podcast_mcp.models import workspace_artifacts_dir
from podcast_mcp.project.io import resolve_project_path
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.process import pid_is_alive

log = logging.getLogger(__name__)

HANDOFF_PROTOCOL = 1
STUDIO_HOST_FILENAME = "studio-host.json"
HANDOFF_TOKEN_HEADER = "X-Sharecut-Handoff-Token"
HANDOFF_PING_PATH = "/api/handoff/ping"
HANDOFF_RUN_PATH = "/api/handoff/run"
HANDOFF_CANCEL_PATH = "/api/handoff/cancel"

#: Opt out of the handoff and write directly (the command then races Studio for the lock).
DIRECT_ENV_VAR = "PODCAST_NO_STUDIO_HANDOFF"

#: A ping that times out is retried once; a Studio still silent is never bypassed.
PING_TIMEOUT_SEC = 5.0
#: The bare connect to an address that cannot be pinged; a silence this long fails closed.
PROBE_TIMEOUT_SEC = 1.0
#: A Studio ping reply is a few dozen bytes; a longer body is not a Studio reply.
PING_BODY_MAX_BYTES = 1 << 20
#: Studio sends a heartbeat every few seconds; silence for this long means it is wedged.
STREAM_SILENCE_TIMEOUT_SEC = 30.0
CANCEL_GRACE_SEC = 30.0
#: What a direct run exits with after Ctrl+C.
_CANCELLED_EXIT_CODE = 130
#: Terminal control characters (escape sequences, bell) never pass through from Studio.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_LOOPBACK_ADDRESSES = {
    "127.0.0.1": ((socket.AF_INET, "127.0.0.1"),),
    "::1": ((socket.AF_INET6, "::1"),),
    "localhost": ((socket.AF_INET6, "::1"), (socket.AF_INET, "127.0.0.1")),
}
#: Environment variables that never decide whether a command may run in Studio.
_ENV_PREFIX = "PODCAST_"
_ENV_SKIPPED_FRAGMENTS = ("TOKEN", "SECRET", "KEY", "PASSWORD", "SIDECAR")
DIRECT_RUN_REFUSAL_CODES = frozenset({"not_served", "not_eligible", "protocol", "env_differs"})
_TERMINAL_RUN_REFUSALS = frozenset(
    {
        (401, "bad_token"),
        (403, "relayed"),
        (403, "not_local"),
        (409, "project_alias"),
        (429, "too_many"),
    }
)


@dataclass(frozen=True)
class StudioHost:
    """The Studio run that announced itself for one project."""

    instance: str
    pid: int
    host: str
    port: int
    token: str
    version: str
    #: Whether the Studio mounts /mcp (a non-loopback bind does not). Stdio MCP refuses calls to a
    #: Studio that does not. Never written to the file.
    mcp: bool = True
    #: This machine's name, written only for an address that cannot be pinged, so a file that
    #: reached another computer (a shared folder) is not probed there.
    hostname: str = ""


class HandoffRefused(Exception):
    """Studio explicitly rejected the command before execution.

    Only defined 409 refusal codes permit the caller to write directly.
    """

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class StudioUnresponsive(Exception):
    """A Studio is announced for the project and accepts connections, but did not answer.

    Nothing was run. The caller must not write the project directly, which could clobber
    what Studio holds.
    """

    def __init__(self, host: StudioHost, announcement: Path | None = None) -> None:
        stale = (
            f" If no Studio is running, delete {announcement}." if announcement is not None else ""
        )
        super().__init__(
            f"Studio (pid {host.pid}) is serving this project but did not answer in time. "
            f"Try again in a moment, or set {DIRECT_ENV_VAR}=1 to write directly "
            f"(this may overwrite what Studio is holding).{stale}"
        )
        self.host = host


class StudioBadReply(StudioUnresponsive):
    """A Studio is announced but answered the ping with an invalid or unsupported reply.

    The caller cannot safely establish a handoff, so it must not write directly on its own.
    """

    def __init__(self, host: StudioHost) -> None:
        Exception.__init__(
            self,
            f"Studio (pid {host.pid}) is announced for this project but answered the handoff "
            "check with a reply that is not a Studio reply or uses an unsupported protocol. "
            f"Nothing was run. Set {DIRECT_ENV_VAR}=1 to write directly "
            "(this may overwrite what Studio is holding).",
        )
        self.host = host


class StudioNotReachable(StudioUnresponsive):
    """A Studio serves the project on an address that cannot be pinged, so it cannot take work.

    Nothing was run. The caller must not write the project directly, which could clobber
    what Studio holds.
    """

    def __init__(self, host: StudioHost, announcement: Path) -> None:
        Exception.__init__(
            self,
            f"Studio (pid {host.pid}) is serving this project, bound to {host.host}, an address "
            "podcast commands and the stdio MCP server cannot hand work to. Nothing was run. "
            f"Restart Studio with `--host 127.0.0.1`, or set {DIRECT_ENV_VAR}=1 to write "
            "directly (this may overwrite what Studio is holding). If no Studio is running, "
            f"delete {announcement}.",
        )
        self.host = host


class HandoffLost(Exception):
    """A command attempt has no confirmed outcome, or its stream ended before completion.

    The command may have changed the project, so the caller must not run it again on its own.
    """


def new_instance_id() -> str:
    return secrets.token_hex(8)


def new_token() -> str:
    return secrets.token_urlsafe(24)


def studio_host_path(project_path: Path | str) -> Path:
    """Where the Studio serving ``project_path`` announces itself."""
    # ``--project`` may name the workspace folder as well as its project file.
    workspace = resolve_project_path(project_path).parent
    return workspace_artifacts_dir(workspace) / STUDIO_HOST_FILENAME


def announce_studio_host(project_path: Path | str, host: StudioHost) -> None:
    """Write the announcement for ``project_path`` (private to the user, replaced atomically)."""
    path = studio_host_path(project_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "instance": host.instance,
        "pid": host.pid,
        "host": host.host,
        "port": host.port,
        "token": host.token,
        "version": host.version,
    }
    if host.hostname:
        payload["hostname"] = host.hostname
    write_json_atomic(
        path,
        payload,
        mode=stat.S_IRUSR | stat.S_IWUSR,
        compact=True,
    )


def withdraw_studio_host(project_path: Path | str, instance: str) -> None:
    """Remove this run's announcement; another run's file is left alone."""
    path = studio_host_path(project_path)
    current = read_studio_host(project_path)
    if current is not None and current.instance == instance:
        path.unlink(missing_ok=True)


def read_studio_host(project_path: Path | str) -> StudioHost | None:
    path = studio_host_path(project_path)
    try:
        if not _owned_privately(path):
            return None
        raw = load_json_object(path)
        if raw is None:
            return None
        host = StudioHost(
            instance=str(raw["instance"]),
            pid=int(raw["pid"]),
            host=str(raw["host"]),
            port=int(raw["port"]),
            token=str(raw["token"]),
            version=str(raw.get("version", "")),
            hostname=str(raw.get("hostname", "")),
        )
    except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError):
        return None
    if not _is_address(host.host) or not 0 < host.port < 65536 or not host.token:
        return None
    return host


def _is_address(name: str) -> bool:
    """A loopback name a client may ping, or an IP literal (a name is never resolved from a file)."""
    if name in _LOOPBACK_ADDRESSES:
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def _owned_privately(path: Path) -> bool:
    """The announcement is ours alone: a file another user (or a shared folder) planted is no pointer."""
    if not hasattr(os, "getuid"):
        return True
    info = path.stat()
    return info.st_uid == os.getuid() and not info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)


def _plain(text: str) -> str:
    return _CONTROL_CHARS.sub("", text)


def _connection(host: StudioHost, timeout: float) -> http.client.HTTPConnection:
    return http.client.HTTPConnection(host.host, host.port, timeout=timeout)


_WSAETIMEDOUT = 10060


def _is_timeout(exc: BaseException) -> bool:
    """A socket timeout, including the Windows one that surfaces as a plain ``OSError``."""
    if isinstance(exc, TimeoutError):
        return True
    if not isinstance(exc, OSError):
        return False
    windows_code = getattr(exc, "winerror", None)
    return exc.errno in (errno.ETIMEDOUT, _WSAETIMEDOUT) or windows_code == _WSAETIMEDOUT


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Studio ping deadline expired")
    return remaining


class _DeadlineSocket(socket.socket):
    def __init__(self, family: socket.AddressFamily, *, deadline: float) -> None:
        super().__init__(family, socket.SOCK_STREAM)
        self.deadline = deadline

    def connect(self, address: Any) -> None:
        self.settimeout(_remaining(self.deadline))
        try:
            super().connect(address)
        except OSError:
            _remaining(self.deadline)
            raise

    def sendall(self, data: Any, flags: int = 0) -> None:
        self.settimeout(_remaining(self.deadline))
        try:
            super().sendall(data, flags)
        except OSError:
            _remaining(self.deadline)
            raise

    def recv_into(self, buffer: Any, nbytes: int = 0, flags: int = 0) -> int:
        self.settimeout(_remaining(self.deadline))
        try:
            return super().recv_into(buffer, nbytes, flags)
        except OSError:
            _remaining(self.deadline)
            raise


class _PingConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, *, deadline: float) -> None:
        super().__init__(host, port, timeout=_remaining(deadline))
        self.deadline = deadline
        self._create_connection = self._dial

    def _dial(
        self,
        address: tuple[str, int],
        _timeout: float,
        _source_address: tuple[str, int] | None,
    ) -> _DeadlineSocket:
        host, port = address
        last_error: OSError | None = None
        timed_out: OSError | None = None
        for family, ip in _LOOPBACK_ADDRESSES[host]:
            sock: _DeadlineSocket | None = None
            try:
                sock = _DeadlineSocket(family, deadline=self.deadline)
                sock.connect((ip, port))
                return sock
            except OSError as exc:
                if sock is not None:
                    sock.close()
                _remaining(self.deadline)
                last_error = exc
                if _is_timeout(exc):
                    timed_out = exc
        assert last_error is not None
        raise timed_out or last_error


def _headers(host: StudioHost) -> dict[str, str]:
    return {HANDOFF_TOKEN_HEADER: host.token, "Accept": "application/json"}


def _ping(host: StudioHost, resolved: str) -> tuple[int, Any]:
    deadline = time.monotonic() + PING_TIMEOUT_SEC
    conn = _PingConnection(host.host, host.port, deadline=deadline)
    response: http.client.HTTPResponse | None = None
    try:
        conn.request(
            "GET", f"{HANDOFF_PING_PATH}?project={quote(resolved)}", headers=_headers(host)
        )
        response = conn.getresponse()
        status = response.status
        try:
            raw = response.read(PING_BODY_MAX_BYTES + 1)
            if len(raw) > PING_BODY_MAX_BYTES:
                _remaining(deadline)
                return status, None
            body = json.loads(raw.decode("utf-8"))
            _remaining(deadline)
            return status, body
        except (OSError, http.client.HTTPException, ValueError, RecursionError) as exc:
            if _is_timeout(exc):
                raise
            _remaining(deadline)
            return status, None
    except (OSError, http.client.HTTPException, ValueError):
        _remaining(deadline)
        raise
    finally:
        if response is not None:
            response.close()
        conn.close()


def _is_refused(exc: OSError) -> bool:
    return isinstance(exc, ConnectionRefusedError)


def _is_this_machine(announced: str) -> bool:
    """True when ``announced`` names this machine, ignoring case and any domain suffix."""

    def first_label(name: str) -> str:
        return name.split(".", 1)[0].lower()

    return bool(announced) and first_label(announced) == first_label(socket.gethostname())


def _check_unpingable(host: StudioHost, project_path: Path | str) -> None:
    """Refuse for a Studio that listens on an address no client may ping; None if it is gone.

    A bare connect sends no bytes, so the token never leaves for an address Studio would
    reject. Anything but a refusal fails closed.
    """
    try:
        socket.create_connection((host.host, host.port), timeout=PROBE_TIMEOUT_SEC).close()
    except (OSError, ValueError) as exc:
        # ValueError: a scoped literal the resolver cannot encode, which no connect can answer.
        if isinstance(exc, OSError) and _is_refused(exc):
            return
        raise StudioUnresponsive(host, studio_host_path(project_path)) from exc
    raise StudioNotReachable(host, studio_host_path(project_path))


def locate_studio(project_path: Path | str) -> StudioHost | None:
    """Find the Studio serving ``project_path``, or return None when it is absent.

    Raises ``StudioUnresponsive`` when both discovery attempts time out,
    ``StudioBadReply`` when Studio answers with an invalid or unsupported reply, and
    ``StudioNotReachable`` when Studio listens on an address no client may ping.
    """
    if settings.flag(DIRECT_ENV_VAR):
        return None
    host = read_studio_host(project_path)
    if host is None:
        return None
    if host.host not in _LOOPBACK_ADDRESSES:
        if not _is_this_machine(host.hostname) or not pid_is_alive(host.pid):
            return None
        _check_unpingable(host, project_path)
        return None
    if not pid_is_alive(host.pid):
        return None
    resolved = str(resolve_project_path(project_path))
    try:
        try:
            status, body = _ping(host, resolved)
        except OSError as exc:
            if not _is_timeout(exc):
                raise
            # The first attempt timed out, so a live Studio is wedged: the retry either
            # answers or the Studio is unresponsive, whatever way the retry fails.
            try:
                status, body = _ping(host, resolved)
            except (OSError, http.client.HTTPException, ValueError):
                raise StudioUnresponsive(host) from None
    except (OSError, http.client.HTTPException, ValueError):
        log.debug("studio announced at %s:%s did not answer", host.host, host.port)
        return None
    if status != 200:
        raise StudioBadReply(host)
    if not isinstance(body, dict):
        raise StudioBadReply(host)
    instance = body.get("instance")
    if not isinstance(instance, str) or not instance:
        raise StudioBadReply(host)
    if instance != host.instance:
        return None
    protocol = body.get("protocol")
    if type(protocol) is not int or protocol != HANDOFF_PROTOCOL:
        raise StudioBadReply(host)
    serves = body.get("serves")
    if not isinstance(serves, bool):
        raise StudioBadReply(host)
    if not serves:
        return None
    # An older Studio sends no key and does mount /mcp.
    return dataclasses.replace(host, mcp=body.get("mcp") is not False)


def handoff_env(environ: Mapping[str, str]) -> dict[str, str]:
    """The caller's ``PODCAST_*`` settings that could change how a command behaves."""
    return {
        key: value
        for key, value in environ.items()
        if key.startswith(_ENV_PREFIX)
        and key != DIRECT_ENV_VAR
        and not any(fragment in key for fragment in _ENV_SKIPPED_FRAGMENTS)
    }


def env_differences(requested: Mapping[str, str], environ: Mapping[str, str]) -> list[str]:
    """Names of the requested settings this process does not share (values never leave)."""
    return sorted(key for key, value in requested.items() if environ.get(key) != value)


def hand_off(
    host: StudioHost,
    *,
    argv: list[str],
    project: str,
    cwd: str,
    out: TextIO,
    err: TextIO,
    on_interrupt: Callable[[], None] | None = None,
) -> int:
    """Run ``argv`` in the Studio and relay its output; returns the command's exit code.

    Raises ``HandoffRefused`` for a defined pre-execution rejection, and
    ``HandoffLost`` when the outcome may be uncertain, even before a start event.
    Ctrl+C asks Studio to cancel the command (the way ``podcast`` cancels its own long
    commands) and keeps relaying until it ends; a second Ctrl+C stops waiting.
    """
    from podcast_mcp import __version__

    payload = json.dumps(
        {
            "protocol": HANDOFF_PROTOCOL,
            "argv": argv,
            "project": project,
            "cwd": cwd,
            "env": handoff_env(settings.environ()),
            "client": {"pid": os.getpid(), "version": __version__},
        }
    )
    conn = _connection(host, STREAM_SILENCE_TIMEOUT_SEC)
    run_id: str | None = None
    interrupted = False
    try:
        try:
            conn.request(
                "POST",
                HANDOFF_RUN_PATH,
                body=payload,
                headers={**_headers(host), "Content-Type": "application/json"},
            )
            response = conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            if _is_timeout(exc):
                raise HandoffLost(_lost_message(host, None, "it did not answer in time")) from exc
            raise HandoffLost(_lost_message(host, None, "it stopped answering")) from exc
        if response.status != 200:
            raise _refusal(host, response)
        while True:
            try:
                line = response.readline()
            except KeyboardInterrupt:
                if interrupted:
                    raise
                interrupted = True
                err.write("Cancelling in Studio. Press Ctrl+C again to stop waiting.\n")
                if on_interrupt is not None:
                    on_interrupt()
                _cancel(host, run_id)
                if conn.sock is not None:
                    conn.sock.settimeout(CANCEL_GRACE_SEC)
                continue
            except (OSError, http.client.HTTPException) as exc:
                if interrupted:
                    return _CANCELLED_EXIT_CODE
                raise HandoffLost(_lost_message(host, run_id, "it stopped answering")) from exc
            if not line:
                if interrupted:
                    # An interrupted read can end the stream; Studio is stopping the command.
                    err.write("Cancelled. Studio is stopping the command.\n")
                    return _CANCELLED_EXIT_CODE
                raise HandoffLost(_lost_message(host, run_id, "it closed the connection"))
            try:
                event = json.loads(line)
            except ValueError as exc:
                raise HandoffLost(
                    _lost_message(host, run_id, "it sent output this command cannot read")
                ) from exc
            kind = event.get("t")
            if kind == "start":
                run_id = str(event["run"])
                if interrupted:
                    _cancel(host, run_id)
            elif kind == "out":
                out.write(_plain(event["s"]))
                out.flush()
            elif kind == "err":
                err.write(_plain(event["s"]))
                err.flush()
            elif kind == "exit":
                return int(event["code"])
    finally:
        conn.close()


def _lost_message(host: StudioHost, run_id: str | None, why: str) -> str:
    started = (
        " The command may have run and may have changed the project."
        if run_id is None
        else " The command had already started and may have changed the project."
    )
    return (
        f"Studio (pid {host.pid}) was asked to run this command, but {why}."
        f"{started} Check the project in Studio (or run `podcast history-status --project <project>`) "
        "before you run it again."
    )


def _cancel(host: StudioHost, run_id: str | None) -> None:
    if run_id is None:
        return
    try:
        conn = _PingConnection(host.host, host.port, deadline=time.monotonic() + PING_TIMEOUT_SEC)
        response: http.client.HTTPResponse | None = None
        try:
            conn.request(
                "POST", f"{HANDOFF_CANCEL_PATH}?run={quote(run_id)}", headers=_headers(host)
            )
            response = conn.getresponse()
            response.read()
        finally:
            if response is not None:
                response.close()
            conn.close()
    except (OSError, http.client.HTTPException):
        log.debug("cancel request to Studio failed", exc_info=True)


def _refusal(host: StudioHost, response: http.client.HTTPResponse) -> HandoffRefused | HandoffLost:
    try:
        body: Any = json.loads(response.read().decode("utf-8"))
    except (OSError, http.client.HTTPException, ValueError, RecursionError):
        body = None
    if isinstance(body, dict):
        code = body.get("code")
        detail = body.get("detail")
        if isinstance(code, str) and isinstance(detail, str):
            if response.status == 409 and code in DIRECT_RUN_REFUSAL_CODES:
                return HandoffRefused(code, detail or "Studio declined this command.")
            if (response.status, code) in _TERMINAL_RUN_REFUSALS:
                return HandoffRefused(code, detail or "Studio declined this command.")
    return HandoffLost(_lost_message(host, None, "it answered with an unexpected response"))
