"""Run CLI commands for other processes while this Studio serves their project (#1733).

The CLI hands a project command to the Studio that serves the project (``cli/handoff.py``),
so Studio is the one writer and the change shows on screen as it happens. Three routes:
``GET /api/handoff/ping`` (does this run serve the project), ``POST /api/handoff/run``
(run a command, streamed back as one JSON object per line) and ``POST /api/handoff/cancel``.

Every route needs the per-run token that Studio wrote to ``artifacts/studio-host.json``
(mode 0600), so only a process that can read the project's folder can run commands, on top of
the loopback and Host checks every host route has. While Studio is busy with its own job for
the project, a handed-off command waits for it and says so, instead of failing with a busy
lock.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import ipaddress
import logging
import os
import queue
import secrets
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from podcast_mcp import __version__, settings
from podcast_mcp.cli.handoff import execute_command, plan_handoff
from podcast_mcp.gui.routes.deps import peer_host
from podcast_mcp.project.io import resolve_project_path
from podcast_mcp.services.app import (
    HANDOFF_PROTOCOL,
    HANDOFF_TOKEN_HEADER,
    StudioHost,
    announce_studio_host,
    env_differences,
    new_instance_id,
    new_token,
    withdraw_studio_host,
)
from podcast_mcp.services.jobs import LIVE_JOB_STATUSES
from podcast_mcp.services.session_sync import is_loopback_host
from podcast_mcp.util.proxy_paths import is_relayed_request

log = logging.getLogger(__name__)
router = APIRouter(tags=["handoff"])

MAX_CONCURRENT_RUNS = 8
HEARTBEAT_SEC = 5.0
#: A handed-off command that has run this long is probably waiting for Studio's own job.
BUSY_NOTICE_AFTER_SEC = 2.0
BUSY_NOTICE_EVERY_SEC = 30.0


def _binds_loopback(bind_host: str) -> bool:
    """True when a server bound to ``bind_host`` answers on this computer's loopback address
    (a wildcard bind does too)."""
    if bind_host in {"", "localhost"}:
        return True
    try:
        address = ipaddress.ip_address(bind_host)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


@dataclass
class _Run:
    id: str
    cancel: threading.Event = field(default_factory=threading.Event)
    events: queue.Queue[dict[str, Any]] = field(default_factory=queue.Queue)

    def emit(self, kind: str, **fields: Any) -> None:
        self.events.put({"t": kind, **fields})


class StudioHostState:
    """This Studio run's identity, and the handed-off commands it is running."""

    def __init__(self, bind_host: str) -> None:
        self.instance = new_instance_id()
        self.token = new_token()
        self.bind_host = bind_host
        self.port: int | None = None
        self.announced: Path | None = None
        self.runs: dict[str, _Run] = {}
        self.lock = threading.Lock()
        # Serializes announce/withdraw so overlapping pins and a shutdown cannot orphan a file.
        self.announce_lock = threading.RLock()

    @property
    def address(self) -> str | None:
        """The loopback address local processes reach this Studio at, if it has one."""
        if not _binds_loopback(self.bind_host):
            return None
        return "::1" if self.bind_host == "::1" else "127.0.0.1"


def _state(app: Any) -> StudioHostState:
    return app.state.studio_host  # type: ignore[no-any-return]


def set_served_project(app: Any, project_path: Path | None) -> None:
    """Point this Studio at ``project_path`` (None: none), keeping the announcement true."""
    app.state.served_project = project_path
    app.state.jobs.set_served_project(project_path)
    _announce(app)


def _announce(app: Any) -> None:
    """Announce the served project to local CLIs, and withdraw the one it replaces."""
    state = _state(app)
    with state.announce_lock:
        _announce_locked(app, state)


def _announce_locked(app: Any, state: StudioHostState) -> None:
    served = app.state.served_project
    previous, state.announced = state.announced, None
    if previous is not None and previous != served:
        _withdraw(previous, state)
    if served is None or state.port is None or state.address is None:
        return
    try:
        announce_studio_host(
            served,
            StudioHost(
                instance=state.instance,
                pid=os.getpid(),
                host=state.address,
                port=state.port,
                token=state.token,
                version=__version__,
            ),
        )
    except OSError:
        log.warning("Could not announce Studio for %s; the CLI will write directly", served)
        return
    state.announced = Path(served)


def _withdraw(project_path: Path, state: StudioHostState) -> None:
    try:
        withdraw_studio_host(project_path, state.instance)
    except OSError:
        log.warning("Could not withdraw the Studio announcement for %s", project_path)


def listening(app: Any, *, port: int) -> None:
    """The server is bound: from here local CLIs can reach it."""
    _state(app).port = port
    _announce(app)


def stopped(app: Any) -> None:
    """The server is going down: withdraw the announcement."""
    state = _state(app)
    with state.announce_lock:
        announced, state.announced = state.announced, None
        state.port = None
        if announced is not None:
            _withdraw(announced, state)
    for run in list(state.runs.values()):
        run.cancel.set()


