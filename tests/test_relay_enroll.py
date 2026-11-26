"""Relay enrollment, lease hello, renewal, revocation and the unchanged token-only relay."""

from __future__ import annotations

import asyncio
import itertools
import json
import re
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from tests.polling import until
from tests.relay_enroll import (
    enable_enrollment,
    enroll_body,
    foreign_proof_body,
    write_signing_key,
)
from tests.relay_live import live_relay

from podcast_mcp.util.relay_protocol.enroll import EnrollProof, pow_is_valid
from podcast_mcp.util.relay_protocol.lease import (
    LEASE_LIFETIME_SEC,
    peek_lease,
    public_key_bytes,
)
from podcast_mcp.util.relay_protocol.share_claims import attach_share_claims
from podcast_relay import policy as policy_module
from podcast_relay.app import create_relay_app
from podcast_relay.app import main as relay_main
from podcast_relay.limits import client_subnet
from podcast_relay.policy import RelayConfigError
from podcast_relay.state import TunnelRefused, TunnelSession

REAL_NEW_INSTALL_ID = policy_module.new_install_id

INSTALL = "install-1"
CLAIM_KEY_FOR_INSTALL = "".join(
    [
        "e31cf7a5abdab79a",
        "a785eb4db0f606f8",
        "f44bcfce8190056c",
        "738a57937ca421f9",
    ]
)


@pytest.fixture
def deny_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    return enable_enrollment(monkeypatch, tmp_path)


@pytest.fixture
def client(deny_file: Path) -> TestClient:
    return TestClient(create_relay_app())


def _enroll(client: TestClient, **kwargs) -> dict:
    res = client.post("/api/relay/enroll", json=enroll_body(**kwargs))
    assert res.status_code == 200, res.text
    return res.json()


def test_the_old_enrollment_and_notice_paths_answer_404(client: TestClient) -> None:
    assert client.get("/enroll").status_code == 404
    assert client.post("/enroll", json=enroll_body()).status_code == 404
    assert client.post("/enroll/renew", json={"lease": "x", "build": "1"}).status_code == 404
    assert client.post("/notice/continue?next=%2Fr%2Fx").status_code == 404
    assert client.get("/api/relay/enroll").status_code == 200


def _hello(client: TestClient, **fields) -> tuple[dict, int | None]:
    """Send a hello; return the reply frame and, for a refusal, the code the relay closed with."""
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": INSTALL, **fields})
        reply = ws.receive_json()
        if reply["type"] != "error":
            return reply, None
        try:
            ws.receive_json()
        except WebSocketDisconnect as closed:
            return reply, closed.code
        raise AssertionError("relay kept the socket open after refusing the hello")


def test_enroll_returns_a_seven_day_lease_and_the_stable_claim_key(client) -> None:
    before = int(time.time())
    grant = _enroll(client)

    lease = peek_lease(grant["lease"])
    assert (lease.kid, lease.install_id, lease.epoch, lease.build, lease.platform) == (
        "k1",
        INSTALL,
        1,
        "0.1.5",
        "macos",
    )
    assert before + LEASE_LIFETIME_SEC <= grant["exp"] <= before + LEASE_LIFETIME_SEC + 5
    assert grant["renew_at"] == grant["exp"] - 302_400
    assert grant["claim_key"] == CLAIM_KEY_FOR_INSTALL


def test_enroll_info_names_the_difficulty_and_the_relay_time(client) -> None:
    client.app.state.relay.policy.clock = lambda: 1_700_000_000.9

    assert client.get("/api/relay/enroll").json() == {
        "enroll": True,
        "pow_bits": 6,
        "epoch": 1,
        "now": 1_700_000_000,
    }


def test_enroll_and_renew_replies_carry_the_relay_time(client) -> None:
    grant = _enroll(client)
    client.app.state.relay.policy.clock = lambda: time.time() + 100

    renewed = client.post("/api/relay/enroll/renew", json={"lease": grant["lease"]}).json()

    assert abs(grant["now"] - time.time()) < 5
    assert abs(renewed["now"] - (time.time() + 100)) < 5


