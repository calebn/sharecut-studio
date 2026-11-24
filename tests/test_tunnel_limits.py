"""How a host reads the relay's limits and a revoked install: failures, status and copy."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.services.collaboration.tunnel_failure import (
    FailureKind,
    TunnelFailure,
    relay_rejection,
)
from podcast_mcp.services.collaboration.tunnel_status import (
    TunnelPhase,
    TunnelState,
    TunnelStatusTracker,
    read_tunnel_status,
)

BANNED = ("tunnel", "relay", "lease", "token")


def _tracker() -> TunnelStatusTracker:
    return TunnelStatusTracker(relay_host="share.example.com", public_base_url="https://s.test")


def test_a_denied_install_is_unavailable_and_never_retried() -> None:
    failure = relay_rejection("lease_refused:denied")

    assert failure.kind is FailureKind.UNAVAILABLE
    assert failure.fatal
    assert failure.detail == "online sharing is unavailable right now"
    assert failure.hint == "If you think this is a mistake, contact support."
    assert not any(word in (failure.detail + failure.hint).lower() for word in BANNED)


def test_a_lease_signed_by_a_replaced_key_is_signed_in_again_not_switched_off() -> None:
    failure = relay_rejection("lease_refused:bad_signature")

    assert failure.stale_lease
    assert not failure.fatal
    assert failure.detail == "online sharing is signing this computer in again"


def test_a_tunnel_closed_at_its_lease_expiry_is_signed_in_again_not_failed() -> None:
    from podcast_mcp.services.collaboration.tunnel_failure import _from_close_frame

    failure = _from_close_frame(4403, "lease expired")

    assert failure.stale_lease
    assert not failure.fatal


def test_an_unknown_lease_refusal_still_reads_switched_off() -> None:
    assert relay_rejection("lease_refused:something_new").kind is FailureKind.AUTH


def test_the_ended_legacy_tier_tells_the_host_to_drop_the_access_key() -> None:
    failure = relay_rejection("legacy_tier_ended")

    assert (failure.kind, failure.fatal) == (FailureKind.AUTH, True)
    assert failure.detail == "online sharing no longer accepts this access key"
    assert not any(word in (failure.detail + failure.hint).lower() for word in BANNED)


def test_a_limited_connection_is_its_own_state_with_no_failure() -> None:
    tracker = _tracker()
    tracker.connected(share_count=1, limit="bandwidth")

    status = tracker.status
    record = status.to_record()

    assert status.phase is TunnelPhase.CONNECTED
    assert status.state is TunnelState.LIMITED
    assert (record["state"], record["limit"], record["reason"], record["retry_at"]) == (
        "limited",
        "bandwidth",
        None,
        None,
    )
    assert status.line() == "Tunnel connected: https://s.test (1 share, limited: bandwidth)"


def test_clearing_the_limit_reads_online_again() -> None:
    tracker = _tracker()
    tracker.connected(share_count=1, limit="shares")
    tracker.connected(share_count=1)

    assert tracker.status.state is TunnelState.ONLINE
    assert tracker.status.to_record()["limit"] is None


def test_the_gui_reads_the_recorded_limited_state_and_ranks_it_below_online(
    tmp_path: Path,
) -> None:
    limited = _tracker()
    limited.connected(share_count=2, limit="shares")
    online = _tracker()
    online.connected(share_count=1)
    now = limited.status.updated_at
    (tmp_path / "a.json").write_text(json.dumps({**limited.status.to_record(), "pid": 1}))

    alone = read_tunnel_status(
        relay_configured=True, directory=tmp_path, now=now, pid_alive=lambda _pid: True
    )
    (tmp_path / "b.json").write_text(
        json.dumps({**online.status.to_record(), "pid": 1, "updated_at": now - 1})
    )
    both = read_tunnel_status(
        relay_configured=True, directory=tmp_path, now=now, pid_alive=lambda _pid: True
    )

    assert (alone["state"], alone["limit"]) == ("limited", "shares")
    assert both["state"] == "online"


def test_an_unavailable_failure_is_recorded_as_its_own_reason_kind() -> None:
    tracker = _tracker()
    tracker.failed(
        TunnelFailure(FailureKind.UNAVAILABLE, "online sharing is unavailable right now")
    )

    record = tracker.status.to_record()

    assert (record["state"], record["reason_kind"]) == ("offline", "unavailable")


def test_the_status_route_carries_the_support_link(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.gui.routes.tunnel import get_tunnel_status

    monkeypatch.setenv("PODCAST_DISTRIBUTION_SUPPORT_URL", "https://support.example.test/help")

    assert get_tunnel_status()["support_url"] == "https://support.example.test/help"