def _refuse(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse({"code": code, "detail": detail}, status_code=status)


def _unauthorized(request: Request) -> JSONResponse | None:
    state = _state(request.app)
    if is_relayed_request(request.headers):
        return _refuse(403, "relayed", "Handed-off commands are not accepted through a relay.")
    peer = peer_host(request)
    if peer is not None and not is_loopback_host(peer):
        return _refuse(
            403, "not_local", "Handed-off commands are accepted from this computer only."
        )
    provided = request.headers.get(HANDOFF_TOKEN_HEADER, "")
    if not secrets.compare_digest(provided.encode(), state.token.encode()):
        return _refuse(401, "bad_token", "The Studio announcement is out of date.")
    return None


def _serves(request: Request, project: str) -> bool:
    served = request.app.state.served_project
    if served is None:
        return False
    try:
        return resolve_project_path(project) == resolve_project_path(served)
    except (OSError, ValueError):
        return False


@router.get("/api/handoff/ping")
def ping(request: Request, project: str) -> JSONResponse:
    denied = _unauthorized(request)
    if denied is not None:
        return denied
    return JSONResponse(
        {
            "instance": _state(request.app).instance,
            "protocol": HANDOFF_PROTOCOL,
            "serves": _serves(request, project),
            "version": __version__,
        }
    )


class RunBody(BaseModel):
    protocol: int
    argv: list[str] = Field(max_length=256)
    project: str
    cwd: str
    env: dict[str, str] = Field(default_factory=dict)
    client: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/handoff/run", response_model=None)
async def run(request: Request, body: RunBody) -> StreamingResponse | JSONResponse:
    denied = _unauthorized(request)
    if denied is not None:
        return denied
    if body.protocol != HANDOFF_PROTOCOL:
        return _refuse(
            409,
            "protocol",
            f"Studio {__version__} and this podcast command speak different handoff versions.",
        )
    if not _serves(request, body.project):
        return _refuse(409, "not_served", "This Studio is not serving that project.")
    differing = env_differences(body.env, settings.environ())
    if differing:
        return _refuse(
            409,
            "env_differs",
            f"Your {', '.join(differing)} setting differs from the one Studio runs with.",
        )
    from podcast_mcp.cli.main import app as cli_app

    plan = plan_handoff(_click_root(cli_app), body.argv, Path(body.cwd))
    if plan is None or plan.argv != body.argv or not _serves(request, str(plan.project)):
        return _refuse(409, "not_eligible", "That command does not run in Studio.")
    state = _state(request.app)
    with state.lock:
        if len(state.runs) >= MAX_CONCURRENT_RUNS:
            return _refuse(
                429, "too_many", "Studio is already running several handed-off commands."
            )
        handed = _Run(id=uuid.uuid4().hex)
        state.runs[handed.id] = handed
    threading.Thread(
        target=_work,
        args=(request.app, handed, plan.argv, str(plan.project)),
        name=f"handoff-{handed.id[:8]}",
        daemon=True,
    ).start()
    return StreamingResponse(_stream(state, handed), media_type="application/x-ndjson")


@functools.cache
def _click_root(typer_app: Any) -> Any:
    import typer.main

    return typer.main.get_command(typer_app)


async def _stream(state: StudioHostState, handed: _Run) -> Any:
    import json

    try:
        yield json.dumps({"t": "start", "run": handed.id}) + "\n"
        while True:
            try:
                event = await asyncio.to_thread(handed.events.get, True, HEARTBEAT_SEC)
            except queue.Empty:
                yield json.dumps({"t": "hb"}) + "\n"
                continue
            yield json.dumps(event) + "\n"
            if event["t"] == "exit":
                return
    finally:
        # The caller went away (or the command ended): a command still running stops.
        handed.cancel.set()


@router.post("/api/handoff/cancel")
def cancel(request: Request, run: str) -> JSONResponse:
    denied = _unauthorized(request)
    if denied is not None:
        return denied
    state = _state(request.app)
    with state.lock:
        handed = state.runs.get(run)
    if handed is None:
        return _refuse(404, "unknown_run", "That command is not running.")
    handed.cancel.set()
    return JSONResponse({"ok": True})


def _busy_notice(app: Any, project: str) -> str | None:
    """What Studio itself is doing with the project right now, or None.

    Jobs that handed-off commands run for other processes are not Studio's own work, so
    they never hold another command back (an edit made during a pipeline run still lands).
    """
    status = app.state.jobs.status(project)
    own = [
        job
        for job in status.get("jobs", [])
        if job.get("kind") != "agent" and job.get("status") in LIVE_JOB_STATUSES
    ]
    if not own:
        return None
    job = own[0]
    what = job.get("label") or job.get("kind") or "a job"
    elapsed = int(job.get("elapsed_sec") or 0)
    return (
        f"Studio is busy with {what} ({elapsed}s so far); this command waits for it if it needs "
        "the project."
    )


def _say_when_studio_is_busy(
    app: Any, handed: _Run, project: str, finished: threading.Event
) -> None:
    """While the command runs, tell the caller what Studio is busy with (a command waiting on
    Studio's own job otherwise looks stuck)."""
    wait = BUSY_NOTICE_AFTER_SEC
    while not finished.wait(wait):
        notice = _busy_notice(app, project)
        if notice is not None:
            handed.emit("err", s=notice + "\n")
        wait = BUSY_NOTICE_EVERY_SEC


def _work(app: Any, handed: _Run, argv: list[str], project: str) -> None:
    code = 1
    finished = threading.Event()
    threading.Thread(
        target=_say_when_studio_is_busy,
        args=(app, handed, project, finished),
        name=f"handoff-notice-{handed.id[:8]}",
        daemon=True,
    ).start()
    try:
        code = contextvars.Context().run(
            execute_command,
            argv,
            cancel=handed.cancel.is_set,
            stdout=lambda text: handed.emit("out", s=text),
            stderr=lambda text: handed.emit("err", s=text),
        )
    except Exception:  # the caller must always get an exit
        log.exception("handed-off command crashed: %s", argv[:2])
        handed.emit("err", s="Error: the command crashed inside Studio (see Studio's log).\n")
    finally:
        finished.set()
        # The slot is held until the command itself ends, not just until the caller leaves.
        with _state(app).lock:
            _state(app).runs.pop(handed.id, None)
        with contextlib.suppress(Exception):
            handed.emit("exit", code=code)
