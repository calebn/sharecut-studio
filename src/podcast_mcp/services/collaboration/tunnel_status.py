"""Tunnel connection lifecycle: the phase model, status lines, and the snapshot the GUI reads.

``TunnelStatusTracker`` is the only writer of a ``TunnelStatus``. Every phase change
is pushed to listeners: ``LineListener`` prints one line, ``StatusFileListener``
persists the snapshot that ``read_tunnel_status`` serves to the GUI's ``tunnel.status``
feature. Nothing here carries a token; text is redacted before it leaves the tracker.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from podcast_mcp.services.collaboration.tunnel_failure import TunnelFailure
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.redact import redact_secrets

log = logging.getLogger(__name__)

RECORD_SCHEMA = 1
HEARTBEAT_INTERVAL_SEC = 15.0
# A live snapshot not refreshed for three heartbeats belongs to a dead or frozen process.
STALE_AFTER_SEC = HEARTBEAT_INTERVAL_SEC * 3


class TunnelPhase(StrEnum):
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"
    STOPPED = "stopped"


class TunnelState(StrEnum):
    """What the host sees: Online, Connecting, Reconnecting or Offline."""

    ONLINE = "online"
    CONNECTING = "connecting"
    RECONNECTING = "reconnecting"
    OFFLINE = "offline"


_STATE_BY_PHASE: dict[TunnelPhase, TunnelState] = {
    TunnelPhase.CONNECTING: TunnelState.CONNECTING,
    TunnelPhase.CONNECTED: TunnelState.ONLINE,
    TunnelPhase.DISCONNECTED: TunnelState.RECONNECTING,
    TunnelPhase.RECONNECTING: TunnelState.RECONNECTING,
    TunnelPhase.FAILED: TunnelState.OFFLINE,
    TunnelPhase.STOPPED: TunnelState.OFFLINE,
}
_LIVE_PHASES = frozenset(
    {
        TunnelPhase.CONNECTING,
        TunnelPhase.CONNECTED,
        TunnelPhase.DISCONNECTED,
        TunnelPhase.RECONNECTING,
    }
)


@dataclass(frozen=True)
class TunnelStatus:
    phase: TunnelPhase
    relay_host: str
    since: float
    updated_at: float
    public_base_url: str | None = None
    share_count: int | None = None
    failure: TunnelFailure | None = None
    attempt: int = 0
    retry_in_sec: float | None = None
    gave_up_after: int | None = None

    @property
    def state(self) -> TunnelState:
        return _STATE_BY_PHASE[self.phase]

    def line(self) -> str:
        """One human line for this phase (no timestamp, no token)."""
        reason = self.failure.reason if self.failure else "unknown"
        if self.phase is TunnelPhase.CONNECTING:
            return f"Tunnel connecting to {self.relay_host}"
        if self.phase is TunnelPhase.CONNECTED:
            count = self.share_count or 0
            noun = "share" if count == 1 else "shares"
            return f"Tunnel connected: {self.public_base_url} ({count} {noun})"
        if self.phase is TunnelPhase.DISCONNECTED:
            return f"Tunnel disconnected ({reason})"
        if self.phase is TunnelPhase.RECONNECTING:
            return (
                f"Tunnel reconnecting in {self.retry_in_sec or 0.0:.1f}s (attempt {self.attempt})"
            )
        if self.phase is TunnelPhase.FAILED and self.gave_up_after is not None:
            return f"Tunnel gave up after {self.gave_up_after} attempts ({reason})"
        if self.phase is TunnelPhase.FAILED:
            hint = self.failure.hint if self.failure else ""
            return f"Tunnel failed ({reason}). {hint}".rstrip()
        return "Tunnel stopped"

    def to_record(self) -> dict[str, Any]:
        """The persisted and API shape. Tokens never reach it."""
        return {
            "schema": RECORD_SCHEMA,
            "phase": self.phase.value,
            "state": self.state.value,
            "relay_host": self.relay_host,
            "public_base_url": self.public_base_url,
            "share_count": self.share_count,
            "reason": self.failure.reason if self.failure else None,
            "reason_kind": self.failure.kind.value if self.failure else None,
            "attempt": self.attempt,
            "retry_in_sec": self.retry_in_sec,
            "since": self.since,
            "updated_at": self.updated_at,
        }


class StatusListener(Protocol):
    def on_transition(self, status: TunnelStatus) -> None: ...

    def on_heartbeat(self, status: TunnelStatus) -> None: ...


class LineListener:
    """Print one line per phase change; a heartbeat is a debug log only."""

    def __init__(self, emit: Callable[[str], None] | None = None) -> None:
        self._emit = emit or log.info

    def on_transition(self, status: TunnelStatus) -> None:
        self._emit(status.line())

    def on_heartbeat(self, status: TunnelStatus) -> None:
        log.debug("Tunnel heartbeat (%s)", status.phase.value)


class StatusFileListener:
    """Persist the snapshot after every transition and heartbeat."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._warned = False

    def on_transition(self, status: TunnelStatus) -> None:
        self._write(status)

    def on_heartbeat(self, status: TunnelStatus) -> None:
        self._write(status)

    def _write(self, status: TunnelStatus) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self._path, status.to_record())
        except OSError as exc:
            if not self._warned:
                self._warned = True
                log.warning("Cannot write tunnel status to %s: %s", self._path, exc)


