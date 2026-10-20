"""Host and relay limiters hold their env names, defaults and parsing (#1819).

The expected rows below are literal on purpose: a renamed env var or a changed default
breaks an operator's deployment, so the table in the source is never its own oracle.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path
from typing import get_type_hints

import pytest

from podcast_mcp.services.remote_mcp.limits import HostLimiters
from podcast_mcp.util.rate_limit import ConcurrencyGate, KeyedLimiter, LimiterSet, RateSpec
from podcast_relay.limits import RelayLimiters

ROOT = Path(__file__).resolve().parents[1]

# (attribute, bucket, rpm env, default rpm, burst env, default burst)
HOST_RATE_ROWS = [
    (
        "read",
        "host_read",
        "PODCAST_RATE_LIMIT_READ_RPM",
        300.0,
        "PODCAST_RATE_LIMIT_READ_BURST",
        60.0,
    ),
    (
        "mutate",
        "host_mutate",
        "PODCAST_RATE_LIMIT_MUTATE_RPM",
        60.0,
        "PODCAST_RATE_LIMIT_MUTATE_BURST",
        20.0,
    ),
    (
        "guest_ws_presence",
        "host_guest_ws_presence",
        "PODCAST_GUEST_WS_PRESENCE_RPM",
        900.0,
        "PODCAST_GUEST_WS_PRESENCE_BURST",
        60.0,
    ),
    (
        "guest_ws_presence_token",
        "host_guest_ws_presence_token",
        "PODCAST_GUEST_WS_PRESENCE_TOKEN_RPM",
        3600.0,
        "PODCAST_GUEST_WS_PRESENCE_TOKEN_BURST",
        200.0,
    ),
    (
        "ws_roster_request",
        "host_ws_roster_request",
        "PODCAST_WS_ROSTER_REQUEST_RPM",
        60.0,
        "PODCAST_WS_ROSTER_REQUEST_BURST",
        1.0,
    ),
    (
        "guest_ws_record",
        "guest_ws_record",
        "PODCAST_GUEST_WS_RECORD_RPM",
        600.0,
        "PODCAST_GUEST_WS_RECORD_BURST",
        10.0,
    ),
    (
        "guest_ws_record_token",
        "guest_ws_record_token",
        "PODCAST_GUEST_WS_RECORD_TOKEN_RPM",
        3000.0,
        "PODCAST_GUEST_WS_RECORD_TOKEN_BURST",
        50.0,
    ),
    (
        "guest_ws_record_signal",
        "guest_ws_record_signal",
        "PODCAST_GUEST_WS_RECORD_SIGNAL_RPM",
        1800.0,
        "PODCAST_GUEST_WS_RECORD_SIGNAL_BURST",
        80.0,
    ),
    (
        "guest_ws_record_signal_token",
        "guest_ws_record_signal_token",
        "PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_RPM",
        6000.0,
        "PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_BURST",
        200.0,
    ),
]
# (attribute, bucket, env, default limit)
HOST_GATE_ROWS = [
    ("audio_concurrent", "host_audio_concurrent", "PODCAST_RATE_LIMIT_AUDIO_CONCURRENT", 8),
    ("guest_ws_concurrent", "host_guest_ws_concurrent", "PODCAST_GUEST_WS_CONCURRENT", 8),
]
RELAY_RATE_ROWS = [
    (
        "token_http",
        "relay_token",
        "PODCAST_RELAY_TOKEN_RPM",
        600.0,
        "PODCAST_RELAY_TOKEN_BURST",
        80.0,
    ),
    ("ip_http", "relay_ip", "PODCAST_RELAY_IP_RPM", 1200.0, "PODCAST_RELAY_IP_BURST", 120.0),
    (
        "ws_msg",
        "relay_ws_msg",
        "PODCAST_RELAY_WS_MSG_RPM",
        120.0,
        "PODCAST_RELAY_WS_MSG_BURST",
        30.0,
    ),
    (
        "ws_presence",
        "relay_ws_presence",
        "PODCAST_RELAY_WS_PRESENCE_RPM",
        900.0,
        "PODCAST_RELAY_WS_PRESENCE_BURST",
        60.0,
    ),
    (
        "register",
        "relay_register",
        "PODCAST_RELAY_REGISTER_RPM",
        60.0,
        "PODCAST_RELAY_REGISTER_BURST",
        20.0,
    ),
]
RELAY_GATE_ROWS = [
    ("token_concurrent", "relay_token_concurrent", "PODCAST_RELAY_TOKEN_CONCURRENT", 24),
    ("host_concurrent", "relay_host_concurrent", "PODCAST_RELAY_HOST_CONCURRENT", 96),
    ("audio_concurrent", "relay_audio_concurrent", "PODCAST_RELAY_AUDIO_CONCURRENT", 8),
    ("ws_concurrent", "relay_ws_concurrent", "PODCAST_RELAY_WS_CONCURRENT", 8),
]

ALL_ENV_NAMES = sorted(
    {
        name
        for rows in (HOST_RATE_ROWS, RELAY_RATE_ROWS)
        for row in rows
        for name in (row[2], row[4])
    }
    | {row[2] for rows in (HOST_GATE_ROWS, RELAY_GATE_ROWS) for row in rows}
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in ALL_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    yield


def _rate(lim: object) -> tuple[str, float, float]:
    assert isinstance(lim, KeyedLimiter)
    return lim.bucket_name, lim.rate_per_min, lim.burst


def _gate(lim: object) -> tuple[str, int]:
    assert isinstance(lim, ConcurrencyGate)
    return lim.bucket_name, lim.limit


def test_the_host_has_20_env_names_and_the_relay_has_14() -> None:
    host = {r[2] for r in HOST_RATE_ROWS} | {r[4] for r in HOST_RATE_ROWS}
    host |= {r[2] for r in HOST_GATE_ROWS}
    relay = {r[2] for r in RELAY_RATE_ROWS} | {r[4] for r in RELAY_RATE_ROWS}
    relay |= {r[2] for r in RELAY_GATE_ROWS}
    assert (len(host), len(relay)) == (20, 14)


@pytest.mark.parametrize(("attr", "bucket", "rpm_env", "rpm", "burst_env", "burst"), HOST_RATE_ROWS)
def test_host_rate_limiter_defaults(
    attr: str, bucket: str, rpm_env: str, rpm: float, burst_env: str, burst: float
) -> None:
    assert _rate(getattr(HostLimiters(), attr)) == (bucket, rpm, burst)


@pytest.mark.parametrize(("attr", "bucket", "env", "limit"), HOST_GATE_ROWS)
def test_host_gate_defaults(attr: str, bucket: str, env: str, limit: int) -> None:
    assert _gate(getattr(HostLimiters(), attr)) == (bucket, limit)


@pytest.mark.parametrize(
    ("attr", "bucket", "rpm_env", "rpm", "burst_env", "burst"), RELAY_RATE_ROWS
)
def test_relay_rate_limiter_defaults(
    attr: str, bucket: str, rpm_env: str, rpm: float, burst_env: str, burst: float
) -> None:
    assert _rate(getattr(RelayLimiters(), attr)) == (bucket, rpm, burst)


@pytest.mark.parametrize(("attr", "bucket", "env", "limit"), RELAY_GATE_ROWS)
def test_relay_gate_defaults(attr: str, bucket: str, env: str, limit: int) -> None:
    assert _gate(getattr(RelayLimiters(), attr)) == (bucket, limit)


@pytest.mark.parametrize(("attr", "bucket", "rpm_env", "rpm", "burst_env", "burst"), HOST_RATE_ROWS)
def test_host_env_names_set_rpm_and_burst(
    monkeypatch: pytest.MonkeyPatch,
    attr: str,
    bucket: str,
    rpm_env: str,
    rpm: float,
    burst_env: str,
    burst: float,
) -> None:
    monkeypatch.setenv(rpm_env, "7.5")
    monkeypatch.setenv(burst_env, "3")
    assert _rate(getattr(HostLimiters(), attr)) == (bucket, 7.5, 3.0)


@pytest.mark.parametrize(
    ("attr", "bucket", "rpm_env", "rpm", "burst_env", "burst"), RELAY_RATE_ROWS
)
def test_relay_env_names_set_rpm_and_burst(
    monkeypatch: pytest.MonkeyPatch,
    attr: str,
    bucket: str,
    rpm_env: str,
    rpm: float,
    burst_env: str,
    burst: float,
) -> None:
    monkeypatch.setenv(rpm_env, "7.5")
    monkeypatch.setenv(burst_env, "3")
    assert _rate(getattr(RelayLimiters(), attr)) == (bucket, 7.5, 3.0)


@pytest.mark.parametrize(("attr", "bucket", "env", "limit"), HOST_GATE_ROWS)
def test_host_gate_env_names_set_the_limit(
    monkeypatch: pytest.MonkeyPatch, attr: str, bucket: str, env: str, limit: int
) -> None:
    monkeypatch.setenv(env, "3")
    assert _gate(getattr(HostLimiters(), attr)) == (bucket, 3)


@pytest.mark.parametrize(("attr", "bucket", "env", "limit"), RELAY_GATE_ROWS)
def test_relay_gate_env_names_set_the_limit(
    monkeypatch: pytest.MonkeyPatch, attr: str, bucket: str, env: str, limit: int
) -> None:
    monkeypatch.setenv(env, "3")
    assert _gate(getattr(RelayLimiters(), attr)) == (bucket, 3)


def test_unparsable_blank_and_fractional_values_parse_like_env_float(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "lots")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "   ")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_AUDIO_CONCURRENT", "4.9")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_CONCURRENT", "nope")
    host = HostLimiters()
    relay = RelayLimiters()
    assert _rate(host.read) == ("host_read", 300.0, 60.0)
    assert _gate(host.audio_concurrent) == ("host_audio_concurrent", 4)
    assert _gate(relay.token_concurrent) == ("relay_token_concurrent", 24)


def test_the_limiter_attributes_are_exactly_the_expected_rows() -> None:
    host = {
        k for k, v in vars(HostLimiters()).items() if isinstance(v, (KeyedLimiter, ConcurrencyGate))
    }
    relay = {
        k
        for k, v in vars(RelayLimiters()).items()
        if isinstance(v, (KeyedLimiter, ConcurrencyGate))
    }
    assert host == {r[0] for r in HOST_RATE_ROWS} | {r[0] for r in HOST_GATE_ROWS}
    assert relay == {r[0] for r in RELAY_RATE_ROWS} | {r[0] for r in RELAY_GATE_ROWS}


def test_reset_empties_every_limiter() -> None:
    for composite in (HostLimiters(), RelayLimiters()):
        for lim in vars(composite).values():
            if isinstance(lim, KeyedLimiter):
                lim.allow("k")
                assert lim._buckets
            elif isinstance(lim, ConcurrencyGate):
                lim.try_enter("k")
                assert lim._counts
        composite.reset()
        for lim in vars(composite).values():
            if isinstance(lim, KeyedLimiter):
                assert not lim._buckets
            elif isinstance(lim, ConcurrencyGate):
                assert not lim._counts


def _mismatches(cls: type[LimiterSet]) -> list[str]:
    """Where a composite's annotated attributes and its ``TABLE`` rows disagree."""
    hints = {k: v for k, v in get_type_hints(cls).items() if k != "TABLE"}
    problems = [f"{row.attr}: not annotated" for row in cls.TABLE if row.attr not in hints]
    for attr, hint in hints.items():
        rows = [row for row in cls.TABLE if row.attr == attr]
        if not rows:
            problems.append(f"{attr}: annotated but not in TABLE")
        elif hint is not (KeyedLimiter if isinstance(rows[0], RateSpec) else ConcurrencyGate):
            problems.append(f"{attr}: annotation does not match its row")
    return problems


