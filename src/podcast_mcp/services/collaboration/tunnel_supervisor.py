"""TunnelSupervisor brings the host tunnel up inside the Studio process on its own.

``plan`` is the whole policy: given one snapshot of the world it names the single tunnel that
should exist. The supervisor only converges to it, so a missed tick costs latency, never a wrong
end state.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from filelock import Timeout

from podcast_mcp.config.runtime import RelayConfig, ready_relay_config
from podcast_mcp.models import EpisodeProject, load_project
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
from podcast_mcp.util.file_locks import exclusive_file_lock

log = logging.getLogger(__name__)

POLL_SEC = 2.0
LINGER_SEC = 120.0
STOP_TIMEOUT_SEC = 5.0


class IdleReason(StrEnum):
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
    listen_port: int | None
    listen_host: str | None
    relay: RelayConfig | None
    project: Path | None
    links: frozenset[str]
    cli_live: bool
    now: float


def _loopback_url(host: str, port: int) -> str | None:
    """The tunnel proxies over plain HTTP, so it may only reach a GUI that is bound to loopback."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    if not address.is_loopback:
        return None
    return f"http://[{address}]:{port}" if address.version == 6 else f"http://{address}:{port}"


def plan(inputs: Inputs, *, rejected: RelayConfig | None, last_live_at: float | None) -> Plan:
    if inputs.listen_port is None or inputs.listen_host is None:
        return Idle(IdleReason.NOT_LISTENING)
    if _loopback_url(inputs.listen_host, inputs.listen_port) is None:
        return Idle(IdleReason.NOT_CAPABLE)
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
        listen_host: Callable[[], str | None],
        served_project: Callable[[], Path | None],
        client_factory: ClientFactory = _tunnel_client,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._listen_port = listen_port
        self._listen_host = listen_host
        self._served_project = served_project
        self._client_factory = client_factory
        self._clock = clock
        self._plan: Plan = Idle(IdleReason.NOT_LISTENING)
        self._serving: _Serving | None = None
        self._rejected: RelayConfig | None = None
        self._last_live_at: float | None = None
        self._episodes: dict[Path, EpisodeProject] = {}
        self._loop_task: asyncio.Task[None] | None = None
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._stop_requested = asyncio.Event()

    @property
    def plan(self) -> Plan:
        return self._plan

    @asynccontextmanager
    async def running(self) -> AsyncIterator[None]:
        if not host_platform.current().can_host_tunnel:
            self._plan = Idle(IdleReason.NOT_CAPABLE)
            yield
            return
        self._event_loop = asyncio.get_running_loop()
        if not self._stop_requested.is_set():
            self._loop_task = asyncio.create_task(self._loop())
        try:
            yield
        finally:
            self._stop_requested.set()
            if self._loop_task is not None:
                await asyncio.gather(self._loop_task, return_exceptions=True)

    def request_stop(self) -> None:
        """Stop from any thread, so proxied guest streams close before uvicorn waits on them."""
        loop = self._event_loop
        if loop is None:
            self._stop_requested.set()
            return
        with suppress(RuntimeError):
            loop.call_soon_threadsafe(self._stop_requested.set)

    async def _loop(self) -> None:
        """Owns the teardown: the client has ended, and its lock is going, when this returns."""
        try:
            while not self._stop_requested.is_set():
                try:
                    await self._tick()
                except Exception as exc:
                    log.warning("Studio tunnel supervisor tick failed: %s", type(exc).__name__)
                with suppress(TimeoutError):
                    await asyncio.wait_for(self._stop_requested.wait(), POLL_SEC)
        finally:
            await self._stop()

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
        host = self._listen_host()
        url = _loopback_url(host, port) if host is not None and port is not None else None
        relay = ready_relay_config(local_gui_url=url) if url is not None else None
        project = self._served_project()
        links: frozenset[str] = frozenset()
        cli_live = False
        if relay is not None:
            cli_live = status_file_is_live(tunnel_status_path(relay))
            if project is not None:
                links = self._links(project)
        return Inputs(port, host, relay, project, links, cli_live, self._clock())

    def _links(self, project: Path) -> frozenset[str]:
        episode = self._episodes.get(project)
        if episode is None:
            episode = load_project(project)
            self._episodes[project] = episode
        return usable_share_tokens(episode)

    def _reap(self) -> None:
        """A client that ended on its own was refused for good: park until the config changes."""
        serving = self._serving
        if serving is None or not serving.task.done():
            return
        self._serving = None
        if serving.task.cancelled():
            return
        error = serving.task.exception()
        if error is not None:
            self._rejected = serving.relay
            log.warning(
                "Studio tunnel ended and is parked until the relay config changes: %s",
                type(error).__name__,
            )

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
        lock = exclusive_file_lock(lock_path)
        try:
            lock.acquire()
        except Timeout:
            return False
        listeners: list[StatusListener] = [
            LineListener(log.info),
            StatusFileListener(studio_status_path(desired.relay)),
        ]
        client = self._client_factory(desired.relay, desired.project, listeners)
        task = asyncio.create_task(client.run())
        task.add_done_callback(lambda _: lock.release())
        self._serving = _Serving(
            relay=desired.relay,
            client=client,
            task=task,
            advertised=(desired.project, desired.links),
        )
        return True

    async def _stop(self) -> None:
        """Cancel the client and wait for it. The Studio lock goes with the task, not with this
        wait, so a client that outlasts the timeout still keeps a second one from starting."""
        serving, self._serving = self._serving, None
        if serving is None:
            return
        serving.task.cancel()
        _, pending = await asyncio.wait({serving.task}, timeout=STOP_TIMEOUT_SEC)
        if pending:
            log.warning("Studio tunnel did not stop within %.0f s", STOP_TIMEOUT_SEC)
        elif not serving.task.cancelled():
            serving.task.exception()