class TunnelStatusTracker:
    """Owns the current ``TunnelStatus`` and tells listeners about each change."""

    def __init__(
        self,
        *,
        relay_host: str,
        public_base_url: str,
        listeners: Sequence[StatusListener] = (),
        secrets: Sequence[str] = (),
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._listeners = list(listeners)
        self._secrets = list(secrets)
        self._clock = clock
        self._public_base_url = public_base_url
        now = clock()
        self._status = TunnelStatus(
            phase=TunnelPhase.STOPPED,
            relay_host=relay_host,
            since=now,
            updated_at=now,
        )

    @property
    def status(self) -> TunnelStatus:
        return self._status

    def add_secrets(self, values: Sequence[str]) -> None:
        self._secrets.extend(v for v in values if v)

    def redact(self, text: str) -> str:
        return redact_secrets(text, self._secrets)

    def connecting(self) -> None:
        self._enter(TunnelPhase.CONNECTING)

    def connected(self, *, share_count: int) -> None:
        self._enter(
            TunnelPhase.CONNECTED,
            public_base_url=self._public_base_url,
            share_count=share_count,
        )

    def disconnected(self, failure: TunnelFailure) -> None:
        self._enter(TunnelPhase.DISCONNECTED, failure=self._scrubbed(failure))

    def reconnecting(self, *, attempt: int, delay_sec: float) -> None:
        self._enter(
            TunnelPhase.RECONNECTING,
            failure=self._status.failure,
            attempt=attempt,
            retry_in_sec=delay_sec,
        )

    def failed(self, failure: TunnelFailure, *, gave_up_after: int | None = None) -> None:
        self._enter(
            TunnelPhase.FAILED,
            failure=self._scrubbed(failure),
            gave_up_after=gave_up_after,
        )

    def stopped(self) -> None:
        self._enter(TunnelPhase.STOPPED)

    def heartbeat(self) -> None:
        self._status = replace(self._status, updated_at=self._clock())
        for listener in self._listeners:
            listener.on_heartbeat(self._status)

    def _scrubbed(self, failure: TunnelFailure) -> TunnelFailure:
        return replace(failure, detail=self.redact(failure.detail))

    def _enter(self, phase: TunnelPhase, **fields: Any) -> None:
        now = self._clock()
        self._status = TunnelStatus(
            phase=phase,
            relay_host=self._status.relay_host,
            since=now,
            updated_at=now,
            **fields,
        )
        for listener in self._listeners:
            listener.on_transition(self._status)


def _offline_record(reason: str) -> dict[str, Any]:
    return {
        "schema": RECORD_SCHEMA,
        "phase": None,
        "state": TunnelState.OFFLINE.value,
        "relay_host": None,
        "public_base_url": None,
        "share_count": None,
        "reason": reason,
        "reason_kind": None,
        "attempt": 0,
        "retry_in_sec": None,
        "since": None,
        "updated_at": None,
    }


def read_tunnel_status(path: Path, *, now: float | None = None) -> dict[str, Any]:
    """The tunnel snapshot for the GUI, with a dead or frozen process reported Offline.

    A missing or unreadable file means no tunnel is running. A live-looking snapshot
    whose heartbeat stopped (killed process, sleeping laptop) is Offline too, so the
    host never sees Online while guests see "Host offline".
    """
    try:
        record = load_json_object(path)
    except ValueError:
        return _offline_record("podcast tunnel status could not be read")
    if record is None or record.get("schema") != RECORD_SCHEMA:
        return _offline_record("podcast tunnel is not running")
    updated_at = record.get("updated_at")
    age = (time.time() if now is None else now) - float(updated_at or 0.0)
    if record.get("phase") in {p.value for p in _LIVE_PHASES} and age > STALE_AFTER_SEC:
        stale = _offline_record("podcast tunnel stopped responding")
        stale.update(relay_host=record.get("relay_host"), since=record.get("updated_at"))
        return stale
    return record


async def heartbeat_loop(
    tracker: TunnelStatusTracker,
    interval_sec: float,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    """Refresh the snapshot until cancelled so a dead process is detectable."""
    while True:
        await sleep(interval_sec)
        tracker.heartbeat()