@pytest.mark.parametrize("cls", [HostLimiters, RelayLimiters])
def test_each_composite_is_exactly_its_table(cls: type[LimiterSet]) -> None:
    assert _mismatches(cls) == []
    assert len({row.attr for row in cls.TABLE}) == len(cls.TABLE)
    assert len({row.bucket for row in cls.TABLE}) == len(cls.TABLE)


def test_a_limiter_outside_the_table_or_a_wrong_annotation_is_caught() -> None:
    class Hand(HostLimiters):
        extra: KeyedLimiter
        audio_concurrent: KeyedLimiter

    assert sorted(_mismatches(Hand)) == [
        "audio_concurrent: annotation does not match its row",
        "extra: annotated but not in TABLE",
    ]


def test_an_added_row_is_built_and_reset_without_other_code() -> None:
    probe = RateSpec("probe", "relay_probe", "PODCAST_RELAY_PROBE", 5.0, 2.0)

    class Wider(RelayLimiters):
        TABLE = (*RelayLimiters.TABLE, probe)

    wider = Wider()
    assert _rate(wider.__dict__["probe"]) == ("relay_probe", 5.0, 2.0)
    wider.__dict__["probe"].allow("k")
    wider.reset()
    assert not wider.__dict__["probe"]._buckets


def _constructed_names(source: str) -> set[str]:
    return {
        node.func.id
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }


@pytest.mark.parametrize(
    "path", ["src/podcast_mcp/services/remote_mcp/limits.py", "src/podcast_relay/limits.py"]
)
def test_the_limit_modules_construct_no_limiter_by_hand(path: str) -> None:
    built = _constructed_names((ROOT / path).read_text())
    assert not built & {"KeyedLimiter", "ConcurrencyGate", "TokenBucket"}


def test_a_hand_built_limiter_is_detected_by_the_scan() -> None:
    planted = "class L:\n    def __init__(self):\n        self.a = KeyedLimiter()\n"
    assert _constructed_names(planted) == {"KeyedLimiter"}
