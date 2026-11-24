"""TunnelSupervisor - brings the host tunnel up inside the Studio process on its own.

``plan`` is the whole policy: given one snapshot of the world it names the single tunnel that
should exist. The supervisor only converges to it, so a missed tick costs latency, never a wrong
end state.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from podcast_mcp.config.runtime import RelayConfig

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
