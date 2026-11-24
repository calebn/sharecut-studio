"""The Studio tunnel supervisor: the pure plan, and the actor that converges to it."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from filelock import FileLock
from tests.polling import until, yield_to_loop
from tests.record_links import make_project, mint_record_link

from podcast_mcp.config.runtime import RelayConfig
from podcast_mcp.models import load_project
from podcast_mcp.services.collaboration import tunnel_supervisor as sup
from podcast_mcp.services.collaboration.review_shares import revoke_share
from podcast_mcp.services.collaboration.tunnel_failure import (
    FailureKind,
    TunnelError,
    TunnelFailure,
)
from podcast_mcp.services.collaboration.tunnel_status import studio_lock_path
from podcast_mcp.services.collaboration.tunnel_supervisor import (
    Idle,
    IdleReason,
    Inputs,
    Serve,
    TunnelSupervisor,
)
from podcast_mcp.util import host_platform

RELAY = RelayConfig(
    relay_url="wss://relay.example.test/tunnel",
    host_token="tok",
    public_base_url="https://relay.example.test",
    local_gui_url="http://127.0.0.1:43123",
    host_id="host-a",
)
PROJECT = Path("/p/episode.json")
LIVE = frozenset({"tok-a"})


def _inputs(**overrides: Any) -> Inputs:
    base: dict[str, Any] = {
        "listen_port": 43123,
        "relay": RELAY,
        "project": PROJECT,
        "links": LIVE,
        "cli_live": False,
        "now": 1000.0,
    }
    base.update(overrides)
    return Inputs(**base)


@pytest.mark.parametrize(
    ("inputs", "rejected", "last_live_at", "expected"),
    [
        pytest.param(
            _inputs(listen_port=None),
            None,
            None,
            Idle(IdleReason.NOT_LISTENING),
            id="not_listening",
        ),
        pytest.param(_inputs(relay=None), None, None, Idle(IdleReason.NOT_SET_UP), id="not_set_up"),
        pytest.param(_inputs(), RELAY, None, Idle(IdleReason.REJECTED), id="rejected"),
        pytest.param(
            _inputs(project=None), None, None, Idle(IdleReason.NO_PROJECT), id="no_project"
        ),
        pytest.param(
            _inputs(cli_live=True), None, None, Idle(IdleReason.ELSEWHERE), id="elsewhere"
        ),
        pytest.param(
            _inputs(links=frozenset(), now=1000.0 + sup.LINGER_SEC),
            None,
            1000.0,
            Serve(relay=RELAY, project=PROJECT, links=frozenset()),
            id="lingering",
        ),
        pytest.param(
            _inputs(links=frozenset(), now=1000.0 + sup.LINGER_SEC + 1),
            None,
            1000.0,
            Idle(IdleReason.NO_LIVE_LINKS),
            id="linger_expired",
        ),
        pytest.param(
            _inputs(links=frozenset()), None, None, Idle(IdleReason.NO_LIVE_LINKS), id="never_live"
        ),
        pytest.param(
            _inputs(),
            None,
            None,
            Serve(relay=RELAY, project=PROJECT, links=frozenset({"tok-a"})),
            id="serve",
        ),
    ],
)
def test_plan_gate_table(
    inputs: Inputs, rejected: RelayConfig | None, last_live_at: float | None, expected: Any
) -> None:
    assert sup.plan(inputs, rejected=rejected, last_live_at=last_live_at) == expected


class FakeClient:
    """Stands in for TunnelClient: ``run`` parks (or fails), ``readvertise`` records its calls."""

    def __init__(self, cfg: RelayConfig, project: Path, fail: bool, answers: list[bool]) -> None:
        self.cfg = cfg
        self.runs = 0
        self.readvertised: list[Path] = []
        self._fail = fail
        self._answers = answers

    async def run(self) -> None:
        self.runs += 1
        if self._fail:
            raise TunnelError(TunnelFailure(FailureKind.AUTH, "rejected"))
        await asyncio.Event().wait()

    async def readvertise(self, project: Path) -> bool:
        self.readvertised.append(project)
        return self._answers.pop(0) if self._answers else True


class Rig:
    def __init__(self, project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.project = project
        self.clients: list[FakeClient] = []
        self.fail = False
        self.answers: list[bool] = []
        monkeypatch.setenv("PODCAST_RELAY_URL", "wss://relay.example.test/tunnel")
        monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", "https://relay.example.test")
        monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "tok")
        monkeypatch.setenv("PODCAST_RELAY_HOST_ID", "host-a")

    def supervisor(
        self, *, port: int | None = 43123, clock: Callable[[], float] = time.time
    ) -> TunnelSupervisor:
        def factory(cfg: RelayConfig, project: Path, _listeners: list[Any]) -> FakeClient:
            client = FakeClient(cfg, project, self.fail, self.answers)
            self.clients.append(client)
            return client

        return TunnelSupervisor(
            listen_port=lambda: port,
            served_project=lambda: self.project,
            client_factory=factory,
            clock=clock,
        )


@pytest.fixture
def rig(tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    return Rig(make_project(tmp_workspace), monkeypatch)


@asynccontextmanager
async def _stopped_after(supervisor: TunnelSupervisor) -> AsyncIterator[None]:
    try:
        yield
    finally:
        await supervisor._shutdown()


@pytest.mark.asyncio
async def test_starts_once_then_readvertises_on_link_change(rig: Rig) -> None:
    mint_record_link(rig.project)
    supervisor = rig.supervisor()

    async with _stopped_after(supervisor):
        await supervisor._tick()
        await yield_to_loop()
        mint_record_link(rig.project)
        await supervisor._tick()
        mint_record_link(rig.project)
        await supervisor._tick()
        await supervisor._tick()

    assert [c.runs for c in rig.clients] == [1]
    assert rig.clients[0].readvertised == [rig.project, rig.project]


@pytest.mark.asyncio
async def test_readvertise_false_is_retried_next_tick(rig: Rig) -> None:
    mint_record_link(rig.project)
    rig.answers = [False, True]
    supervisor = rig.supervisor()

    async with _stopped_after(supervisor):
        await supervisor._tick()
        mint_record_link(rig.project)
        await supervisor._tick()
        await supervisor._tick()
        await supervisor._tick()

    assert rig.clients[0].readvertised == [rig.project, rig.project]


@pytest.mark.asyncio
async def test_fatal_rejection_parks_until_config_changes(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    mint_record_link(rig.project)
    rig.fail = True
    supervisor = rig.supervisor()

    async with _stopped_after(supervisor):
        for _ in range(10):
            await supervisor._tick()
            await yield_to_loop()
        assert len(rig.clients) == 1
        assert supervisor.plan == Idle(IdleReason.REJECTED)

        monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", "new-tok")
        await supervisor._tick()

    assert len(rig.clients) == 2


@pytest.mark.asyncio
async def test_a_link_that_ends_lingers_then_stops_the_client(rig: Rig) -> None:
    token = mint_record_link(rig.project)
    now = [1000.0]
    supervisor = rig.supervisor(clock=lambda: now[0])

    async with _stopped_after(supervisor):
        await supervisor._tick()
        assert revoke_share(load_project(rig.project), token)
        now[0] += sup.LINGER_SEC
        await supervisor._tick()
        lingering = supervisor.plan
        assert isinstance(lingering, Serve)
        assert lingering.links == frozenset()
        assert rig.clients[0].readvertised == [rig.project]
        now[0] += 1
        await supervisor._tick()

    assert supervisor.plan == Idle(IdleReason.NO_LIVE_LINKS)


@pytest.mark.asyncio
async def test_second_supervisor_yields_while_lock_held(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sup, "POLL_SEC", 0.01)
    mint_record_link(rig.project)
    first, second = rig.supervisor(), rig.supervisor()

    async with AsyncExitStack() as stack:
        await stack.enter_async_context(first.running())
        await until(lambda: len(rig.clients) == 1)
        async with second.running():
            await until(lambda: second.plan == Idle(IdleReason.ELSEWHERE))
            assert len(rig.clients) == 1
            await first._shutdown()
            await until(lambda: isinstance(second.plan, Serve))

    assert len(rig.clients) == 2


@pytest.mark.asyncio
async def test_not_capable_host_starts_nothing(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sup, "POLL_SEC", 0.01)
    mint_record_link(rig.project)
    supervisor = rig.supervisor()

    with host_platform.using(host_platform.IOS):
        async with supervisor.running():
            await yield_to_loop(10)
            assert supervisor.plan == Idle(IdleReason.NOT_CAPABLE)
    assert rig.clients == []

    async with rig.supervisor().running():
        await until(lambda: len(rig.clients) == 1)


@pytest.mark.asyncio
async def test_request_stop_from_another_thread_stops_client(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sup, "POLL_SEC", 0.01)
    mint_record_link(rig.project)
    supervisor = rig.supervisor()

    async with supervisor.running():
        await until(lambda: len(rig.clients) == 1 and rig.clients[0].runs == 1)
        serving = supervisor._serving
        assert serving is not None
        threading.Thread(target=supervisor.request_stop).start()
        await until(lambda: serving.task.done())
        assert serving.task.cancelled()
        await until(lambda: _lock_is_free(serving.relay))
        await yield_to_loop(10)
        assert len(rig.clients) == 1


def _lock_is_free(cfg: RelayConfig) -> bool:
    lock = FileLock(studio_lock_path(cfg), timeout=0, thread_local=False)
    try:
        lock.acquire()
    except Exception:
        return False
    lock.release()
    return True
