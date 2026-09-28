"""Per-client presence deltas: PresenceRosterTracker diffing, compact Applied, RosterRequest."""

from __future__ import annotations

import json
import logging
import threading
from typing import ClassVar

from podcast_mcp.models import load_project
from podcast_mcp.services.session_sync import presence_fanout
from podcast_mcp.services.session_sync.commands import SyncCommand, normalize_presence_meta
from podcast_mcp.services.session_sync.presence_delta import (
    PresenceRosterTracker,
    is_own_presence_echo,
    meta_changes,
    presence_delta_event,
    presence_resync_event,
    presence_roster_event,
    row_changes,
)
from podcast_mcp.services.session_sync.service import SessionSyncService


class _FakeTimer:
    """Manual stand-in for ``threading.Timer``: ``.fn()`` fires the coalescer's trailing
    publish deterministically instead of racing a real 100ms window."""

    instances: ClassVar[list[_FakeTimer]] = []

    def __init__(self, delay: float, fn) -> None:
        self.delay = delay
        self.fn = fn
        self.daemon = False
        type(self).instances.append(self)

    def start(self) -> None:
        pass

    def cancel(self) -> None:
        pass


def _fire_coalescer(loop) -> None:
    """Fire the latest pending trailing publish (a no-op when nothing is pending) and pump
    the event loop so any ``call_soon_threadsafe`` queue puts land."""
    if _FakeTimer.instances:
        _FakeTimer.instances[-1].fn()
    loop.run_until_complete(__import__("asyncio").sleep(0))


def _drain(q) -> list[dict]:
    events = []
    while True:
        try:
            events.append(q.get_nowait())
        except Exception:
            break
    return events


def _presence(svc: SessionSyncService, client_id: str, *, meta=None, seq=1) -> dict:
    return svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": client_id, "playhead_sec": None, "meta": meta},
            client_id=client_id,
            role="viewer",
            client_seq=seq,
        )
    )


def test_row_changes_only_reports_changed_keys() -> None:
    prev = {
        "client_id": "c1",
        "role": "viewer",
        "label": "A",
        "acked_server_seq": 0,
        "last_seen_ns": 1,
        "playhead_sec": 1.0,
        "followers": 0,
        "meta": {"cursor": {"t_sec": 1.0}, "display_name": "A"},
    }
    curr = {
        **prev,
        "last_seen_ns": 2,
        "meta": {"cursor": {"t_sec": 2.0}, "display_name": "A"},
    }
    changes = row_changes(prev, curr)
    assert changes == {"last_seen_ns": 2, "meta": {"cursor": {"t_sec": 2.0}}}


def test_row_changes_first_row_has_no_prev() -> None:
    curr = {
        "client_id": "c1",
        "role": "viewer",
        "label": None,
        "acked_server_seq": 0,
        "last_seen_ns": 5,
        "playhead_sec": None,
        "followers": 0,
        "meta": None,
    }
    changes = row_changes(None, curr)
    assert changes == {
        "last_seen_ns": 5,
        "role": "viewer",
        "label": None,
        "acked_server_seq": 0,
        "playhead_sec": None,
        "followers": 0,
    }


def test_meta_changes_removed_key_maps_to_none() -> None:
    prev = {"cursor": {"t_sec": 1.0}, "display_name": "A"}
    curr = {"display_name": "A"}
    assert meta_changes(prev, curr) == {"cursor": None}


def test_meta_changes_new_and_updated_keys() -> None:
    prev = {"display_name": "A"}
    curr = {"display_name": "A", "cursor": {"t_sec": 1.0}}
    assert meta_changes(prev, curr) == {"cursor": {"t_sec": 1.0}}


def test_is_own_presence_echo_skips_own_delta_without_followers() -> None:
    event = presence_delta_event("c1", {"last_seen_ns": 1}, roster_version=1)
    assert is_own_presence_echo(event, "c1") is True
    assert is_own_presence_echo(event, "c2") is False


def test_is_own_presence_echo_keeps_own_followers_change() -> None:
    event = presence_delta_event("c1", {"last_seen_ns": 1, "followers": 2}, roster_version=1)
    assert is_own_presence_echo(event, "c1") is False


def test_is_own_presence_echo_ignores_non_delta_types() -> None:
    event = presence_roster_event([], roster_version=1)
    assert is_own_presence_echo(event, "c1") is False


def test_tracker_first_run_sends_one_full_presence_and_bumps_version() -> None:
    tracker = PresenceRosterTracker()
    rows = [{"client_id": "c1", "last_seen_ns": 1}]
    events = tracker.events("proj-a", rows)
    assert len(events) == 1
    assert events[0]["type"] == "Presence"
    assert events[0]["clients"] == rows
    v1 = tracker.version("proj-a")
    assert v1 > 0

    # A second key gets its own, independently bumped version.
    events2 = tracker.events("proj-b", [{"client_id": "c9", "last_seen_ns": 1}])
    assert events2[0]["type"] == "Presence"
    assert tracker.version("proj-b") != v1