def test_a_proof_below_the_difficulty_is_refused_with_the_required_bits(client) -> None:
    body = enroll_body(bits=0)
    ts = body["proof"]["ts"]
    body["proof"]["nonce"] = next(
        format(n, "x")
        for n in itertools.count()
        if not pow_is_valid(body["seed"], EnrollProof(ts, format(n, "x")), bits=6, now=ts)
    )

    res = client.post("/api/relay/enroll", json=body)

    assert (res.status_code, res.json()) == (400, {"detail": "proof_invalid", "pow_bits": 6})


def test_a_proof_for_another_install_is_refused(client) -> None:
    body = foreign_proof_body("someone-else-1234567")

    assert client.post("/api/relay/enroll", json=body).json()["detail"] == "proof_invalid"


def test_a_stale_proof_is_refused(client) -> None:
    body = enroll_body()
    app_policy = client.app.state.relay.policy
    app_policy.clock = lambda: time.time() + 3600

    assert client.post("/api/relay/enroll", json=body).json()["detail"] == "proof_invalid"


@pytest.mark.parametrize(
    "body",
    [{}, {"seed": "a b", "platform": "x", "build": "1", "proof": {"ts": 1, "nonce": "n"}}],
)
def test_a_malformed_enrollment_is_refused(client, body) -> None:
    res = client.post("/api/relay/enroll", json=body)

    assert (res.status_code, res.json()) == (400, {"detail": "invalid_enrollment"})


def test_a_padded_enrollment_past_the_body_cap_is_refused(client) -> None:
    padded = json.dumps(enroll_body()).encode() + b" " * 5000

    res = client.post("/api/relay/enroll", content=padded)

    assert (res.status_code, res.json()) == (400, {"detail": "invalid_enrollment"})


def test_the_sixth_enrollment_from_one_subnet_is_rate_limited(client) -> None:
    for _ in range(5):
        _enroll(client)

    res = client.post("/api/relay/enroll", json=enroll_body())

    assert res.status_code == 429
    assert res.json()["bucket"] == "relay_enroll_subnet"
    assert int(res.headers["retry-after"]) > 0


def test_the_global_enrollment_rate_caps_across_subnets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_ENROLL_GLOBAL_BURST="2")
    client = TestClient(create_relay_app())

    _enroll(client)
    _enroll(client)
    res = client.post("/api/relay/enroll", json=enroll_body())

    assert (res.status_code, res.json()["bucket"]) == (429, "relay_enroll_global")


def test_a_subnet_refusal_does_not_spend_the_global_enrollment_rate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_ENROLL_GLOBAL_BURST="8")
    client = TestClient(create_relay_app())
    for _ in range(5):
        _enroll(client)
    body = enroll_body()
    for _ in range(20):
        assert client.post("/api/relay/enroll", json=body).status_code == 429

    from podcast_relay.limits import get_relay_limiters

    assert get_relay_limiters().enroll_global.allow("all").allowed


@pytest.mark.parametrize(
    ("address", "bucket"),
    [
        ("203.0.113.77", "203.0.113.0/24"),
        ("203.0.113.5", "203.0.113.0/24"),
        ("2001:db8:1:2:3:4:5:6", "2001:db8:1::/48"),
        ("::ffff:198.51.100.9", "198.51.100.0/24"),
        ("testclient", "unknown"),
        (None, "unknown"),
    ],
)
def test_client_subnet(address: str | None, bucket: str) -> None:
    assert client_subnet(address) == bucket


def test_a_build_below_min_build_cannot_enroll(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_MIN_BUILD="0.2.0")
    client = TestClient(create_relay_app())

    res = client.post("/api/relay/enroll", json=enroll_body(build="0.1.9"))

    assert (res.status_code, res.json()) == (426, {"detail": "build_too_old"})
    assert client.post("/api/relay/enroll", json=enroll_body(build="0.2.0")).status_code == 200


