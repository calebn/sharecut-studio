"""TunnelSupervisor brings the host tunnel up inside the Studio process on its own.

``plan`` is the whole policy: given one snapshot of the world it names the single tunnel that
should exist. The supervisor only converges to it, so a missed tick costs latency, never a wrong
end state.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from filelock import FileLock, Timeout

from podcast_mcp.config.runtime import RelayConfig, ready_relay_config
from podcast_mcp.models import load_project
from podcast_mcp.services.collaboration.review_shares import usable_share_tokens
from podcast_mcp.services.collaboration.tunnel import TunnelClient
from podcast_mcp.services.collaboration.tunnel_status import (
    LineListener,
    StatusFileListener,
    StatusListener,
    status_file_is_live,
    studio_lock_path,
    studio_status_path,
    tunnel_status_path,
)
from podcast_mcp.util import host_platform

log = logging.getLogger(__name__)

POLL_SEC = 2.0
LINGER_SEC = 120.0
STOP_TIMEOUT_SEC = 5.0


class IdleReason(StrEnum):
    """Why this Studio runs no tunnel. Exactly one per Idle."""

    NOT_CAPABLE = "not_capable"
    NOT_LISTENING = "not_listening"
    NOT_SET_UP = "not_set_up"
    REJECTED = "rejected"
    NO_PROJECT = "no_project"
    ELSEWHERE = "elsewhere"
    NO_LIVE_LINKS = "no_live_links"


@dataclass(frozen=True, slots=True)
class Idle:
    reason: IdleReason


@dataclass(frozen=True, slots=True)
class Serve:
    """The one tunnel that should run. A different ``relay`` means restart; a different project or
    link set means readvertise."""

    relay: RelayConfig
    project: Path
    links: frozenset[str]


Plan = Idle | Serve


@dataclass(frozen=True, slots=True)
class Inputs:
    """One blocking snapshot of the world. Pure data."""

    listen_port: int | None
    relay: RelayConfig | None
    project: Path | None
    links: frozenset[str]
    cli_live: bool
    now: float


def plan(inputs: Inputs, *, rejected: RelayConfig | None, last_live_at: float | None) -> Plan:
    """The tunnel that should exist now. The first matching row wins."""
    if inputs.listen_port is None:
        return Idle(IdleReason.NOT_LISTENING)
    if inputs.relay is None:
        return Idle(IdleReason.NOT_SET_UP)
    if inputs.relay == rejected:
        return Idle(IdleReason.REJECTED)
    if inputs.project is None:
        return Idle(IdleReason.NO_PROJECT)
    if inputs.cli_live:
        return Idle(IdleReason.ELSEWHERE)
    lingering = last_live_at is not None and inputs.now - last_live_at <= LINGER_SEC
    if not inputs.links and not lingering:
        return Idle(IdleReason.NO_LIVE_LINKS)
    return Serve(inputs.relay, inputs.project, inputs.links)


ClientFactory = Callable[[RelayConfig, Path, list[StatusListener]], TunnelClient]


def _tunnel_client(
    cfg: RelayConfig, project: Path, listeners: list[StatusListener]
) -> TunnelClient:
    return TunnelClient(cfg, project, listeners=listeners)


@dataclass(slots=True)
class _Serving:
    relay: RelayConfig
    client: TunnelClient
    task: asyncio.Task[None]
    lock: FileLock
    advertised: tuple[Path, frozenset[str]]


class TunnelSupervisor:
    """Owns at most one TunnelClient task for this GUI process.

    The single writer of the client task, the Studio lock and the Studio status file. Every tick
    converges to ``plan`` of a fresh snapshot, whatever the last tick left behind.
    """

    def __init__(
        self,
        *,
        listen_port: Callable[[], int | None],
        served_project: Callable[[], Path | None],
        client_factory: ClientFactory = _tunnel_client,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._listen_port = listen_port
        self._served_project = served_project
        self._client_factory = client_factory
        self._clock = clock
        self._plan: Plan = Idle(IdleReason.NOT_LISTENING)
        self._serving: _Serving | None = None
        self._rejected: RelayConfig | None = None
        self._last_live_at: float | None = None
        self._workspaces: dict[Path, Path] = {}
        self._loop_task: asyncio.Task[None] | None = None
        self._stop_task: asyncio.Task[None] | None = None
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False

    @property
    def plan(self) -> Plan:
        return self._plan

    @asynccontextmanager
    async def running(self) -> AsyncIterator[None]:
        """Run the converge loop for the life of the server, then stop the client and free the lock."""
        if not host_platform.current().can_host_tunnel:
            self._plan = Idle(IdleReason.NOT_CAPABLE)
            yield
            return
        if not self._stopping:
            self._event_loop = asyncio.get_running_loop()
            self._loop_task = asyncio.create_task(self._loop())
        try:
            yield
        finally:
            await self._shutdown()

    def request_stop(self) -> None:
        """Stop from any thread, so proxied guest streams close before uvicorn waits on them."""
        self._stopping = True
        loop = self._event_loop
        if loop is None:
            return
        with suppress(RuntimeError):
            loop.call_soon_threadsafe(self._begin_stop)

    def _begin_stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
        if self._stop_task is None:
            self._stop_task = asyncio.ensure_future(self._stop())

    async def _shutdown(self) -> None:
        self._stopping = True
        if self._loop_task is not None:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
        if self._stop_task is not None:
            await asyncio.gather(self._stop_task, return_exceptions=True)
        await self._stop()

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception as exc:
                log.warning("Studio tunnel supervisor tick failed: %s", type(exc).__name__)
            await asyncio.sleep(POLL_SEC)

    async def _tick(self) -> None:
        self._reap()
        inputs = await asyncio.to_thread(self._gather)
        if inputs.relay != self._rejected:
            self._rejected = None
        if inputs.links:
            self._last_live_at = inputs.now
        desired = plan(inputs, rejected=self._rejected, last_live_at=self._last_live_at)
        await self._converge(desired)

    def _gather(self) -> Inputs:
        port = self._listen_port()
        relay = (
            ready_relay_config(local_gui_url=f"http://127.0.0.1:{port}")
            if port is not None
            else None
        )
        project = self._served_project()
        links: frozenset[str] = frozenset()
        cli_live = False
        if relay is not None:
            cli_live = status_file_is_live(tunnel_status_path(relay))
            if project is not None:
                links = self._links(project)
        return Inputs(port, relay, project, links, cli_live, self._clock())

    def _links(self, project: Path) -> frozenset[str]:
        try:
            workspace = self._workspaces.get(project)
            if workspace is None:
                workspace = load_project(project).workspace_path()
                self._workspaces[project] = workspace
            return usable_share_tokens(workspace)
        except Exception as exc:
            log.warning("Studio tunnel supervisor cannot read shares: %s", type(exc).__name__)
            return frozenset()

    def _reap(self) -> None:
        """A client that ended on its own was refused for good: park until the config changes."""
        serving = self._serving
        if serving is None or not serving.task.done():
            return
        self._serving = None
        serving.lock.release()
        if not serving.task.cancelled() and serving.task.exception() is not None:
            self._rejected = serving.relay

    async def _converge(self, desired: Plan) -> None:
        serving = self._serving
        if isinstance(desired, Idle):
            if serving is not None:
                await self._stop()
            self._plan = desired
            return
        if serving is not None and serving.relay != desired.relay:
            await self._stop()
            serving = None
        if serving is None:
            self._plan = desired if self._start(desired) else Idle(IdleReason.ELSEWHERE)
            return
        if serving.advertised != (
            desired.project,
            desired.links,
        ) and await serving.client.readvertise(desired.project):
            serving.advertised = (desired.project, desired.links)
        self._plan = desired

    def _start(self, desired: Serve) -> bool:
        lock_path = studio_lock_path(desired.relay)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock = FileLock(lock_path, timeout=0, thread_local=False)
        try:
            lock.acquire()
        except Timeout:
            return False
        listeners: list[StatusListener] = [
            LineListener(log.info),
            StatusFileListener(studio_status_path(desired.relay)),
        ]
        client = self._client_factory(desired.relay, desired.project, listeners)
        self._serving = _Serving(
            relay=desired.relay,
            client=client,
            task=asyncio.create_task(client.run()),
            lock=lock,
            advertised=(desired.project, desired.links),
        )
        return True

    async def _stop(self) -> None:
        serving, self._serving = self._serving, None
        if serving is None:
            return
        try:
            serving.task.cancel()
            _, pending = await asyncio.wait({serving.task}, timeout=STOP_TIMEOUT_SEC)
            if pending:
                log.warning("Studio tunnel did not stop within %.0f s", STOP_TIMEOUT_SEC)
            elif not serving.task.cancelled():
                serving.task.exception()
        finally:
            serving.lock.release()
