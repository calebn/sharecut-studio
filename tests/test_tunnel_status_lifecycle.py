"""Tunnel status files outlive their tunnel: clean stops, dead processes, abandonment, pruning.

``read_tunnel_status`` turns each file into one state from three facts: the recorded
phase, whether the writing process still runs, and how long ago it last wrote. These
tests drive that table through the public reader, then prove a stop signal leaves the
``stopped`` snapshot the reader trusts.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import podcast_mcp.services.collaboration.tunnel as tunnel_module
import podcast_mcp.services.collaboration.tunnel_status as tunnel_status
from podcast_mcp.services.collaboration.tunnel_failure import FailureKind, TunnelFailure
from podcast_mcp.services.collaboration.tunnel_status import (
    STALE_AFTER_SEC,
    StatusFileListener,
    TunnelPhase,
    TunnelStatusTracker,
    read_tunnel_status,
)
from test_tunnel_status import ACK, PUBLIC, FakeRelay, Harness, _scripted_connect

NOW = 100_000.0
LIVE_PID = 111
DEAD_PID = 222

_STATE_OF_PHASE = {
    "connecting": "connecting",
    "connected": "online",
    "disconnected": "reconnecting",
    "reconnecting": "reconnecting",
    "failed": "offline",
    "stopped": "off",
}


def _probe(pid: int) -> bool:
    return pid == LIVE_PID


def _snapshot(
    directory: Path,
    name: str = "a",
    *,
    phase: str = "connected",
    age: float = 0.0,
    pid: int | None = None,
) -> Path:
    record: dict[str, Any] = {
        "schema": 1,
        "phase": phase,
        "state": _STATE_OF_PHASE[phase],
        "relay_host": "relay.example.test",
        "public_base_url": PUBLIC,
        "share_count": 2,
        "reason": "auth: relay rejected the host token or host id" if phase == "failed" else None,
        "reason_kind": "auth" if phase == "failed" else None,
        "retry_at": None,
        "since": NOW - age,
        "updated_at": NOW - age,
    }
    if pid is not None:
        record["pid"] = pid
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def _read(directory: Path, **kwargs: Any) -> dict[str, Any]:
    return read_tunnel_status(
        relay_configured=True, directory=directory, now=NOW, pid_alive=_probe, **kwargs
    )


# phase, recorded pid, seconds since the last write, state the host reads
DERIVATION_TABLE = [
    pytest.param("connected", LIVE_PID, 10, "online", id="live-fresh-alive"),
    pytest.param("connected", None, 10, "online", id="live-fresh-no-pid"),
    pytest.param("connecting", LIVE_PID, 10, "connecting", id="connecting-fresh"),
    pytest.param("reconnecting", LIVE_PID, 10, "reconnecting", id="reconnecting-fresh"),
    pytest.param("connected", DEAD_PID, 10, "off", id="live-fresh-process-gone"),
    pytest.param("reconnecting", DEAD_PID, 120, "off", id="live-stale-process-gone"),
    pytest.param("connected", LIVE_PID, 120, "offline", id="live-stale-alive-is-an-outage"),
    pytest.param("disconnected", None, 120, "offline", id="live-stale-no-pid-is-an-outage"),
    pytest.param("connected", LIVE_PID, 601, "off", id="live-abandoned-alive"),
    pytest.param("connected", None, 601, "off", id="live-abandoned-no-pid"),
    pytest.param("connected", DEAD_PID, 601, "off", id="live-abandoned-process-gone"),
    pytest.param("stopped", LIVE_PID, 10, "off", id="stopped-alive"),
    pytest.param("stopped", DEAD_PID, 120, "off", id="stopped-gone"),
    pytest.param("stopped", None, 601, "off", id="stopped-abandoned"),
    pytest.param("failed", DEAD_PID, 10, "offline", id="failed-fresh-process-gone"),
    pytest.param("failed", DEAD_PID, 120, "offline", id="failed-stale-process-gone"),
    pytest.param("failed", None, 120, "offline", id="failed-stale-no-pid"),
    pytest.param("failed", DEAD_PID, 601, "off", id="failed-abandoned"),
]


@pytest.mark.parametrize(("phase", "pid", "age", "expected"), DERIVATION_TABLE)
def test_state_derivation_table(
    tmp_path: Path, phase: str, pid: int | None, age: float, expected: str
):
    _snapshot(tmp_path, phase=phase, pid=pid, age=age)
    assert _read(tmp_path)["state"] == expected


def test_a_failure_the_process_exited_on_keeps_its_fix_until_abandoned(tmp_path: Path):
    _snapshot(tmp_path, phase="failed", pid=DEAD_PID, age=120)
    shown = _read(tmp_path)
    assert (shown["state"], shown["reason_kind"]) == ("offline", "auth")


def test_the_two_windows_split_an_outage_from_an_abandoned_tunnel(tmp_path: Path):
    assert STALE_AFTER_SEC == 45.0
    assert tunnel_status.ABANDONED_AFTER_SEC == 600.0
    _snapshot(tmp_path, pid=LIVE_PID)

    def at(age: float) -> dict[str, Any]:
        return read_tunnel_status(
            relay_configured=True,
            directory=tmp_path,
            now=NOW + age,
            pid_alive=_probe,
        )

    assert at(45)["state"] == "online"
    assert at(46)["state"] == "offline"
    assert at(600)["state"] == "offline"
    assert at(601)["state"] == "off"


def test_a_stopped_tunnel_view_keeps_the_relay_and_drops_the_process_id(tmp_path: Path):
    _snapshot(tmp_path, pid=DEAD_PID, age=30)
    shown = _read(tmp_path)
    assert (shown["state"], shown["relay_host"], shown["since"]) == (
        "off",
        "relay.example.test",
        NOW - 30,
    )
    assert shown["public_base_url"] is None
    assert "pid" not in shown
    _snapshot(tmp_path, pid=LIVE_PID, age=0)
    assert "pid" not in _read(tmp_path)


# --- several tunnels -------------------------------------------------------


def test_with_several_tunnels_the_best_state_wins(tmp_path: Path):
    crashed = _snapshot(tmp_path, "crashed", pid=DEAD_PID, age=5)
    outage = _snapshot(tmp_path, "outage", pid=LIVE_PID, age=120)
    healthy = _snapshot(tmp_path, "healthy", pid=LIVE_PID, age=5)
    abandoned = _snapshot(tmp_path, "abandoned", phase="failed", age=9000)

    assert _read(tmp_path)["state"] == "online"
    healthy.unlink()
    assert _read(tmp_path)["state"] == "offline"
    outage.unlink()
    assert _read(tmp_path)["state"] == "off"
    assert crashed.exists()
    assert not abandoned.exists()


# --- pruning ---------------------------------------------------------------


def test_files_past_the_abandonment_window_are_pruned_when_status_is_read(tmp_path: Path):
    fresh = _snapshot(tmp_path, "fresh", pid=LIVE_PID, age=5)
    outage = _snapshot(tmp_path, "outage", pid=LIVE_PID, age=300)
    failed_long_ago = _snapshot(tmp_path, "failed", phase="failed", age=601)
    stopped_long_ago = _snapshot(tmp_path, "stopped", phase="stopped", age=7200)

    first = _read(tmp_path)

    assert first["state"] == "online"
    assert sorted(p.name for p in tmp_path.glob("*.json")) == [fresh.name, outage.name]
    assert not failed_long_ago.exists()
    assert not stopped_long_ago.exists()
    assert _read(tmp_path) == first


def test_an_abandoned_host_reads_off_then_stays_off_with_no_files(tmp_path: Path):
    only = _snapshot(tmp_path, phase="failed", age=9000)

    assert _read(tmp_path)["state"] == "off"
    assert not only.exists()
    assert _read(tmp_path)["state"] == "off"


def test_a_process_that_is_gone_is_not_pruned_inside_the_window(tmp_path: Path):
    crashed = _snapshot(tmp_path, pid=DEAD_PID, age=30)
    assert _read(tmp_path)["state"] == "off"
    assert crashed.exists()


def test_two_readers_pruning_the_same_file_both_read_stopped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    gone = _snapshot(tmp_path, "gone", phase="failed", age=9000)
    unlink = Path.unlink

    def other_reader_got_there_first(self: Path, *args: Any, **kwargs: Any) -> None:
        unlink(self, missing_ok=True)
        unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", other_reader_got_there_first)

    assert _read(tmp_path)["state"] == "off"
    assert not gone.exists()


def test_a_directory_that_cannot_be_pruned_still_reads_stopped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    stuck = _snapshot(tmp_path, phase="stopped", age=9000)

    def refuse(self: Path, *_a: Any, **_k: Any) -> None:
        raise PermissionError("read-only cache")

    monkeypatch.setattr(Path, "unlink", refuse)

    assert _read(tmp_path)["state"] == "off"
    assert stuck.exists()


# --- the process probe -----------------------------------------------------


def test_the_probe_tells_a_running_process_from_a_finished_one():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()

    assert tunnel_status.pid_is_alive(os.getpid()) is True
    assert tunnel_status.pid_is_alive(child.pid) is False


def test_the_probe_never_signals_a_process_on_windows(monkeypatch: pytest.MonkeyPatch):
    def never(*_a: Any) -> None:
        raise AssertionError("os.kill terminates the process on Windows")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(os, "kill", never)

    assert tunnel_status.pid_is_alive(DEAD_PID) is True


def test_a_pid_the_probe_cannot_trust_is_treated_as_unknown(tmp_path: Path):
    _snapshot(tmp_path, "zero", pid=0)
    _snapshot(tmp_path, "negative", pid=-1)

    seen: list[int] = []

    def probe(pid: int) -> bool:
        seen.append(pid)
        return False

    shown = read_tunnel_status(relay_configured=True, directory=tmp_path, now=NOW, pid_alive=probe)
    assert shown["state"] == "online"
    assert seen == []


# --- the writer ------------------------------------------------------------


def test_the_tracker_records_the_process_it_runs_in(tmp_path: Path):
    path = tmp_path / "tunnel.json"
    tracker = TunnelStatusTracker(
        relay_host="relay.example.test",
        public_base_url=PUBLIC,
        listeners=[StatusFileListener(path)],
        clock=lambda: NOW,
    )

    tracker.connected(share_count=1)
    assert json.loads(path.read_text())["pid"] == os.getpid()
    tracker.heartbeat()
    assert json.loads(path.read_text())["pid"] == os.getpid()
    tracker.failed(TunnelFailure(FailureKind.NETWORK, "connection lost"))
    assert json.loads(path.read_text())["pid"] == os.getpid()


# --- clean stops -----------------------------------------------------------


def _file_phase(h: Harness) -> str:
    return json.loads(h.status_file.read_text())["phase"]


@pytest.mark.asyncio
async def test_an_exit_other_than_a_failure_still_writes_stopped(tmp_path: Path):
    h = Harness(tmp_path)

    with pytest.raises(ImportError):
        await h.run(ImportError("websockets is not installed"))

    assert h.client.tracker.status.phase is TunnelPhase.STOPPED
    assert _file_phase(h) == "stopped"
    assert read_tunnel_status(relay_configured=True, directory=tmp_path)["state"] == "off"


@pytest.mark.asyncio
async def test_a_failure_the_tunnel_exits_on_is_not_overwritten_by_stopped(tmp_path: Path):
    h = Harness(tmp_path)
    rejected = FakeRelay([{"type": "error", "detail": "invalid host_token for host_id"}])

    with pytest.raises(tunnel_module.TunnelError):
        await h.run(rejected)

    assert _file_phase(h) == "failed"
    assert read_tunnel_status(relay_configured=True, directory=tmp_path)["state"] == "offline"


class HangingRelay(FakeRelay):
    """A relay that acknowledges the host, then stays quiet like a healthy idle tunnel."""

    async def recv(self) -> str:
        if self._frames:
            return json.dumps(self._frames.pop(0))
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


async def _wait_for(condition: Callable[[], bool]) -> None:
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for the tunnel")


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGINT], ids=["SIGTERM", "SIGINT"])
async def test_a_stop_signal_ends_the_tunnel_with_a_stopped_snapshot(
    tmp_path: Path, stop_signal: signal.Signals
):
    h = Harness(tmp_path)
    rng = MagicMock()
    rng.uniform.return_value = 0.0
    previous = signal.signal(stop_signal, lambda *_: None)
    try:
        with (
            patch("websockets.connect", side_effect=_scripted_connect(HangingRelay(ACK))),
            patch("httpx.AsyncClient") as http_cls,
            patch("secrets.SystemRandom", return_value=rng),
        ):
            http = AsyncMock()
            http.__aenter__ = AsyncMock(return_value=http)
            http.__aexit__ = AsyncMock(return_value=None)
            http_cls.return_value = http

            running = asyncio.create_task(tunnel_module._run_until_signalled(h.client))
            await _wait_for(lambda: h.client.tracker.status.phase is TunnelPhase.CONNECTED)
            assert _file_phase(h) == "connected"

            os.kill(os.getpid(), stop_signal)
            await asyncio.wait_for(running, timeout=5)
    finally:
        signal.signal(stop_signal, previous)

    assert _file_phase(h) == "stopped"
    assert read_tunnel_status(relay_configured=True, directory=tmp_path)["state"] == "off"
    assert h.lines[-1] == "Tunnel stopped"
