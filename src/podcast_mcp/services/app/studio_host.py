"""Find the Studio that serves a project, and hand it a CLI command (#1733).

Studio and the CLI both write the project file, and a Studio busy with a long job (the mix
build) keeps the project lock. While a Studio serves a project, the CLI therefore hands
each project command to that Studio instead of racing it for the file: Studio is the one
writer, and the change shows on screen as it happens. With no Studio serving the project,
the CLI writes directly.

A serving Studio announces itself with ``artifacts/studio-host.json`` (mode 0600: pid,
loopback address and a per-run token) and withdraws it on exit or when it stops serving
the project. The file can outlive a crashed Studio, so it is only a pointer: ``locate_studio``
asks the address named in it and accepts the answer only from the same run that wrote it.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import secrets
import stat
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import quote

from podcast_mcp import settings
from podcast_mcp.models import workspace_artifacts_dir
from podcast_mcp.project.io import resolve_project_path
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic

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
#: Studio sends a heartbeat every few seconds; silence for this long means it is wedged.
STREAM_SILENCE_TIMEOUT_SEC = 30.0
CANCEL_GRACE_SEC = 30.0
#: What a direct run exits with after Ctrl+C.
_CANCELLED_EXIT_CODE = 130
#: Terminal control characters (escape sequences, bell) never pass through from Studio.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
#: Environment variables that never decide whether a command may run in Studio.
_ENV_PREFIX = "PODCAST_"
_ENV_SKIPPED_FRAGMENTS = ("TOKEN", "SECRET", "KEY", "PASSWORD", "SIDECAR")


@dataclass(frozen=True)
class StudioHost:
    """The Studio run that announced itself for one project."""

    instance: str
    pid: int
    host: str
    port: int
    token: str
    version: str


class HandoffRefused(Exception):
    """Studio answered but will not run this command; the caller writes directly instead."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class StudioUnresponsive(Exception):
    """A Studio is announced for the project and accepts connections, but did not answer.

    Nothing was run. The caller must not write the project directly, which could clobber
    what Studio holds.
    """

    def __init__(self, host: StudioHost) -> None:
        super().__init__(
            f"Studio (pid {host.pid}) is serving this project but did not answer in time. "
            f"Try again in a moment, or set {DIRECT_ENV_VAR}=1 to write directly "
            "(this may overwrite what Studio is holding)."
        )
        self.host = host


class HandoffLost(Exception):
    """Studio accepted the command, then stopped answering before it finished.

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
    write_json_atomic(
        path,
        {
            "instance": host.instance,
            "pid": host.pid,
            "host": host.host,
            "port": host.port,
            "token": host.token,
            "version": host.version,
        },
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
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if host.host not in _LOOPBACK_HOSTS or not 0 < host.port < 65536 or not host.token:
        return None
    return host


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


def _headers(host: StudioHost) -> dict[str, str]:
    return {HANDOFF_TOKEN_HEADER: host.token, "Accept": "application/json"}


def _ping(host: StudioHost, resolved: str) -> tuple[int, dict[str, Any]]:
    conn = _connection(host, PING_TIMEOUT_SEC)
    try:
        conn.request(
            "GET", f"{HANDOFF_PING_PATH}?project={quote(resolved)}", headers=_headers(host)
        )
        response = conn.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        conn.close()


def locate_studio(project_path: Path | str) -> StudioHost | None:
    """The Studio that is serving ``project_path`` right now, or None to write directly.

    Raises ``StudioUnresponsive`` when a Studio accepts the connection but stays silent.
    """
    if settings.flag(DIRECT_ENV_VAR):
        return None
    host = read_studio_host(project_path)
    if host is None:
        return None
    resolved = str(resolve_project_path(project_path))
    try:
        try:
            status, body = _ping(host, resolved)
        except TimeoutError:
            status, body = _ping(host, resolved)
    except TimeoutError:
        raise StudioUnresponsive(host) from None
    except (OSError, http.client.HTTPException, ValueError):
        log.debug("studio announced at %s:%s did not answer", host.host, host.port)
        return None
    if (
        status != 200
        or body.get("instance") != host.instance
        or body.get("protocol") != HANDOFF_PROTOCOL
        or body.get("serves") is not True
    ):
        return None
    return host


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

    Raises ``HandoffRefused`` when Studio declines before running anything, and
    ``HandoffLost`` when it stops answering after it started. Ctrl+C asks Studio to cancel
    the command (the way ``podcast`` cancels its own long commands) and keeps relaying until
    it ends; a second Ctrl+C stops waiting.
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
        except TimeoutError as exc:
            raise HandoffLost(_lost_message(host, None, "it did not answer in time")) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise HandoffRefused("unreachable", f"Studio did not answer ({exc})") from exc
        if response.status != 200:
            raise _refusal(response)
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
                raise HandoffLost(
                    _lost_message(host, run_id, f"it stopped answering ({exc})")
                ) from exc
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
        ""
        if run_id is None
        else " The command had already started and may have changed the project."
    )
    return (
        f"Studio (pid {host.pid}) was running this command for the project, but {why}."
        f"{started} Check the project in Studio (or run `podcast history-status --project <project>`) "
        "before you run it again."
    )


def _cancel(host: StudioHost, run_id: str | None) -> None:
    if run_id is None:
        return
    try:
        conn = _connection(host, PING_TIMEOUT_SEC)
        try:
            conn.request(
                "POST", f"{HANDOFF_CANCEL_PATH}?run={quote(run_id)}", headers=_headers(host)
            )
            conn.getresponse().read()
        finally:
            conn.close()
    except (OSError, http.client.HTTPException):
        log.debug("cancel request to Studio failed", exc_info=True)


def _refusal(response: http.client.HTTPResponse) -> HandoffRefused:
    detail = ""
    code = f"http_{response.status}"
    try:
        body: Any = json.loads(response.read().decode("utf-8"))
        detail = str(body.get("detail", ""))
        code = str(body.get("code", code))
    except (ValueError, AttributeError):
        pass
    return HandoffRefused(code, detail or f"Studio answered HTTP {response.status}")