def test_tracker_join_and_leave_send_full_presence_and_bump_version() -> None:
    tracker = PresenceRosterTracker()
    key = "proj"
    base = [{"client_id": "c1", "last_seen_ns": 1}]
    tracker.events(key, base)
    v1 = tracker.version(key)

    joined = [*base, {"client_id": "c2", "last_seen_ns": 1}]
    events = tracker.events(key, joined)
    assert len(events) == 1 and events[0]["type"] == "Presence"
    v2 = tracker.version(key)
    assert v2 > v1

    left = [joined[1]]
    events = tracker.events(key, left)
    assert len(events) == 1 and events[0]["type"] == "Presence"
    assert tracker.version(key) > v2


def test_tracker_unchanged_roster_sends_one_delta_for_the_changed_client() -> None:
    tracker = PresenceRosterTracker()
    key = "proj"
    c1 = {"client_id": "c1", "last_seen_ns": 1, "meta": {"cursor": {"t_sec": 1.0}}}
    c2 = {"client_id": "c2", "last_seen_ns": 1, "meta": None}
    tracker.events(key, [c1, c2])

    moved = {**c1, "last_seen_ns": 2, "meta": {"cursor": {"t_sec": 2.0}}}
    events = tracker.events(key, [moved, c2])
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "PresenceDelta"
    assert event["author_client_id"] == "c1"
    assert event["changes"] == {"last_seen_ns": 2, "meta": {"cursor": {"t_sec": 2.0}}}


def test_tracker_untouched_client_produces_no_delta() -> None:
    tracker = PresenceRosterTracker()
    key = "proj"
    c1 = {"client_id": "c1", "last_seen_ns": 1}
    c2 = {"client_id": "c2", "last_seen_ns": 1}
    tracker.events(key, [c1, c2])
    events = tracker.events(key, [c1, c2])
    assert events == []


def test_tracker_followers_change_reported_for_the_followed_client() -> None:
    tracker = PresenceRosterTracker()
    key = "proj"
    leader = {"client_id": "leader", "last_seen_ns": 1, "followers": 0}
    follower = {"client_id": "follower", "last_seen_ns": 1, "followers": 0}
    tracker.events(key, [leader, follower])

    leader_followed = {**leader, "followers": 1}
    events = tracker.events(key, [leader_followed, follower])
    assert len(events) == 1
    assert events[0]["author_client_id"] == "leader"
    assert events[0]["changes"]["followers"] == 1


def test_tracker_clear_key_drops_state() -> None:
    tracker = PresenceRosterTracker()
    tracker.events("proj", [{"client_id": "c1", "last_seen_ns": 1}])
    assert tracker.version("proj") > 0
    tracker.clear_key("proj")
    assert tracker.version("proj") == 0
    # A fresh call after clearing is treated as a first run again.
    events = tracker.events("proj", [{"client_id": "c1", "last_seen_ns": 1}])
    assert events[0]["type"] == "Presence"