def test_the_relay_assigns_a_random_128_bit_install_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.setattr(policy_module, "new_install_id", REAL_NEW_INSTALL_ID)
    client = TestClient(create_relay_app())

    ids = {_enroll(client)["install_id"] for _ in range(3)}

    assert len(ids) == 3
    assert all(re.fullmatch(r"[0-9a-f]{32}", i) for i in ids)


def test_an_install_id_in_the_enrollment_body_is_refused(client) -> None:
    body = enroll_body() | {"install_id": "victim-install"}

    res = client.post("/api/relay/enroll", json=body)

    assert (res.status_code, res.json()) == (400, {"detail": "invalid_enrollment"})


def test_a_proof_pays_for_one_enrollment(client) -> None:
    body = enroll_body()
    assert client.post("/api/relay/enroll", json=body).status_code == 200

    again = client.post("/api/relay/enroll", json=body)

    assert (again.status_code, again.json()["detail"]) == (400, "proof_invalid")


def test_a_denied_install_is_told_so_when_it_renews(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    deny = enable_enrollment(monkeypatch, tmp_path)
    client = TestClient(create_relay_app())
    grant = _enroll(client)
    deny.write_text(f"# abuse\n{grant['install_id']}  # farm\n")
    client.app.state.relay.policy.reload_deny()

    res = client.post("/api/relay/enroll/renew", json={"lease": grant["lease"]})

    assert (res.status_code, res.json()) == (401, {"detail": "lease_refused:denied"})


def test_enrolling_with_a_previous_lease_keeps_its_install_id_even_after_it_expired(client) -> None:
    long_ago = time.time() - 3 * LEASE_LIFETIME_SEC
    client.app.state.relay.policy.clock = lambda: long_ago
    first = _enroll(client, now=int(long_ago))
    client.app.state.relay.policy.clock = time.time
    body = enroll_body() | {"previous": first["lease"]}

    res = client.post("/api/relay/enroll", json=body)

    assert res.status_code == 200
    assert res.json()["install_id"] == first["install_id"]


def test_a_previous_lease_the_relay_did_not_sign_is_ignored(client) -> None:
    body = enroll_body() | {"previous": "e30.AAAA"}

    res = client.post("/api/relay/enroll", json=body)

    assert (res.status_code, res.json()["install_id"]) == (200, "install-1")


def test_a_denied_install_cannot_enroll_again_under_its_own_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    deny = enable_enrollment(monkeypatch, tmp_path)
    client = TestClient(create_relay_app())
    first = _enroll(client)
    deny.write_text(f"{first['install_id']}\n")
    client.app.state.relay.policy.reload_deny()

    res = client.post("/api/relay/enroll", json=enroll_body() | {"previous": first["lease"]})

    assert (res.status_code, res.json()) == (403, {"detail": "install_denied"})


def test_hello_with_a_lease_registers_a_share_signed_with_the_claim_key(client) -> None:
    grant = _enroll(client)
    shares = attach_share_claims(
        [{"token": "alpha-beta-gamma", "capabilities": ["view"]}],
        host_id=INSTALL,
        secret=grant["claim_key"],
    )

    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": INSTALL, "lease": grant["lease"]})
        assert ws.receive_json() == {"type": "hello", "host_id": INSTALL, "ok": True}
        ws.send_json({"type": "register", "shares": shares})
        assert ws.receive_json() == {"type": "register", "ok": True, "share_count": 1}


def test_renew_issues_a_fresh_lease_with_the_same_claim_key_and_no_proof(client) -> None:
    first = _enroll(client)
    app_policy = client.app.state.relay.policy
    app_policy.clock = lambda: time.time() + 4 * 24 * 3600

    res = client.post("/api/relay/enroll/renew", json={"lease": first["lease"]})

    assert res.status_code == 200, res.text
    renewed = res.json()
    assert renewed["lease"] != first["lease"]
    assert renewed["claim_key"] == first["claim_key"] == CLAIM_KEY_FOR_INSTALL
    assert renewed["exp"] > first["exp"]
    assert peek_lease(renewed["lease"]).install_id == INSTALL


def test_claims_signed_before_a_renewal_still_verify_after_it(client) -> None:
    first = _enroll(client)
    shares = attach_share_claims(
        [{"token": "alpha-beta-gamma", "capabilities": ["view"]}],
        host_id=INSTALL,
        secret=first["claim_key"],
    )
    renewed = client.post("/api/relay/enroll/renew", json={"lease": first["lease"]}).json()

    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": INSTALL, "lease": renewed["lease"]})
        ws.receive_json()
        ws.send_json({"type": "register", "shares": shares})
        assert ws.receive_json()["share_count"] == 1


def test_an_expired_lease_cannot_renew_or_connect(client) -> None:
    grant = _enroll(client)
    client.app.state.relay.policy.clock = lambda: time.time() + LEASE_LIFETIME_SEC + 10

    res = client.post("/api/relay/enroll/renew", json={"lease": grant["lease"]})

    assert (res.status_code, res.json()) == (401, {"detail": "lease_refused:expired"})
    assert _hello(client, lease=grant["lease"]) == (
        {"type": "error", "detail": "lease_refused:expired"},
        4403,
    )


def test_renew_is_rate_limited_per_install(client) -> None:
    grant = _enroll(client)
    for _ in range(6):
        assert (
            client.post("/api/relay/enroll/renew", json={"lease": grant["lease"]}).status_code
            == 200
        )

    res = client.post("/api/relay/enroll/renew", json={"lease": grant["lease"]})

    assert (res.status_code, res.json()["bucket"]) == (429, "relay_renew")


def test_epoch_bump_refuses_old_leases_at_hello_but_lets_them_renew_for_a_day(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    old = _enroll(TestClient(create_relay_app()))
    monkeypatch.setenv("PODCAST_RELAY_EPOCH", "2")
    bumped = TestClient(create_relay_app())

    assert _hello(bumped, lease=old["lease"]) == (
        {"type": "error", "detail": "lease_refused:wrong_epoch"},
        4403,
    )
    renewed = bumped.post("/api/relay/enroll/renew", json={"lease": old["lease"]})
    assert renewed.status_code == 200
    assert peek_lease(renewed.json()["lease"]).epoch == 2
    assert peek_lease(renewed.json()["lease"]).install_id == old["install_id"]
    assert _hello(bumped, lease=renewed.json()["lease"])[0]["ok"] is True

    bumped.app.state.relay.policy.clock = lambda: time.time() + 25 * 3600
    late = bumped.post("/api/relay/enroll/renew", json={"lease": old["lease"]})
    assert (late.status_code, late.json()) == (401, {"detail": "lease_refused:wrong_epoch"})


def test_a_lease_two_epochs_behind_cannot_renew(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    old = _enroll(TestClient(create_relay_app()))
    monkeypatch.setenv("PODCAST_RELAY_EPOCH", "3")

    res = TestClient(create_relay_app()).post(
        "/api/relay/enroll/renew", json={"lease": old["lease"]}
    )

    assert res.status_code == 401


def test_a_live_tunnel_is_closed_when_its_lease_expires(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.setattr(policy_module, "LEASE_LIFETIME_SEC", 2)
    client = TestClient(create_relay_app())
    grant = _enroll(client)

    started = time.monotonic()
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": grant["install_id"], "lease": grant["lease"]})
        assert ws.receive_json()["ok"] is True
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()

    assert (closed.value.code, closed.value.reason) == (4403, "lease expired")
    assert time.monotonic() - started < 4
    assert client.app.state.relay.tunnels == {}


def test_kid_rotation_rejects_old_leases_and_an_overlap_key_keeps_them(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    old = _enroll(TestClient(create_relay_app()))
    new_key = write_signing_key(tmp_path / "new.pem", bytes(range(1, 33)))
    monkeypatch.setenv("PODCAST_RELAY_SIGNING_KEY", str(new_key))
    monkeypatch.setenv("PODCAST_RELAY_SIGNING_KID", "k2")
    rotated = TestClient(create_relay_app())

    assert _hello(rotated, lease=old["lease"]) == (
        {"type": "error", "detail": "lease_refused:unknown_kid"},
        4403,
    )

    import base64

    old_pub = public_key_bytes(Ed25519PrivateKey.from_private_bytes(bytes(range(32))))
    encoded = base64.urlsafe_b64encode(old_pub).decode().rstrip("=")
    monkeypatch.setenv("PODCAST_RELAY_PUBLIC_KEYS", f"k1:{encoded}")
    overlapping = TestClient(create_relay_app())

    reply, _ = _hello(overlapping, lease=old["lease"])
    assert reply == {"type": "hello", "host_id": INSTALL, "ok": True}


def test_min_build_rejects_a_connected_build_that_is_too_old(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    old = _enroll(TestClient(create_relay_app()), build="0.1.5")
    monkeypatch.setenv("PODCAST_RELAY_MIN_BUILD", "0.1.6")

    assert _hello(TestClient(create_relay_app()), lease=old["lease"]) == (
        {"type": "error", "detail": "lease_refused:build_too_old"},
        4403,
    )


def test_a_lease_only_connects_as_its_own_install(client) -> None:
    grant = _enroll(client)

    reply, code = _hello(client, host_id="install-b", lease=grant["lease"])

    assert (reply, code) == ({"type": "error", "detail": "lease_refused:wrong_install"}, 4403)


def test_a_garbled_lease_is_refused(client) -> None:
    assert _hello(client, lease="garbage") == (
        {"type": "error", "detail": "lease_refused:malformed"},
        4403,
    )


def test_a_lease_is_refused_by_a_relay_with_no_signing_key(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    grant = _enroll(client)
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "t" * 32)

    assert _hello(TestClient(create_relay_app()), lease=grant["lease"])[1] == 4403


def test_the_legacy_host_token_still_works_beside_leases(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "legacy-secret-" + "x" * 20)
    client = TestClient(create_relay_app())

    reply, _ = _hello(client, host_token="legacy-secret-" + "x" * 20)

    assert reply == {"type": "hello", "host_id": INSTALL, "ok": True}


def test_a_relay_with_no_signing_key_has_no_enrollment_and_still_takes_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "legacy-secret-" + "x" * 20)
    client = TestClient(create_relay_app())

    assert client.get("/api/relay/enroll").status_code == 404
    assert client.post("/api/relay/enroll", json={}).status_code == 404
    assert client.app.state.relay.policy is None
    assert _hello(client, host_token="legacy-secret-" + "x" * 20)[0]["ok"] is True
    assert _hello(client, host_token="wrong")[1] == 4403


def test_rotating_the_signing_key_never_changes_a_claim_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    before = create_relay_app().state.relay.policy.claim_key("install-1")
    rotated = write_signing_key(tmp_path / "new.pem", bytes(range(5, 37)))
    monkeypatch.setenv("PODCAST_RELAY_SIGNING_KEY", str(rotated))

    assert create_relay_app().state.relay.policy.claim_key("install-1") == before


@pytest.mark.parametrize("master", [None, "", "short"])
def test_a_signing_key_without_a_strong_master_key_refuses_to_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str], master
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    if master is None:
        monkeypatch.delenv("PODCAST_RELAY_MASTER_KEY")
    else:
        monkeypatch.setenv("PODCAST_RELAY_MASTER_KEY", master)

    with pytest.raises(RelayConfigError, match="PODCAST_RELAY_MASTER_KEY"):
        create_relay_app()
    with pytest.raises(SystemExit):
        relay_main()
    assert "FATAL: PODCAST_RELAY_MASTER_KEY" in capsys.readouterr().err


def test_the_deny_file_reload_period_is_five_seconds() -> None:
    assert policy_module.DENY_RELOAD_SEC == 5.0


def test_denylisting_an_install_closes_its_live_tunnel_within_the_reload_window(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import websockets
    from tests.polling import wait_for

    deny = enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.setattr(policy_module, "DENY_RELOAD_SEC", 0.05)
    app = create_relay_app()
    with live_relay(monkeypatch, app=app) as ws_base:
        http_base = ws_base.replace("ws://", "http://")
        import httpx

        grant = httpx.post(f"{http_base}/api/relay/enroll", json=enroll_body()).json()
        other = httpx.post(f"{http_base}/api/relay/enroll", json=enroll_body()).json()

        async def scenario() -> tuple[int | None, bool]:
            async with (
                websockets.connect(f"{ws_base}/tunnel") as victim,
                websockets.connect(f"{ws_base}/tunnel") as bystander,
            ):
                await victim.send(
                    json.dumps({"type": "hello", "host_id": INSTALL, "lease": grant["lease"]})
                )
                await bystander.send(
                    json.dumps({"type": "hello", "host_id": "install-2", "lease": other["lease"]})
                )
                await victim.recv()
                await bystander.recv()
                deny.write_text("install-1\n")
                try:
                    async with asyncio.timeout(3):
                        await victim.recv()
                except websockets.ConnectionClosed as closed:
                    code = closed.rcvd.code if closed.rcvd else None
                else:
                    code = None
                return code, wait_for(lambda: "install-2" in app.state.relay.tunnels) is not None

        code, bystander_alive = asyncio.run(scenario())

    assert code == 4403
    assert bystander_alive


@pytest.mark.asyncio
async def test_a_tunnel_that_passed_its_hello_before_a_deny_reload_is_refused_at_registration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    state = create_relay_app().state.relay
    session = TunnelSession(host_id="install-9", websocket=None, install_id="install-9")  # type: ignore[arg-type]
    state.policy.deny = frozenset({"install-9"})

    with pytest.raises(TunnelRefused) as refused:
        await state.register_tunnel(session)

    assert (refused.value.detail, refused.value.code) == ("lease_refused:denied", 4403)
    assert state.tunnels == {}


@pytest.mark.asyncio
async def test_the_deny_watcher_survives_an_unreadable_file_and_applies_the_next_good_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    deny = enable_enrollment(monkeypatch, tmp_path)
    policy = create_relay_app().state.relay.policy
    seen: list[frozenset[str]] = []
    unreadable: list[Exception] = []
    reload_deny = policy.reload_deny

    def spy() -> frozenset[str]:
        try:
            return reload_deny()
        except Exception as exc:
            unreadable.append(exc)
            raise

    policy.reload_deny = spy
    task = asyncio.create_task(policy_module.watch_denylist(policy, seen.append, interval_sec=0.01))
    try:
        deny.write_bytes(b"\xff\xfe not utf-8")
        await until(lambda: unreadable)
        deny.write_text("install-3\n")
        await until(lambda: seen)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert seen == [frozenset({"install-3"})]


def test_renew_reports_the_running_build_and_moves_a_lease_past_a_raised_min_build(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    enable_enrollment(monkeypatch, tmp_path)
    old = _enroll(TestClient(create_relay_app()), build="0.1.5")
    monkeypatch.setenv("PODCAST_RELAY_MIN_BUILD", "0.2.0")
    client = TestClient(create_relay_app())

    stale = client.post("/api/relay/enroll/renew", json={"lease": old["lease"]})
    updated = client.post("/api/relay/enroll/renew", json={"lease": old["lease"], "build": "0.2.1"})

    assert (stale.status_code, stale.json()) == (426, {"detail": "build_too_old"})
    assert updated.status_code == 200
    assert peek_lease(updated.json()["lease"]).build == "0.2.1"
