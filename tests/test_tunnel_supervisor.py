"""The Studio tunnel supervisor: the pure plan, and the actor that converges to it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.config.runtime import RelayConfig
from podcast_mcp.services.collaboration import tunnel_supervisor as sup
from podcast_mcp.services.collaboration.tunnel_supervisor import (
    Idle,
    IdleReason,
    Inputs,
    Serve,
)

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