def test_one_cursor_move_produces_exactly_one_presence_delta(minimal_project) -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import get_hub
    from podcast_mcp.services.session_sync.presence_delta import get_roster_tracker

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    key = str(proj.workspace_path())
    get_roster_tracker().clear_key(key)
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(key, loop)
        _presence(svc, "c1", seq=1)
        _fire_coalescer(loop)
        _presence(svc, "c2", seq=1)
        _fire_coalescer(loop)
        _drain(q)  # both clients' joins: full-roster Presence frames, not under test

        _presence(svc, "c1", meta={"cursor": {"t_sec": 5.0, "track_id": "host"}}, seq=2)
        _fire_coalescer(loop)
        events = _drain(q)
        assert len(events) == 1
        event = events[0]
        assert event["type"] == "PresenceDelta"
        assert event["author_client_id"] == "c1"
        assert "cursor" in event["changes"]["meta"]
        assert "label" not in event["changes"]
    finally:
        hub.unsubscribe(key, q)
        loop.close()
        get_roster_tracker().clear_key(key)
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_hello_snapshot_carries_full_roster_and_roster_version(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = (
        f"/api/session/ws?path={quote(str(minimal_project))}&client_id=hello-a&role=viewer&label=A"
    )
    with client.websocket_connect(url) as ws:
        first = ws.receive_json()
        assert first["type"] == "Snapshot"
        assert isinstance(first["snapshot"]["clients"], list)
        assert any(c["client_id"] == "hello-a" for c in first["snapshot"]["clients"])
        assert first["snapshot"]["roster_version"] > 0


def test_delta_frame_no_larger_than_the_clients_roster_row(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    _presence(svc, "c1", seq=1)
    row = next(c for c in svc.snapshot()["clients"] if c["client_id"] == "c1")
    event = presence_delta_event("c1", row_changes(None, row), roster_version=1)
    assert len(json.dumps(event["changes"])) <= len(json.dumps(row)) + 32


def test_follow_change_produces_followers_delta_for_the_followed_client(minimal_project) -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import get_hub
    from podcast_mcp.services.session_sync.presence_delta import get_roster_tracker

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    key = str(proj.workspace_path())
    get_roster_tracker().clear_key(key)
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(key, loop)
        _presence(svc, "leader", seq=1)
        _fire_coalescer(loop)
        _presence(svc, "follower", seq=1)
        _fire_coalescer(loop)
        _drain(q)

        svc.submit(
            SyncCommand(
                type="FollowUser",
                payload={"follow_client_id": "leader"},
                client_id="follower",
                role="viewer",
                client_seq=2,
            )
        )
        _fire_coalescer(loop)
        events = _drain(q)
        followed = [e for e in events if e.get("author_client_id") == "leader"]
        assert followed and followed[0]["changes"]["followers"] == 1
    finally:
        hub.unsubscribe(key, q)
        loop.close()
        get_roster_tracker().clear_key(key)
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_compact_applied_has_no_clients_or_fields(minimal_project) -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import get_hub

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    key = str(proj.workspace_path())
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(key, loop)
        result = svc.submit_control("SetPlayhead", {"playhead_sec": 3.5}, client_id="agent-x")
        loop.run_until_complete(asyncio.sleep(0))
        wire_event = q.get_nowait()
    finally:
        hub.unsubscribe(key, q)
        loop.close()

    assert wire_event["type"] == "Applied"
    assert "clients" not in wire_event["snapshot"]
    assert "fields" not in wire_event["snapshot"]
    assert wire_event["author_client_id"] == "agent-x"
    assert wire_event["roster_version"] >= 0

    # submit()'s own return value keeps the full snapshot.
    assert "clients" in result["snapshot"]
    assert "fields" in result["snapshot"]
    assert result["author_client_id"] == "agent-x"


def test_roster_request_through_apply_ws_client_message(minimal_project) -> None:
    from podcast_mcp.gui.routes.session import apply_ws_client_message

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    _presence(svc, "c1", seq=1)
    echo, seq = apply_ws_client_message(
        svc, {"type": "RosterRequest"}, client_id="c1", role="viewer", label="A", seq=5
    )
    assert seq == 5
    assert echo is not None
    assert echo["type"] == "Presence"
    assert any(c["client_id"] == "c1" for c in echo["clients"])
    assert echo["roster_version"] == svc.snapshot()["roster_version"]


def test_roster_request_over_the_host_ws(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = (
        f"/api/session/ws?path={quote(str(minimal_project))}&client_id=roster-a&role=viewer&label=A"
    )
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json({"type": "RosterRequest"})
        reply = ws.receive_json()
        assert reply["type"] == "Presence"
        assert any(c["client_id"] == "roster-a" for c in reply["clients"])


def test_presence_heartbeat_reads_client_rows_once(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.session_sync import log as sync_log

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)

    counts = {"n": 0}
    real_list_clients = sync_log.SyncStore.list_clients

    def _counting_list_clients(self, *args, **kwargs):
        counts["n"] += 1
        return real_list_clients(self, *args, **kwargs)

    monkeypatch.setattr(sync_log.SyncStore, "list_clients", _counting_list_clients)

    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    try:
        presence_fanout.reset()
        counts["n"] = 0
        _presence(svc, "c1", seq=1)
        assert counts["n"] == 1

        presence_fanout.reset()
        counts["n"] = 0
        svc.submit_control("SetPlayhead", {"playhead_sec": 1.0}, client_id="agent-x")
        assert counts["n"] == 1
    finally:
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_fanout_presence_after_commit_logs_and_swallows_a_store_error(
    minimal_project, monkeypatch, caplog
) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)

    def _boom(self, live_rows=None):
        raise RuntimeError("store unavailable")

    monkeypatch.setattr(SessionSyncService, "_presence_events", _boom)
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.session_sync.service"):
        svc._fanout_presence_after_commit()
    assert any("presence fan-out failed" in r.message for r in caplog.records)


def test_tracker_roster_before_any_fanout_reads_live_rows() -> None:
    tracker = PresenceRosterTracker()
    row = {"client_id": "c1", "last_seen_ns": 1}
    rows, version = tracker.roster("k", lambda: [row])
    assert rows == [row]
    assert version == 0


def test_tracker_roster_returns_base_rows_and_version_together() -> None:
    tracker = PresenceRosterTracker()
    row_a = {"client_id": "a", "last_seen_ns": 1}
    tracker.events("k", [row_a])

    def _boom():
        raise AssertionError("read_rows should not be called once a base exists")

    rows, version = tracker.roster("k", _boom)
    assert rows == [row_a]
    assert version == tracker.version("k")

    row_a_changed = {"client_id": "a", "last_seen_ns": 2}
    tracker.events("k", [row_a_changed])
    rows2, version2 = tracker.roster("k", _boom)
    assert rows2 == [row_a_changed]
    assert version2 == version


def test_normalize_presence_meta_drops_unknown_and_reserved_keys() -> None:
    assert normalize_presence_meta(
        {"__proto__": {"x": 1}, "constructor": "c", "display_name": "A"}
    ) == {"display_name": "A"}


def _drain_types(q) -> list[str]:
    kinds: list[str] = []
    while q.qsize():
        kinds.append(q.get_nowait()["type"])
    return kinds


def test_hub_overflow_collapses_buffered_presence_into_one_resync_marker() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-presence-overflow"
    q = hub.subscribe(key, loop)
    for i in range(200):
        hub.publish(key, {"type": "Applied", "server_seq": i + 1})
        loop.run_until_complete(asyncio.sleep(0))
    for i in range(56):
        hub.publish(key, presence_delta_event(f"c{i}", {"last_seen_ns": i}, roster_version=1))
        loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    hub.publish(key, presence_delta_event("c99", {"last_seen_ns": 99}, roster_version=1))
    loop.run_until_complete(asyncio.sleep(0))
    kinds = _drain_types(q)
    assert "PresenceDelta" not in kinds
    assert kinds.count("PresenceResync") == 1
    assert kinds.count("Applied") == 200
    applied_indices = [i for i, k in enumerate(kinds) if k == "Applied"]
    assert applied_indices == sorted(applied_indices)
    hub.unsubscribe(key, q)
    loop.close()


def test_hub_overflow_on_a_presence_event_with_no_buffered_presence_enqueues_the_marker() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-presence-overflow-none-buffered"
    q = hub.subscribe(key, loop)
    for i in range(256):
        hub.publish(key, {"type": "Applied", "server_seq": i + 1})
        loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    hub.publish(key, presence_delta_event("c1", {"last_seen_ns": 1}, roster_version=1))
    loop.run_until_complete(asyncio.sleep(0))
    kinds = _drain_types(q)
    assert kinds.count("PresenceResync") == 1
    assert "PresenceDelta" not in kinds
    hub.unsubscribe(key, q)
    loop.close()


def test_hub_overflow_on_a_non_presence_event_keeps_it_and_collapses_presence() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-presence-overflow-non-presence"
    q = hub.subscribe(key, loop)
    for i in range(255):
        hub.publish(key, presence_delta_event(f"c{i}", {"last_seen_ns": i}, roster_version=1))
        loop.run_until_complete(asyncio.sleep(0))
    hub.publish(key, {"type": "Applied", "server_seq": 1})
    loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    hub.publish(key, {"type": "Applied", "server_seq": 999})
    loop.run_until_complete(asyncio.sleep(0))
    kinds = _drain_types(q)
    assert kinds.count("Applied") == 2
    assert kinds.count("PresenceResync") == 1
    assert "PresenceDelta" not in kinds
    hub.unsubscribe(key, q)
    loop.close()


def test_hub_overflow_a_second_time_while_a_marker_is_buffered_keeps_one_marker() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-presence-overflow-twice"
    q = hub.subscribe(key, loop)
    for i in range(255):
        hub.publish(key, {"type": "Applied", "server_seq": i + 1})
        loop.run_until_complete(asyncio.sleep(0))
    hub.publish(key, presence_delta_event("c1", {"last_seen_ns": 1}, roster_version=1))
    loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    # Not full yet (256 == capacity, not overflowing): no marker.
    assert q.qsize() == 256
    # One more publish overflows: presence collapses into a single marker.
    hub.publish(key, presence_delta_event("c1", {"last_seen_ns": 2}, roster_version=1))
    loop.run_until_complete(asyncio.sleep(0))
    assert _drain_types(q).count("PresenceResync") == 1
    # Refill to capacity, with the marker already buffered.
    for i in range(255):
        hub.publish(key, {"type": "Applied", "server_seq": i + 1})
        loop.run_until_complete(asyncio.sleep(0))
    hub.publish(key, presence_resync_event())
    loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    # A second overflow (another presence frame) still leaves exactly one marker.
    hub.publish(key, presence_delta_event("c1", {"last_seen_ns": 3}, roster_version=1))
    loop.run_until_complete(asyncio.sleep(0))
    kinds = _drain_types(q)
    assert kinds.count("PresenceResync") == 1
    hub.unsubscribe(key, q)
    loop.close()
