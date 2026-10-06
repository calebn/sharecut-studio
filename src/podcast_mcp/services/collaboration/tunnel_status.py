"""Tunnel connection lifecycle: the phase model, status lines, and the snapshot the GUI reads.

``TunnelStatusTracker`` is the only writer of a ``TunnelStatus``. Every phase change
is pushed to listeners: ``LineListener`` prints one line, ``StatusFileListener``
persists the snapshot that ``read_tunnel_status`` serves to the GUI's ``tunnel.status``
feature. Snapshots live in one file per tunnel identity under the machine cache, so
the GUI finds them whatever ``--config`` the tunnel ran with. Nothing here carries a
token; text is redacted before it leaves the tracker.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from podcast_mcp.config import cache_dir
from podcast_mcp.runtime_config import RelayConfig
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
    """What the host's Share dialog says about guests reaching their links.

    ``OFF`` is a tunnel stopped on purpose, or online sharing set up but never
    started. ``NOT_SET_UP`` is a local-only host: no relay settings and no tunnel
    has ever reported, so the dialog shows nothing.
    """

    ONLINE = "online"
    CONNECTING = "connecting"
    RECONNECTING = "reconnecting"
    OFFLINE = "offline"
    OFF = "off"
    NOT_SET_UP = "not_set_up"


# When several tunnels report, the GUI shows the one guests are best served by.
_STATE_RANK: dict[str, int] = {
    state.value: rank
    for rank, state in enumerate(
        (
            TunnelState.ONLINE,
            TunnelState.RECONNECTING,
            TunnelState.CONNECTING,
            TunnelState.OFFLINE,
            TunnelState.OFF,
        )
    )
}


_STATE_BY_PHASE: dict[TunnelPhase, TunnelState] = {
    TunnelPhase.CONNECTING: TunnelState.CONNECTING,
    TunnelPhase.CONNECTED: TunnelState.ONLINE,
    TunnelPhase.DISCONNECTED: TunnelState.RECONNECTING,
    TunnelPhase.RECONNECTING: TunnelState.RECONNECTING,
    TunnelPhase.FAILED: TunnelState.OFFLINE,
    TunnelPhase.STOPPED: TunnelState.OFF,
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
        """The persisted and API shape. Tokens never reach it.

        ``retry_at`` is the wall-clock time of the next reconnect try, so the GUI can
        count down without knowing when the snapshot was written.
        """
        return {
            "schema": RECORD_SCHEMA,
            "phase": self.phase.value,
            "state": self.state.value,
            "relay_host": self.relay_host,
            "public_base_url": self.public_base_url,
            "share_count": self.share_count,
            "reason": self.failure.reason if self.failure else None,
            "reason_kind": self.failure.kind.value if self.failure else None,
            "retry_at": (self.since + self.retry_in_sec if self.retry_in_sec is not None else None),
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


def tunnel_status_dir() -> Path:
    """Where every tunnel on this machine writes its snapshot: ``<cache>/tunnel``."""
    return cache_dir() / "tunnel"


def tunnel_status_path(cfg: RelayConfig) -> Path:
    """This tunnel's snapshot file, keyed by host id and relay URL.

    Two tunnels for different hosts or relays write different files; two tunnels
    with the same identity would also collide on the relay, so they share one.
    """
    identity = f"{cfg.host_id}\n{cfg.relay_url}".encode()
    return tunnel_status_dir() / f"{hashlib.sha256(identity).hexdigest()[:16]}.json"


def _inactive_record(state: TunnelState, reason: str) -> dict[str, Any]:
    return {
        "schema": RECORD_SCHEMA,
        "phase": None,
        "state": state.value,
        "relay_host": None,
        "public_base_url": None,
        "share_count": None,
        "reason": reason,
        "reason_kind": None,
        "retry_at": None,
        "since": None,
        "updated_at": None,
    }


def _current_view(record: dict[str, Any], now: float) -> dict[str, Any]:
    """A live-looking snapshot whose heartbeat stopped (killed process, sleeping laptop)
    is Offline, so the host never sees Online while guests see "Host offline"."""
    age = now - float(record.get("updated_at") or 0.0)
    if record.get("phase") in {p.value for p in _LIVE_PHASES} and age > STALE_AFTER_SEC:
        stale = _inactive_record(TunnelState.OFFLINE, "podcast tunnel stopped responding")
        stale.update(relay_host=record.get("relay_host"), since=record.get("updated_at"))
        return stale
    return record


def _load_records(directory: Path) -> list[dict[str, Any]]:
    try:
        paths = sorted(directory.glob("*.json"))
    except OSError:
        return []
    records = []
    for path in paths:
        try:
            record = load_json_object(path)
        except ValueError:
            log.debug("Skipping unreadable tunnel status %s", path)
            continue
        if record is not None and record.get("schema") == RECORD_SCHEMA:
            records.append(record)
    return records


def read_tunnel_status(
    *,
    relay_configured: bool,
    directory: Path | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """The tunnel snapshot for the GUI's Share dialog.

    With no snapshot on disk, a host with relay settings reads Off and a local-only
    host reads Not set up. With several, the best state wins (Online, Reconnecting,
    Connecting, Offline, Off), then the most recently updated.
    """
    records = _load_records(directory or tunnel_status_dir())
    if not records:
        if relay_configured:
            return _inactive_record(TunnelState.OFF, "podcast tunnel has not run")
        return _inactive_record(TunnelState.NOT_SET_UP, "online sharing is not set up")
    clock = time.time() if now is None else now
    views = [_current_view(record, clock) for record in records]
    return min(
        views,
        key=lambda v: (
            _STATE_RANK.get(str(v.get("state")), len(_STATE_RANK)),
            -float(v.get("updated_at") or v.get("since") or 0.0),
        ),
    )


async def heartbeat_loop(
    tracker: TunnelStatusTracker,
    interval_sec: float,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    """Refresh the snapshot until cancelled so a dead process is detectable."""
    while True:
        await sleep(interval_sec)
        tracker.heartbeat()
