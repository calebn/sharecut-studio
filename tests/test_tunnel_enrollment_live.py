"""A host with no host token signs in to a live enrolling relay, renews, and is revoked."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import time
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from tests.polling import until
from tests.record_links import make_project, mint_record_link
from tests.relay_enroll import enable_enrollment, enroll_body
from tests.relay_live import live_relay

from podcast_mcp.config import runtime as runtime_module
from podcast_mcp.config.runtime import RelayConfig, ready_relay_config
from podcast_mcp.services.collaboration import enrollment as enrollment_module
from podcast_mcp.services.collaboration.enrollment import Enrollment, LeaseStore, http_origin
from podcast_mcp.services.collaboration.share import online_sharing_warnings
from podcast_mcp.services.collaboration.tunnel import TunnelClient
from podcast_mcp.services.collaboration.tunnel_failure import (
    FailureKind,
    TunnelError,
    TunnelFailure,
)
from podcast_mcp.services.collaboration.tunnel_status import TunnelPhase
from podcast_mcp.util.relay_protocol.enroll import MAX_POW_BITS, EnrollProof
from podcast_mcp.util.relay_protocol.lease import peek_lease, public_key_bytes
from podcast_relay import policy as policy_module
from podcast_relay.app import create_relay_app
from podcast_relay.limits import reset_relay_limiters_for_tests

INSTALL = "install-1"
CLAIM_KEY = "".join(
    [
        "e31cf7a5abdab79a",
        "a785eb4db0f606f8",
        "f44bcfce8190056c",
        "738a57937ca421f9",
    ]
)
LEGACY_TOKEN = "legacy-host-token-" + "x" * 20


@dataclass
class Relay:
    app: object
    ws_base: str
    deny: Path

    @property
    def policy(self):
        return self.app.state.relay.policy

    def config(self, *, host_token: str = "") -> RelayConfig:
        return RelayConfig(
            relay_url=f"{self.ws_base}/tunnel",
            host_token=host_token,
            public_base_url=self.ws_base.replace("ws://", "http://"),
            host_id="local-host-id",
        )


@pytest.fixture
def relay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Relay]:
    deny = enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_TOKEN)
    monkeypatch.setattr(policy_module, "DENY_RELOAD_SEC", 0.05)
    app = create_relay_app()
    with live_relay(monkeypatch, host_token=LEGACY_TOKEN, app=app) as ws_base:
        yield Relay(app, ws_base, deny)


@pytest.fixture
def project(tmp_workspace: Path) -> Path:
    return make_project(tmp_workspace, "enrolled")


@pytest.fixture
def store(tmp_path: Path) -> LeaseStore:
    return LeaseStore(tmp_path / "lease.json")


def _client(relay: Relay, project: Path, store: LeaseStore, *, build: str = "0.1.5", **kw):
    cfg = relay.config(**kw)
    enrollment = None if cfg.host_token else Enrollment(cfg, store=store, build=build)
    return TunnelClient(cfg, project, enrollment=enrollment)


async def _serve(
    client: TunnelClient, relay: Relay, token: str, capture: list | None = None
) -> None:
    """Run *client* until the relay holds a live tunnel advertising *token*."""
    task = asyncio.create_task(client.run())
    try:
        await until(lambda: relay.app.state.relay.tunnel_for_token(token) is not None)
        if capture is not None:
            capture.append(relay.app.state.relay.tunnel_for_token(token))
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_first_use_enrolls_then_the_hello_registers_the_share(relay, project, store) -> None:
    token = mint_record_link(project)
    client = _client(relay, project, store)

    asyncio.run(_serve(client, relay, token))

    stored = json.loads(store._path.read_text())
    assert stored["install_id"] == INSTALL
    assert stored["claim_key"] == CLAIM_KEY
    assert peek_lease(stored["lease"]).kid == "k1"
    assert stat.S_IMODE(os.stat(store._path).st_mode) == 0o600


def test_renewal_keeps_the_claim_key_so_earlier_claims_stay_valid(relay, project, store) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    first = json.loads(store._path.read_text())
    half_life_later = float(first["renew_at"]) + 60
    relay.policy.clock = lambda: half_life_later
    renewing = Enrollment(relay.config(), store=store, build="0.1.5", clock=lambda: half_life_later)

    renewed = asyncio.run(renewing.credentials())

    assert renewed.lease != first["lease"]
    assert renewed.claim_key == first["claim_key"] == CLAIM_KEY
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    assert json.loads(store._path.read_text())["lease"] == renewed.lease


def test_a_denylisted_install_is_dropped_live_and_told_in_plain_words(
    relay, project, store
) -> None:
    token = mint_record_link(project)
    client = _client(relay, project, store)

    async def scenario() -> TunnelError:
        task = asyncio.create_task(client.run())
        await until(lambda: relay.app.state.relay.tunnel_for_token(token) is not None)
        relay.deny.write_text(f"{INSTALL}\n")
        async with asyncio.timeout(5):
            with pytest.raises(TunnelError) as caught:
                await task
        return caught.value

    failure = asyncio.run(scenario()).failure

    assert failure.kind is FailureKind.UNAVAILABLE
    assert failure.fatal
    assert failure.reason == "unavailable: online sharing is unavailable right now"
    assert failure.hint == "If you think this is a mistake, contact support."


def test_an_epoch_bump_signs_the_host_in_again_without_a_failure(relay, project, store) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    assert peek_lease(json.loads(store._path.read_text())["lease"]).epoch == 1
    relay.policy.epoch = 2
    reset_relay_limiters_for_tests()

    async def second() -> None:
        client = TunnelClient(
            relay.config(),
            project,
            enrollment=Enrollment(relay.config(), store=store, build="0.1.5"),
            sleep=_instant,
        )
        await _serve(client, relay, token)

    asyncio.run(second())

    assert peek_lease(json.loads(store._path.read_text())["lease"]).epoch == 2


async def _instant(_: float) -> None:
    return None


def test_a_kid_rotation_with_an_overlap_key_keeps_the_install_id(relay, project, store) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    first = json.loads(store._path.read_text())
    relay.policy.public_keys = {**relay.policy.public_keys, "k2": relay.policy.public_keys["k1"]}
    relay.policy.kid = "k2"
    later = float(first["renew_at"]) + 60
    relay.policy.clock = lambda: later

    renewed = asyncio.run(
        Enrollment(relay.config(), store=store, build="0.1.5", clock=lambda: later).credentials()
    )

    assert (renewed.install_id, peek_lease(renewed.lease).kid) == (first["install_id"], "k2")
    asyncio.run(_serve(_client(relay, project, store), relay, token))


def test_an_epoch_bump_keeps_the_install_id_so_its_shares_stay_bound(relay, project, store) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    before = json.loads(store._path.read_text())["install_id"]
    relay.policy.epoch = 3
    reset_relay_limiters_for_tests()

    asyncio.run(_serve(_client(relay, project, store), relay, token))

    assert json.loads(store._path.read_text())["install_id"] == before


def test_a_kid_rotation_without_an_overlap_key_signs_the_host_in_under_a_new_id(
    relay, project, store
) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    first = json.loads(store._path.read_text())
    relay.policy.public_keys = {"k2": relay.policy.public_keys["k1"]}
    relay.policy.kid = "k2"
    reset_relay_limiters_for_tests()

    enrollment = Enrollment(relay.config(), store=store, build="0.1.5")
    enrollment.mark_stale()

    renewed = asyncio.run(enrollment.credentials())

    assert renewed.install_id != first["install_id"]
    assert peek_lease(renewed.lease).kid == "k2"


def test_a_build_below_min_build_stops_with_an_update_message(relay, project, store) -> None:
    relay.policy.min_build = "0.2.0"
    client = _client(relay, project, store, build="0.1.5")

    with pytest.raises(TunnelError) as caught:
        asyncio.run(client.run(max_attempts=1))

    failure = caught.value.failure
    assert (failure.kind, failure.detail, failure.hint) == (
        FailureKind.AUTH,
        "this version of ShareCut is too old for online sharing",
        "Update ShareCut, then start online sharing again.",
    )


def test_a_computer_with_a_wrong_clock_enrolls_and_keeps_its_lease(relay, project, store) -> None:
    skewed = lambda: time.time() + 5 * 24 * 3600  # noqa: E731
    first = asyncio.run(
        Enrollment(relay.config(), store=store, build="0.1.5", clock=skewed).credentials()
    )

    again = asyncio.run(
        Enrollment(relay.config(), store=store, build="0.1.5", clock=skewed).credentials()
    )

    assert again.lease == first.lease
    assert abs(first.clock_offset + 5 * 24 * 3600) < 5


def test_a_lease_the_relay_replaced_the_key_of_is_signed_in_again(relay, project, store) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    first = json.loads(store._path.read_text())
    other = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))
    relay.policy.signer = other
    relay.policy.public_keys = {"k1": public_key_bytes(other)}
    reset_relay_limiters_for_tests()
    client = _client(relay, project, store)

    async def scenario() -> None:
        task = asyncio.create_task(client.run())
        await until(lambda: client.tracker.status.phase is TunnelPhase.CONNECTED)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())

    assert json.loads(store._path.read_text())["lease"] != first["lease"]


def test_a_host_never_solves_more_work_than_the_ceiling_whatever_the_relay_asks(
    relay, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: list[int] = []

    def refuse_to_solve(seed: str, bits: int, *, now: int):
        asked.append(bits)
        return EnrollProof(now, "0")

    monkeypatch.setattr(enrollment_module, "solve_pow", refuse_to_solve)
    relay.policy.pow_bits = 40

    with pytest.raises(TunnelError):
        asyncio.run(Enrollment(relay.config(), store=store, build="0.1.5").credentials())

    assert asked == [MAX_POW_BITS]


class _Stop(Exception):
    pass


def _waits(enrollment: Enrollment, count: int, **kw) -> list[float]:
    """The sleeps keep_fresh asks for over *count* passes."""
    waits: list[float] = []

    async def record(seconds: float) -> None:
        waits.append(seconds)
        if len(waits) == count:
            raise _Stop

    async def run() -> None:
        with pytest.raises(_Stop):
            await enrollment.keep_fresh(record, **kw)

    asyncio.run(run())
    return waits


def test_a_down_relay_is_retried_with_a_doubling_backoff_up_to_a_minute(store) -> None:
    down = RelayConfig(
        relay_url="ws://127.0.0.1:1/tunnel", public_base_url="http://127.0.0.1:1", host_id="h"
    )
    origin = http_origin(down.relay_url)
    now = time.time()
    store.save(
        origin=origin,
        credentials=enrollment_module.Credentials(
            "i1", "lease", "key", int(now + 1000), int(now - 5)
        ),
    )

    waits = _waits(Enrollment(down, store=store, build="0.1.5"), 9, jitter=lambda: 0.0)

    assert waits == [1, 2, 4, 8, 16, 32, 60, 60, 60]


def test_a_renewal_failure_waits_at_least_as_long_as_the_relay_asked(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = RelayConfig(relay_url="ws://x.test/tunnel", public_base_url="http://x.test", host_id="h")
    now = time.time()
    store.save(
        origin=http_origin(cfg.relay_url),
        credentials=enrollment_module.Credentials(
            "i1", "lease", "key", int(now + 1000), int(now - 5)
        ),
    )

    async def too_many(self, stored):
        raise TunnelError(TunnelFailure(FailureKind.RATE_LIMITED, "slow", retry_after_sec=90.0))

    monkeypatch.setattr(Enrollment, "_renew", too_many)

    waits = _waits(Enrollment(cfg, store=store, build="0.1.5"), 3, jitter=lambda: 1.0)

    assert waits == [112.5, 112.5, 112.5]


def test_an_updated_build_renews_its_lease_past_a_raised_min_build(relay, project, store) -> None:
    mint_record_link(project)
    old = asyncio.run(Enrollment(relay.config(), store=store, build="0.1.5").credentials())
    relay.policy.min_build = "0.2.0"

    updated = asyncio.run(Enrollment(relay.config(), store=store, build="0.2.1").credentials())

    assert updated.lease != old.lease
    assert peek_lease(updated.lease).build == "0.2.1"


def test_the_sixth_enrollment_from_one_subnet_waits_and_retries(relay, project, store) -> None:
    for _ in range(5):
        res = httpx.post(
            f"{relay.ws_base.replace('ws://', 'http://')}/api/relay/enroll", json=enroll_body()
        )
        assert res.status_code == 200
    client = _client(relay, project, store)

    with pytest.raises(TunnelError) as caught:
        asyncio.run(client.run(max_attempts=1))

    failure = caught.value.failure
    assert failure.kind is FailureKind.RATE_LIMITED
    assert failure.detail == "too many sign-ups from this network, trying again later"
    assert failure.retry_after_sec > 0
    assert not failure.fatal


def test_an_explicit_host_token_is_used_unchanged_and_never_enrolls(relay, project, store) -> None:
    token = mint_record_link(project)
    client = _client(relay, project, store, host_token=LEGACY_TOKEN)

    seen: list = []
    asyncio.run(_serve(client, relay, token, seen))

    assert not store._path.exists()
    session = seen[0]
    assert (session.host_token, session.install_id) == (LEGACY_TOKEN, "")


def test_a_relay_that_does_not_enroll_stops_with_a_plain_message(
    monkeypatch: pytest.MonkeyPatch, project, store, tmp_path
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_TOKEN)
    with live_relay(monkeypatch, host_token=LEGACY_TOKEN, app=create_relay_app()) as ws_base:
        cfg = RelayConfig(
            relay_url=f"{ws_base}/tunnel",
            public_base_url=ws_base.replace("ws://", "http://"),
            host_id="local-host-id",
        )
        client = TunnelClient(cfg, project, enrollment=Enrollment(cfg, store=store))

        with pytest.raises(TunnelError) as caught:
            asyncio.run(client.run())

    failure = caught.value.failure
    assert (failure.kind, failure.detail) == (
        FailureKind.CONFIG,
        "online sharing is not available at this address",
    )
    assert failure.fatal
    assert failure.reason_code is None


def test_a_named_relay_that_does_not_enroll_reads_not_set_up_again_after_one_try(
    monkeypatch: pytest.MonkeyPatch, project, store
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_TOKEN)
    with live_relay(monkeypatch, host_token=LEGACY_TOKEN, app=create_relay_app()) as ws_base:
        monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN", raising=False)
        monkeypatch.setenv("PODCAST_RELAY_URL", f"{ws_base}/tunnel")
        monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", ws_base.replace("ws://", "http://"))
        cfg = ready_relay_config()
        assert cfg is not None
        with pytest.raises(TunnelError):
            asyncio.run(TunnelClient(cfg, project, enrollment=Enrollment(cfg, store=store)).run())

        assert ready_relay_config() is None
        assert online_sharing_warnings()[0]["code"] == "online_sharing_not_set_up"


@pytest.mark.parametrize(
    ("status", "body"),
    [(404, {}), (403, {}), (426, {}), (429, {"retry_after_sec": 3}), (500, {}), (400, {})],
)
def test_no_enrollment_failure_says_tunnel_relay_lease_or_token(status: int, body: dict) -> None:
    from podcast_mcp.services.collaboration.enrollment import _refusal

    failure = _refusal(status, body, None).failure

    words = (failure.detail + " " + failure.fix).lower()
    assert not any(banned in words for banned in ("tunnel", "relay", "lease", "token"))


@pytest.mark.parametrize("fatal", [False, True])
def test_the_older_service_failure_says_tunnel_relay_lease_or_token_nowhere(fatal: bool) -> None:
    from podcast_mcp.services.collaboration.enrollment import _older_service

    failure = _older_service(fatal=fatal).failure

    words = (failure.detail + " " + failure.fix).lower()
    assert not any(banned in words for banned in ("tunnel", "relay", "lease", "token"))
    assert (failure.fatal, failure.reason_code) == (fatal, "relay_older")


def test_the_store_ignores_a_lease_for_another_relay(store) -> None:
    from podcast_mcp.services.collaboration.enrollment import Credentials

    store.save(
        origin="https://a.example",
        credentials=Credentials("i1", "lease-value", "key-value", 20, 10),
    )

    assert store.load(origin="https://a.example") == Credentials(
        "i1", "lease-value", "key-value", 20, 10
    )
    assert store.load(origin="https://b.example") is None


@pytest.mark.parametrize(
    ("relay_url", "origin"),
    [
        ("wss://share.example.com/tunnel", "https://share.example.com"),
        ("ws://127.0.0.1:8080/tunnel", "http://127.0.0.1:8080"),
    ],
)
def test_http_origin(relay_url: str, origin: str) -> None:
    assert http_origin(relay_url) == origin


def _past_renew(relay: Relay, store: LeaseStore, *, exp_in: float = 3600.0) -> None:
    origin = http_origin(relay.config().relay_url)
    stored = store.load(origin=origin)
    assert stored is not None
    now = int(time.time())
    store.save(origin=origin, credentials=replace(stored, renew_at=now - 5, exp=now + int(exp_in)))


def _renew_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enrollment_module, "RENEW_PATH", "/api/relay/renew-moved")


def test_a_renew_404_keeps_the_stored_lease_and_the_tunnel_connecting(
    relay, project, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    _past_renew(relay, store)
    before = json.loads(store._path.read_text())
    _renew_is_gone(monkeypatch)

    asyncio.run(_serve(_client(relay, project, store), relay, token))

    assert json.loads(store._path.read_text())["lease"] == before["lease"]
    assert relay.config().relay_url not in runtime_module._NON_ENROLLING_RELAYS


def test_three_renew_404s_in_a_row_stop_with_the_older_service_message(
    relay, project, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    asyncio.run(_serve(_client(relay, project, store), relay, mint_record_link(project)))
    _past_renew(relay, store)
    _renew_is_gone(monkeypatch)
    skew = [0.0]
    enrollment = Enrollment(
        relay.config(),
        store=store,
        build="0.1.5",
        clock=lambda: time.time() + skew[0],
        monotonic=lambda: time.monotonic() + skew[0],
    )

    async def attempts() -> list[object]:
        results: list[object] = []
        for _ in range(3):
            skew[0] += enrollment_module.NOT_FOUND_MIN_SPAN_SEC / 2
            try:
                results.append(await enrollment.credentials())
            except TunnelError as exc:
                results.append(exc)
        return results

    first, second, third = asyncio.run(attempts())

    assert isinstance(first, enrollment_module.Credentials)
    assert isinstance(second, enrollment_module.Credentials)
    assert isinstance(third, TunnelError)
    failure = third.failure
    assert (failure.kind, failure.fatal, failure.reason_code) == (
        FailureKind.CONFIG,
        True,
        "relay_older",
    )
    assert "older than this version of ShareCut" in failure.detail
    assert relay.config().relay_url not in runtime_module._NON_ENROLLING_RELAYS


def test_a_renew_that_succeeds_resets_the_count_of_404s(
    relay, project, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    asyncio.run(_serve(_client(relay, project, store), relay, mint_record_link(project)))
    enrollment = Enrollment(relay.config(), store=store, build="0.1.5")

    async def credentials_after_404s(count: int) -> None:
        _past_renew(relay, store)
        monkeypatch.setattr(enrollment_module, "RENEW_PATH", "/api/relay/renew-moved")
        for _ in range(count):
            await enrollment.credentials()

    async def renew_for_real() -> None:
        _past_renew(relay, store)
        monkeypatch.undo()
        await enrollment.credentials()

    async def scenario() -> None:
        await credentials_after_404s(2)
        assert enrollment._not_found == 2
        await renew_for_real()
        assert enrollment._not_found == 0
        await credentials_after_404s(2)
        assert enrollment._not_found == 2

    asyncio.run(scenario())


def test_an_expired_lease_with_no_enrollment_endpoint_stops_with_the_older_service_message(
    relay, project, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    asyncio.run(_serve(_client(relay, project, store), relay, mint_record_link(project)))
    _past_renew(relay, store, exp_in=-10)
    monkeypatch.setattr(enrollment_module, "ENROLL_PATH", "/api/relay/enroll-moved")

    with pytest.raises(TunnelError) as caught:
        asyncio.run(Enrollment(relay.config(), store=store, build="0.1.5").credentials())

    failure = caught.value.failure
    assert (failure.kind, failure.fatal, failure.reason_code) == (
        FailureKind.CONFIG,
        True,
        "relay_older",
    )
    assert "older than this version of ShareCut" in failure.detail
    assert relay.config().relay_url not in runtime_module._NON_ENROLLING_RELAYS


def test_a_renew_404_does_not_stop_a_connected_tunnel_or_unready_the_host(
    relay, project, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = mint_record_link(project)
    asyncio.run(_serve(_client(relay, project, store), relay, token))
    _past_renew(relay, store)
    _renew_is_gone(monkeypatch)
    renews = 0
    real_renew = Enrollment._renew

    async def counted(self, stored):
        nonlocal renews
        renews += 1
        return await real_renew(self, stored)

    monkeypatch.setattr(Enrollment, "_renew", counted)
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_URL", relay.config().relay_url)
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", relay.config().public_base_url)

    async def run() -> None:
        task = asyncio.create_task(_client(relay, project, store).run())
        try:
            await until(lambda: relay.app.state.relay.tunnel_for_token(token) is not None)
            await until(lambda: renews >= 4, timeout=15.0)
            assert relay.app.state.relay.tunnel_for_token(token) is not None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())

    assert ready_relay_config() is not None


class _ScriptedRenew:
    """An Enrollment whose renew replies come from a script and whose clock the test moves."""

    def __init__(self, store: LeaseStore, monkeypatch: pytest.MonkeyPatch, replies: list) -> None:
        self.now = time.time()
        self.mono = 1000.0
        cfg = RelayConfig(
            relay_url="wss://r.example.test/tunnel", public_base_url="https://r.example.test"
        )
        store.save(
            origin=http_origin(cfg.relay_url),
            credentials=enrollment_module.Credentials(
                "i1", "lease", "key", int(self.now) + 10**6, int(self.now) - 5
            ),
        )
        self.enrollment = Enrollment(
            cfg,
            store=store,
            build="0.1.5",
            clock=lambda: self.now,
            monotonic=lambda: self.mono,
        )
        queue = iter(replies)

        async def post(client, url, **kwargs):
            reply = next(queue)
            if isinstance(reply, Exception):
                raise reply
            return httpx.Response(reply, json={})

        monkeypatch.setattr(httpx.AsyncClient, "post", post)

    def run(self, steps: int, *, every: float, strict: bool = False) -> list[str]:
        async def go() -> list[str]:
            seen = []
            for _ in range(steps):
                try:
                    await self.enrollment.credentials(strict=strict)
                    seen.append("ok")
                except TunnelError as exc:
                    seen.append("fatal" if exc.failure.fatal else "retry")
                except OSError:
                    seen.append("error")
                self.now += every
                self.mono += every
            return seen

        return asyncio.run(go())


def test_interleaved_404s_and_other_failures_never_go_fatal(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    replies = [404, 503, 404, httpx.ConnectError("down"), 404, 401, 404, 503, 404]
    scripted = _ScriptedRenew(store, monkeypatch, replies)

    seen = scripted.run(len(replies), every=400.0)

    assert "fatal" not in seen
    assert scripted.enrollment._not_found == 1


def test_three_404s_inside_the_minimum_span_stay_non_fatal(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 5)

    assert scripted.run(5, every=10.0) == ["ok"] * 5
    assert scripted.enrollment._not_found == 5


def test_three_404s_spanning_the_minimum_are_fatal(store, monkeypatch: pytest.MonkeyPatch) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 3)

    seen = scripted.run(3, every=enrollment_module.NOT_FOUND_MIN_SPAN_SEC / 2)

    assert seen == ["ok", "ok", "fatal"]


def test_two_keep_fresh_404s_then_a_reconnect_still_gets_the_stored_lease(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 3)

    assert len(_waits(scripted.enrollment, 2, jitter=lambda: 0.0)) == 2

    credentials = asyncio.run(scripted.enrollment.credentials())
    assert credentials.lease == "lease"


def test_one_or_two_404s_spanning_the_minimum_stay_non_fatal(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 3)

    seen = scripted.run(3, every=400.0)

    assert seen == ["ok", "ok", "fatal"]


def test_a_failure_that_is_not_a_404_clears_when_the_streak_began(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404, 503, 404, 404, 404])
    scripted.run(2, every=1000.0)
    assert scripted.enrollment._first_not_found is None

    assert scripted.run(3, every=10.0) == ["ok"] * 3


def test_an_error_that_is_not_a_tunnel_failure_ends_the_streak_too(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404, OSError("disk"), 404])

    assert scripted.run(3, every=1.0) == ["ok", "error", "ok"]
    assert scripted.enrollment._not_found == 1


def test_a_wall_clock_jump_does_not_make_quick_404s_fatal(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 3)
    seen = scripted.run(1, every=1.0)
    scripted.now += 8 * 3600

    seen += scripted.run(2, every=1.0)

    assert seen == ["ok"] * 3


def test_a_wall_clock_step_back_does_not_delay_escalation(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404] * 3)
    seen = scripted.run(1, every=200.0)
    scripted.now -= 3600

    seen += scripted.run(2, every=200.0)

    assert seen == ["ok", "ok", "fatal"]


def test_a_fresh_stored_lease_ends_the_404_streak(store, monkeypatch: pytest.MonkeyPatch) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404])
    scripted.run(1, every=1.0)
    assert scripted.enrollment._not_found == 1
    origin = http_origin("wss://r.example.test/tunnel")
    stored = store.load(origin=origin)
    store.save(origin=origin, credentials=replace(stored, renew_at=int(scripted.now) + 1000))
    monkeypatch.setattr(Enrollment, "_build_matches", lambda self, stored: True)

    asyncio.run(scripted.enrollment.credentials())

    assert (scripted.enrollment._not_found, scripted.enrollment._first_not_found) == (0, None)


@pytest.mark.parametrize("with_previous", [False, True])
def test_a_404_on_the_sign_up_post_keeps_the_address_message(
    store, monkeypatch: pytest.MonkeyPatch, with_previous: bool
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [])
    if not with_previous:
        store.clear()
    else:
        origin = http_origin("wss://r.example.test/tunnel")
        stored = store.load(origin=origin)
        store.save(origin=origin, credentials=replace(stored, exp=int(scripted.now) - 10))

    async def probe(client, url, **kwargs):
        return httpx.Response(200, json={"enroll": True, "pow_bits": 0, "now": int(scripted.now)})

    async def refuse(client, url, **kwargs):
        return httpx.Response(404, json={})

    monkeypatch.setattr(httpx.AsyncClient, "get", probe)
    monkeypatch.setattr(httpx.AsyncClient, "post", refuse)

    with pytest.raises(TunnelError) as caught:
        asyncio.run(scripted.enrollment.credentials())

    failure = caught.value.failure
    assert (failure.kind, failure.detail, failure.reason_code) == (
        FailureKind.CONFIG,
        "online sharing is not available at this address",
        None,
    )


def test_a_renew_404_for_a_lease_the_service_refused_is_fatal_at_once(
    store, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripted = _ScriptedRenew(store, monkeypatch, [404])
    scripted.enrollment.mark_stale()

    assert scripted.run(1, every=0.0) == ["fatal"]


def test_a_named_relay_without_a_token_is_ready_for_enrollment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN", raising=False)
    monkeypatch.delenv("PODCAST_RELAY_URL", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", "https://share.example.com")
    assert ready_relay_config() is None

    monkeypatch.setenv("PODCAST_RELAY_URL", "wss://share.example.com/tunnel")
    cfg = ready_relay_config()

    assert cfg is not None
    assert (cfg.relay_url, cfg.host_token) == ("wss://share.example.com/tunnel", "")


@pytest.fixture
def capped_relay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Relay]:
    deny = enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_INSTALL_MAX_SHARES="1")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_TOKEN)
    app = create_relay_app()
    with live_relay(monkeypatch, host_token=LEGACY_TOKEN, app=app) as ws_base:
        yield Relay(app, ws_base, deny)


def test_a_host_over_the_share_cap_stays_connected_and_reads_limited(
    capped_relay, project, store
) -> None:
    mint_record_link(project)
    mint_record_link(project)
    client = _client(capped_relay, project, store)

    async def scenario() -> dict:
        task = asyncio.create_task(client.run())
        try:
            await until(lambda: client._tracker.status.limit == "shares")
            held = capped_relay.app.state.relay.tunnels[INSTALL].share_tokens
            assert len(held) == 1
            return client._tracker.status.to_record()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    record = asyncio.run(scenario())

    assert (record["state"], record["limit"], record["share_count"]) == ("limited", "shares", 1)
    assert record["reason"] is None


def test_the_host_reads_limited_when_the_month_runs_out_and_clears_with_it(
    relay, project, store
) -> None:
    token = mint_record_link(project)
    client = _client(relay, project, store)

    async def scenario() -> list[str | None]:
        task = asyncio.create_task(client.run())
        seen: list[str | None] = []
        try:
            await until(lambda: relay.app.state.relay.tunnel_for_token(token) is not None)
            await until(lambda: client._tracker.status.state.value == "online")
            state = relay.app.state.relay
            session = state.tunnels[INSTALL]
            state.meter.ledger.add(f"install:{INSTALL}", 10**12)
            await state.notify_limit(session)
            await until(lambda: client._tracker.status.limit == "bandwidth")
            seen.append(client._tracker.status.limit)
            state.meter.ledger.clock = lambda: 4_000_000_000.0
            await state.notify_limit(session)
            await until(lambda: client._tracker.status.limit is None)
            seen.append(client._tracker.status.limit)
            return seen
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert asyncio.run(scenario()) == ["bandwidth", None]


def test_a_host_token_is_refused_once_the_legacy_tier_ends(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, project, store
) -> None:
    deny = enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_TIER="0")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_TOKEN)
    app = create_relay_app()
    with live_relay(monkeypatch, host_token=LEGACY_TOKEN, app=app) as ws_base:
        old = Relay(app, ws_base, deny)
        mint_record_link(project)
        client = _client(old, project, store, host_token=LEGACY_TOKEN)

        async def scenario() -> TunnelError:
            with pytest.raises(TunnelError) as caught:
                async with asyncio.timeout(5):
                    await client.run()
            return caught.value

        failure = asyncio.run(scenario()).failure

    assert failure.fatal
    assert failure.reason == "auth: online sharing no longer accepts this access key"
    assert "start online sharing again" in failure.hint
