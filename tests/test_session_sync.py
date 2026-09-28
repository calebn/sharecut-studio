from __future__ import annotations

import errno
import json
import logging
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event, get_ident
from typing import Literal

import pytest

from podcast_mcp.models import load_project
from podcast_mcp.services.session_control import SessionControlService
from podcast_mcp.services.session_sync import log as session_sync_log
from podcast_mcp.services.session_sync.commands import SyncCommand
from podcast_mcp.services.session_sync.log import SyncStore
from podcast_mcp.services.session_sync.service import (
    SessionSyncService,
    next_client_seq,
    read_session_state,
    session_meta,
    sync_db_path,
    sync_db_path_for_workspace,
)
from podcast_mcp.services.session_sync.snapshot import (
    apply_command,
    empty_snapshot,
    flatten_for_api,
)
from podcast_mcp.services.session_sync.viewer import (
    publish_agent_play,
    publish_viewer_snapshot,
)
from podcast_mcp.services.workspace import ProjectWorkspace


def test_play_os_vs_audition_commands(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    os_play = svc.submit_play(
        timeline_start_sec=10.0,
        timeline_end_sec=20.0,
        source="premix",
        tier="premix",
        dry_run=False,
    )
    snap = os_play["snapshot"]
    assert snap["is_playing"] is False
    assert snap["region"] == {"start_sec": 10.0, "end_sec": 20.0}
    assert snap["server_seq"] >= 1

    dry = svc.submit_play(
        timeline_start_sec=30.0,
        timeline_end_sec=40.0,
        source="processed:host",
        tier="stem",
        dry_run=True,
    )
    snap2 = dry["snapshot"]
    assert snap2["is_playing"] is True
    assert snap2["audition_mode"] == "fx"
    assert snap2["track_id"] == "host"


def test_idempotent_client_seq(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    cmd = SyncCommand(
        type="SetPlayhead",
        payload={"playhead_sec": 5.0},
        client_id="c1",
        role="viewer",
        client_seq=99,
        command_id="fixed-id",
    )
    a = svc.submit(cmd)
    b = svc.submit(cmd)
    assert a["server_seq"] == b["server_seq"]
    assert a["command"]["command_id"] == b["command"]["command_id"]


def test_legacy_positive_generated_seq_rejects_distinct_command(minimal_project) -> None:
    """An upgraded log must not replay an old generated row as a new client edit."""
    import pytest

    proj = load_project(minimal_project)
    legacy_store = SyncStore(sync_db_path(proj))
    legacy_store.append_and_apply(
        command_id="legacy-generated",
        client_id="agent-control",
        client_seq=1,
        role="agent",
        type="SetPlayhead",
        payload={"playhead_sec": 5.0},
        causation_id=None,
        apply_fn=apply_command,
        empty_snap_fn=empty_snapshot,
    )
    legacy_store.close()

    svc = SessionSyncService(proj)
    retry = svc.submit(
        SyncCommand(
            type="SetPlayhead",
            payload={"playhead_sec": 5.0},
            client_id="agent-control",
            role="agent",
            client_seq=1,
            command_id="legacy-generated",
        )
    )
    assert retry["idempotent"] is True
    assert retry["server_seq"] == 1

    with pytest.raises(ValueError, match="different command_id"):
        svc.submit(
            SyncCommand(
                type="SetPlayhead",
                payload={"playhead_sec": 9.0},
                client_id="agent-control",
                role="agent",
                client_seq=1,
                command_id="new-explicit",
            )
        )
    assert svc.snapshot()["server_seq"] == 1
    assert svc.snapshot()["playhead_sec"] == 5.0

    fresh = svc.submit(
        SyncCommand(
            type="SetPlayhead",
            payload={"playhead_sec": 9.0},
            client_id="agent-control",
            role="agent",
            client_seq=2,
            command_id="new-explicit",
        )
    )
    assert fresh["server_seq"] == 2
    assert fresh["snapshot"]["playhead_sec"] == 9.0


def test_store_rejects_distinct_command_id_on_existing_client_seq(tmp_path) -> None:
    import pytest

    path = tmp_path / "sync.db"
    first = SyncStore(path, enforce_command_ids=True)
    second = SyncStore(path, enforce_command_ids=True)
    args = {
        "client_id": "viewer-1",
        "client_seq": 1,
        "role": "viewer",
        "type": "SetPlayhead",
        "payload": {"playhead_sec": 1.0},
        "causation_id": None,
        "apply_fn": apply_command,
        "empty_snap_fn": empty_snapshot,
    }
    first.append_and_apply(command_id="first", **args)
    with pytest.raises(ValueError, match="different command_id"):
        second.append_and_apply(command_id="second", **args)
    assert second.get_snapshot()["server_seq"] == 1
    first.close()
    second.close()


def test_prefixed_store_keeps_sequence_only_retries(tmp_path) -> None:
    store = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    args = {
        "client_id": "guest-1",
        "client_seq": 1,
        "role": "viewer",
        "type": "SetPlayhead",
        "payload": {"playhead_sec": 1.0},
        "causation_id": None,
    }
    first = store.append_command(command_id="first", **args)
    retry = store.append_command(command_id="new-id", **args)
    assert retry["server_seq"] == first["server_seq"]
    assert retry["command_id"] == "first"
    store.close()


def test_generated_client_seq_survives_new_process_counter(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.session_sync import service

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    first = svc.submit_control("SetPlayhead", {"playhead_sec": 30.0})
    # A fresh CLI process starts the old module counter at 1 again.
    monkeypatch.setattr(service, "next_client_seq", lambda: 1)
    second = SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 40.0})
    assert not second.get("idempotent", False)
    assert second["server_seq"] > first["server_seq"]
    assert second["command"]["client_seq"] == first["command"]["client_seq"] - 1
    assert second["snapshot"]["playhead_sec"] == 40.0


def test_cli_seeks_from_separate_processes_are_not_deduped(minimal_project) -> None:
    script = (
        "import json, sys; "
        "from podcast_mcp.services.session_control import SessionControlService; "
        "from podcast_mcp.services.workspace import ProjectWorkspace; "
        "state = SessionControlService(ProjectWorkspace.open(sys.argv[1])).seek(float(sys.argv[2])); "
        "print(json.dumps({'server_seq': state['server_seq'], "
        "'playhead_sec': state['playhead_sec']}))"
    )

    def seek(seconds: float) -> dict[str, float]:
        completed = subprocess.run(
            [sys.executable, "-c", script, str(minimal_project), str(seconds)],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    first = seek(30.0)
    second = seek(40.0)
    assert second["server_seq"] > first["server_seq"]
    assert second["playhead_sec"] == 40.0


def test_generated_seq_follows_explicit_client_seq(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit(
        SyncCommand(
            type="SetPlayhead",
            payload={"playhead_sec": 5.0},
            client_id="agent-control",
            role="agent",
            client_seq=19,
        )
    )
    generated = svc.submit_control("SetPlayhead", {"playhead_sec": 6.0})
    assert generated["command"]["client_seq"] == -1
    explicit = svc.submit(
        SyncCommand(
            type="SetPlayhead",
            payload={"playhead_sec": 7.0},
            client_id="agent-control",
            role="agent",
            client_seq=20,
        )
    )
    assert not explicit.get("idempotent", False)
    assert explicit["snapshot"]["playhead_sec"] == 7.0


def test_generated_command_id_retry_is_idempotent(minimal_project) -> None:
    svc = SessionSyncService(load_project(minimal_project))
    command = SyncCommand(
        type="SetPlayhead",
        payload={"playhead_sec": 8.0},
        client_id="agent-control",
        role="agent",
        client_seq=None,
    )
    first = svc.submit(command)
    retry = svc.submit(command)
    assert retry["idempotent"] is True
    assert retry["server_seq"] == first["server_seq"]
    assert retry["command"]["command_id"] == command.command_id


def test_explicit_client_seq_cannot_enter_generated_range(minimal_project) -> None:
    import pytest

    svc = SessionSyncService(load_project(minimal_project))
    with pytest.raises(ValueError, match="positive"):
        svc.submit(
            SyncCommand(
                type="SetPlayhead",
                payload={"playhead_sec": 8.0},
                client_id="agent-control",
                role="agent",
                client_seq=-1,
            )
        )


def test_independent_store_connections_materialize_in_order(tmp_path) -> None:
    db_path = tmp_path / "sync.db"
    first_store = SyncStore(db_path)
    second_store = SyncStore(db_path)
    first_entered = Event()
    second_done = Event()

    def slow_first_apply(snapshot, row):
        first_entered.set()
        second_done.wait(timeout=1.0)
        return apply_command(snapshot, row)

    def submit(store, command_id, seconds, apply_fn):
        return store.append_and_apply(
            command_id=command_id,
            client_id="agent-control",
            client_seq=None,
            role="agent",
            type="SetPlayhead",
            payload={"playhead_sec": seconds},
            causation_id=None,
            apply_fn=apply_fn,
            empty_snap_fn=empty_snapshot,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(submit, first_store, "first", 1.0, slow_first_apply)
        assert first_entered.wait(timeout=5.0)
        second = pool.submit(submit, second_store, "second", 2.0, apply_command)
        second.add_done_callback(lambda _: second_done.set())
        assert first.result()[0]["server_seq"] == 1
        assert second.result()[0]["server_seq"] == 2
    snapshot = first_store.get_snapshot()
    assert snapshot is not None
    assert snapshot["server_seq"] == 2
    assert snapshot["playhead_sec"] == 2.0
    first_store.close()
    second_store.close()


def test_failed_session_apply_rolls_back_generated_command(tmp_path) -> None:
    import pytest

    store = SyncStore(tmp_path / "sync.db")

    def fail_apply(snapshot, row):
        raise ValueError("bad command")

    with pytest.raises(ValueError, match="bad command"):
        store.append_and_apply(
            command_id="failed",
            client_id="agent-control",
            client_seq=None,
            role="agent",
            type="SetPlayhead",
            payload={"playhead_sec": 1.0},
            causation_id=None,
            apply_fn=fail_apply,
            empty_snap_fn=empty_snapshot,
        )
    assert store.commands_after(0) == []
    assert store.get_snapshot() is None
    store.close()


def test_paused_viewer_scrub_persists_playhead(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlayhead", {"playhead_sec": 10.0})
    out = publish_viewer_snapshot(
        proj,
        {"client_id": "viewer-paused", "is_playing": False, "playhead_sec": 12.5},
    )
    assert out["playhead_sec"] == 12.5
    assert svc.snapshot()["playhead_sec"] == 12.5
    assert out["last_client_id"] == "viewer-paused"


def test_viewer_pause_then_scrub_updates_durable_playhead(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlaying", {"is_playing": True})
    out = publish_viewer_snapshot(
        proj,
        {"client_id": "viewer-paused", "is_playing": False, "playhead_sec": 14.0},
    )
    assert out["is_playing"] is False
    assert out["playhead_sec"] == 14.0
    assert svc.snapshot()["playhead_sec"] == 14.0


def test_concurrent_writers_converge(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)

    def agent_seek(i: int) -> int:
        r = svc.submit(
            SyncCommand(
                type="SetPlayhead",
                payload={"playhead_sec": float(i)},
                client_id="agent",
                role="agent",
                client_seq=next_client_seq(),
            )
        )
        return int(r["server_seq"])

    def viewer_mode() -> int:
        r = svc.submit(
            SyncCommand(
                type="SetMode",
                payload={"audition_mode": "fx", "source": "processed"},
                client_id="viewer-a",
                role="viewer",
                client_seq=next_client_seq(),
            )
        )
        return int(r["server_seq"])

    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(agent_seek, i) for i in range(5)]
        futs.append(pool.submit(viewer_mode))
        seqs = [f.result() for f in futs]
    assert len(set(seqs)) == len(seqs)
    snap = svc.snapshot()
    assert snap["audition_mode"] == "fx"
    assert snap["server_seq"] == max(seqs)


def test_seek_without_region_applies(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlayhead", {"playhead_sec": 42.0})
    # Viewer heartbeat must not erase seek (field LWW - different fields ok)
    svc.submit(
        SyncCommand(
            type="SetSelection",
            payload={"selection": {"kind": "track", "track_id": "host"}},
            client_id="viewer",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    snap = svc.snapshot()
    assert snap["playhead_sec"] == 42.0
    assert snap["selection"]["track_id"] == "host"


def test_agent_seek_with_selection(minimal_project) -> None:
    from podcast_mcp.services.session_control import SessionControlService
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    snap = SessionControlService(ws).seek(
        12.5,
        selection={"kind": "pending", "id": "edit-1", "track_id": "host"},
    )
    assert snap["playhead_sec"] == 12.5
    assert snap["selection"]["kind"] == "pending"
    assert snap["selection"]["id"] == "edit-1"
    assert snap["last_role"] == "agent"


def test_agent_play_with_selection(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    r = svc.submit_play(
        timeline_start_sec=3.0,
        timeline_end_sec=5.0,
        source="premix",
        tier="premix",
        dry_run=True,
        selection={"kind": "applied", "id": "rec-1", "track_id": "host"},
    )
    snap = r["snapshot"]
    assert snap["region"]["start_sec"] == 3.0
    assert snap["selection"]["kind"] == "applied"
    assert snap["selection"]["id"] == "rec-1"


def test_ack_and_presence(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    r = svc.submit_control("SetPlayhead", {"playhead_sec": 1.0})
    seq = r["server_seq"]
    svc.submit(
        SyncCommand(
            type="Ack",
            payload={"acked_server_seq": seq, "label": "DAW"},
            client_id="viewer-1",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "DAW", "playhead_sec": 1.0},
            client_id="viewer-1",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    clients = svc.snapshot()["clients"]
    assert any(c["client_id"] == "viewer-1" for c in clients)


def test_follow_user_presence_meta(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "Host", "playhead_sec": 0.0},
            client_id="viewer-host",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    svc.submit(
        SyncCommand(
            type="FollowUser",
            payload={
                "follow_client_id": "viewer-host",
                "display_name": "Guest",
                "label": "Guest",
            },
            client_id="viewer-guest",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    snap = svc.snapshot()
    guest = next(c for c in snap["clients"] if c["client_id"] == "viewer-guest")
    host = next(c for c in snap["clients"] if c["client_id"] == "viewer-host")
    assert guest["meta"]["following"] == "viewer-host"
    assert host["followers"] == 1
    assert "server_time_ns" in snap


def test_follow_user_drops_oversize_id(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit(
        SyncCommand(
            type="FollowUser",
            payload={"follow_client_id": "x" * 80, "label": "Guest"},
            client_id="viewer-guest",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    guest = next(c for c in svc.snapshot()["clients"] if c["client_id"] == "viewer-guest")
    following = (guest.get("meta") or {}).get("following")
    assert following != "x" * 80


def test_presence_label_sanitized_like_display_name(minimal_project) -> None:
    """#653: roster ``label`` gets the display-name rule on Ack, heartbeat and FollowUser."""
    svc = SessionSyncService(load_project(minimal_project))

    def send(
        ctype: Literal["Ack", "PresenceHeartbeat", "FollowUser"], cid: str, label: object
    ) -> None:
        payload: dict[str, object] = {"label": label}
        if ctype == "Ack":
            payload["acked_server_seq"] = 0
        svc.submit(
            SyncCommand(
                type=ctype,
                payload=payload,
                client_id=cid,
                role="viewer",
                client_seq=next_client_seq(),
            )
        )

    def label(cid: str) -> str | None:
        return next(c["label"] for c in svc.snapshot()["clients"] if c["client_id"] == cid)

    for ctype in ("Ack", "PresenceHeartbeat", "FollowUser"):
        long_id = f"viewer-long-{ctype}"
        send(ctype, long_id, "x" * 500)
        assert label(long_id) == "x" * 40
        ctl_id = f"viewer-ctl-{ctype}"
        send(ctype, ctl_id, "A\x00​\n  B\x1b")
        assert label(ctl_id) == "A B"
        guest_id = f"guest-abcdefgh-{ctype.lower()}"
        send(ctype, guest_id, "Host")
        assert label(guest_id) == "Host (guest)"
        host_id = f"viewer-host-{ctype}"
        send(ctype, host_id, "Host")
        assert label(host_id) == "Host"
        # Blank sanitizes to None; touch_client COALESCEs, so the last good label stays.
        send(ctype, host_id, "   ")
        assert label(host_id) == "Host"


def test_remove_client_skips_stale_generation(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    first = svc.claim_client("tab-a")
    svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "A"},
            client_id="tab-a",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    second = svc.claim_client("tab-a")
    svc.remove_client("tab-a", generation=first)
    ids = {c["client_id"] for c in svc.snapshot()["clients"]}
    assert "tab-a" in ids
    svc.remove_client("tab-a", generation=second)
    ids = {c["client_id"] for c in svc.snapshot()["clients"]}
    assert "tab-a" not in ids


def test_authz_strict_remote(monkeypatch) -> None:
    from podcast_mcp.services.session_sync.authz import authorize_client

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    assert authorize_client(client_id="a", role="viewer").allowed
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)
    assert authorize_client(client_id="a", role="viewer", peer_host="127.0.0.1").allowed
    denied = authorize_client(client_id="a", role="viewer", peer_host="10.0.0.5")
    assert not denied.allowed
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "secret")
    assert authorize_client(
        client_id="a",
        role="viewer",
        peer_host="10.0.0.5",
        token="secret",
    ).allowed


def test_empty_snapshot_and_replay_without_store(minimal_project) -> None:
    from podcast_mcp.services.session_sync.service import SessionSyncService

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    assert svc.snapshot()["server_seq"] == 0
    assert svc.meta()["exists"] is False


def test_hub_unsubscribe_and_full_queue(minimal_project) -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-full"
    q = hub.subscribe(key, loop)
    hub.unsubscribe(key, q)
    hub.unsubscribe(key, q)  # idempotent
    # Fill beyond maxsize so put_nowait hits QueueFull drop path
    q2 = hub.subscribe(key, loop)
    for i in range(300):
        hub.publish(key, {"n": i})
        loop.run_until_complete(asyncio.sleep(0))
    assert q2.qsize() == 256
    hub.unsubscribe(key, q2)
    # Publish with closed loop is swallowed
    q3 = hub.subscribe(key, loop)
    loop.close()
    hub.publish(key, {"n": 1})
    hub.unsubscribe(key, q3)


def test_hub_publish_only_schedules_delivery() -> None:
    """Document submit publishes under the project and sqlite write locks: publish must not block."""
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-schedule"
    try:
        queue = hub.subscribe(key, loop)
        hub.publish(key, {"n": 1})  # the loop is not running: a blocking publish would hang
        assert queue.qsize() == 0
        loop.run_until_complete(asyncio.sleep(0))
        assert queue.get_nowait() == {"n": 1}
        hub.unsubscribe(key, queue)
    finally:
        loop.close()


def test_apply_ws_client_message_paths(minimal_project) -> None:
    from podcast_mcp.gui.server import apply_ws_client_message

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    echo, seq = apply_ws_client_message(
        svc,
        {
            "type": "Command",
            "command_type": "SetPlayhead",
            "payload": {"playhead_sec": 4.0},
            "client_seq": 10,
        },
        client_id="ws-x",
        role="viewer",
        label="A",
        seq=1,
    )
    assert echo is not None and echo["type"] == "Echo"
    assert echo["snapshot"]["playhead_sec"] == 4.0
    _, seq = apply_ws_client_message(
        svc,
        {"type": "Ack", "acked_server_seq": 1, "client_seq": 11},
        client_id="ws-x",
        role="viewer",
        label="A",
        seq=seq,
    )
    assert seq == 2
    _, seq = apply_ws_client_message(
        svc,
        {"type": "Presence", "playhead_sec": 4.0, "client_seq": 12},
        client_id="ws-x",
        role="viewer",
        label="A",
        seq=seq,
    )
    assert seq == 3
    none, seq2 = apply_ws_client_message(
        svc,
        {"type": "noop"},
        client_id="ws-x",
        role="viewer",
        label=None,
        seq=seq,
    )
    assert none is None and seq2 == seq


def test_apply_ws_viewer_state_publishes_durable_deltas(minimal_project) -> None:
    from podcast_mcp.gui.server import apply_ws_viewer_state

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    echo = apply_ws_viewer_state(
        svc,
        {"selection": {"kind": "track", "track_id": "host"}, "client_id": "spoofed"},
        client_id="ws-vs",
        role="viewer",
        label="Host",
    )
    assert echo is not None and echo["type"] == "Echo"
    assert echo["command"] == {"type": "ViewerState", "client_id": "ws-vs", "role": "viewer"}
    assert echo["snapshot"]["selection"] == {"kind": "track", "track_id": "host"}
    assert echo["snapshot"]["last_client_id"] == "ws-vs"

    repeat = apply_ws_viewer_state(
        svc,
        {"selection": {"kind": "track", "track_id": "host"}},
        client_id="ws-vs",
        role="viewer",
        label="Host",
    )
    assert repeat is not None
    assert repeat["snapshot"]["server_seq"] == echo["snapshot"]["server_seq"]


def test_apply_ws_viewer_state_rejects_malformed(minimal_project) -> None:
    from podcast_mcp.gui.server import apply_ws_viewer_state

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)

    bad = apply_ws_viewer_state(svc, "nope", client_id="ws-vs", role="viewer", label=None)
    assert bad is not None and bad["type"] == "Error"
    assert bad["code"] == "invalid_viewer_state"

    missing = apply_ws_viewer_state(svc, None, client_id="ws-vs", role="viewer", label=None)
    assert missing is not None and missing["code"] == "invalid_viewer_state"
    assert svc.state_or_none() is None


def test_apply_ws_viewer_state_service_errors_answer_error_frames(
    minimal_project, monkeypatch
) -> None:
    import sqlite3

    from podcast_mcp.gui.server import apply_ws_viewer_state

    svc = SessionSyncService(load_project(minimal_project))

    def value_error(project, snapshot, *, heartbeat=True):
        raise ValueError("boom")

    monkeypatch.setattr("podcast_mcp.gui.routes.session.publish_viewer_snapshot", value_error)
    out = apply_ws_viewer_state(
        svc, {"selection": None}, client_id="ws-vs", role="viewer", label="Host"
    )
    assert out == {"type": "Error", "code": "invalid_viewer_state", "detail": "boom"}

    def db_error(project, snapshot, *, heartbeat=True):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr("podcast_mcp.gui.routes.session.publish_viewer_snapshot", db_error)
    out = apply_ws_viewer_state(svc, {}, client_id="ws-vs", role="viewer", label="Host")
    assert out["code"] == "viewer_state_failed"


def test_apply_ws_client_message_ignores_viewer_state(minimal_project) -> None:
    from podcast_mcp.gui.server import apply_ws_client_message

    svc = SessionSyncService(load_project(minimal_project))
    echo, seq = apply_ws_client_message(
        svc,
        {"type": "ViewerState", "snapshot": {"selection": {"kind": "track", "track_id": "host"}}},
        client_id="guest-abcd-tab",
        role="viewer",
        label="A",
        seq=3,
    )
    assert (echo, seq) == (None, 3)
    assert svc.state_or_none() is None


def test_apply_ws_viewer_state_forces_socket_identity(minimal_project, monkeypatch) -> None:
    from podcast_mcp.gui.server import apply_ws_viewer_state

    svc = SessionSyncService(load_project(minimal_project))
    seen: list[tuple[dict, bool]] = []

    def capture(project, snapshot, *, heartbeat=True):
        seen.append((snapshot, heartbeat))
        return {"server_seq": 0}

    monkeypatch.setattr("podcast_mcp.gui.routes.session.publish_viewer_snapshot", capture)
    blob = {"client_id": "spoofed", "label": "Host (admin)", "playhead_sec": 1.0}
    apply_ws_viewer_state(svc, blob, client_id="ws-nolabel", role="viewer", label=None)
    apply_ws_viewer_state(svc, blob, client_id="ws-host", role="viewer", label="Host")
    assert seen[0] == ({"client_id": "ws-nolabel", "playhead_sec": 1.0}, False)
    assert seen[1] == ({"client_id": "ws-host", "label": "Host", "playhead_sec": 1.0}, False)


def test_websocket_viewer_state_publishes_off_the_event_loop(minimal_project, monkeypatch) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    import asyncio
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.routes import session as session_routes
    from podcast_mcp.gui.server import create_app

    on_loop: list[bool] = []
    real = session_routes.publish_viewer_snapshot

    def spy(project, snapshot, *, heartbeat=True):
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        return real(project, snapshot, heartbeat=heartbeat)

    monkeypatch.setattr(session_routes, "publish_viewer_snapshot", spy)
    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-thread&role=viewer"
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json(
            {
                "type": "ViewerState",
                "snapshot": {"selection": {"kind": "track", "track_id": "host"}},
            }
        )
        for _ in range(8):
            frame = ws.receive_json()
            if frame.get("type") == "Echo":
                break
        else:
            raise AssertionError("expected a ViewerState Echo")
    assert on_loop == [False]


def test_publish_viewer_snapshot_from_many_threads_converges(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlaying", {"is_playing": False})

    def publish(i: int) -> dict:
        track = "host" if i % 2 else "guest"
        return publish_viewer_snapshot(
            proj,
            {"client_id": f"viewer-{i}", "selection": {"kind": "track", "track_id": track}},
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(publish, range(8)))
    snap = svc.snapshot()
    assert snap["server_seq"] >= max(int(r["server_seq"]) for r in results)
    assert snap["selection"]["track_id"] in {"host", "guest"}


def test_viewer_snapshot_heartbeat_can_be_skipped(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlaying", {"is_playing": True})
    blob = {"is_playing": True, "playhead_sec": 2.0}
    publish_viewer_snapshot(proj, {**blob, "client_id": "viewer-ws"}, heartbeat=False)
    ids = {c["client_id"] for c in svc.snapshot()["clients"]}
    assert "viewer-ws" not in ids
    publish_viewer_snapshot(proj, {**blob, "client_id": "viewer-http"})
    http = next(c for c in svc.snapshot()["clients"] if c["client_id"] == "viewer-http")
    assert http["playhead_sec"] == 2.0


def test_post_session_command_http(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.post(
        "/api/session/command",
        params={"path": str(minimal_project)},
        json={
            "type": "PresenceHeartbeat",
            "payload": {"label": "remote", "playhead_sec": 2.0},
            "client_id": "remote-1",
            "role": "viewer",
            "client_seq": 1,
        },
    )
    assert res.status_code == 200
    assert any(c["client_id"] == "remote-1" for c in res.json()["clients"])
    bad = client.post(
        "/api/session/command",
        params={"path": str(minimal_project)},
        json={
            "type": "SetPlayhead",
            "payload": {},
            "client_id": "x",
            "role": "viewer",
            "client_seq": 2,
        },
    )
    # Missing playhead_sec → KeyError → 400
    assert bad.status_code == 400


def test_http_command_without_id_retries_and_rejects_changed_payload(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = "/api/session/command"
    params = {"path": str(minimal_project)}
    command = {
        "type": "SetPlayhead",
        "payload": {"playhead_sec": 4.0},
        "client_id": "http-retry",
        "role": "viewer",
        "client_seq": 1,
    }
    first = client.post(url, params=params, json=command)
    retry = client.post(url, params=params, json=command)
    assert first.status_code == retry.status_code == 200
    assert retry.json()["idempotent"] is True
    assert retry.json()["server_seq"] == first.json()["server_seq"]
    assert retry.json()["command"]["command_id"] == first.json()["command"]["command_id"]

    changed = client.post(url, params=params, json={**command, "payload": {"playhead_sec": 8.0}})
    assert changed.status_code == 400
    assert "different command_id" in changed.json()["detail"]


def test_websocket_command_collision_keeps_connection_open(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-retry&role=viewer"

    def receive_type(ws, kind: str) -> dict:
        for _ in range(4):
            frame = ws.receive_json()
            if frame["type"] == kind:
                return frame
        raise AssertionError(f"no {kind} frame")

    command = {
        "type": "Command",
        "command_type": "SetPlayhead",
        "payload": {"playhead_sec": 4.0},
        "client_seq": 1,
    }
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json(command)
        first = receive_type(ws, "Echo")
        ws.send_json(command)
        retry = receive_type(ws, "Echo")
        assert retry["idempotent"] is True
        assert retry["server_seq"] == first["server_seq"]

        ws.send_json({**command, "payload": {"playhead_sec": 8.0}})
        conflict = receive_type(ws, "Error")
        assert conflict["code"] == "client_seq_conflict"
        ws.send_json({**command, "client_seq": 2, "payload": {"playhead_sec": 8.0}})
        recovered = receive_type(ws, "Echo")
        assert recovered["snapshot"]["playhead_sec"] == 8.0


def test_websocket_viewer_state_fans_out_and_echoes(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = (
        f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-vs&role=viewer&label=Host"
    )
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json(
            {
                "type": "ViewerState",
                "snapshot": {"selection": {"kind": "track", "track_id": "host"}},
            }
        )
        seen_echo = False
        seen_applied = False
        for _ in range(8):
            if seen_echo and seen_applied:
                break
            frame = ws.receive_json()
            if (
                frame.get("type") == "Echo"
                and frame.get("command", {}).get("type") == "ViewerState"
            ):
                seen_echo = True
            if (
                frame.get("type") == "Applied"
                and frame.get("command", {}).get("type") == "SetSelection"
                and frame.get("command", {}).get("client_id") == "ws-vs"
            ):
                seen_applied = True
        assert seen_echo, "expected a ViewerState Echo"
        assert seen_applied, "expected a fanned-out SetSelection Applied"

        ws.send_json({"type": "ViewerState", "snapshot": 3})
        for _ in range(8):
            frame = ws.receive_json()
            if frame.get("type") == "Error":
                assert frame["code"] == "invalid_viewer_state"
                break
        else:
            raise AssertionError("expected invalid_viewer_state Error")

        ws.send_json(
            {
                "type": "ViewerState",
                "snapshot": {"selection": {"kind": "track", "track_id": "guest"}},
            }
        )
        for _ in range(8):
            frame = ws.receive_json()
            if frame.get("type") == "Echo":
                break
        else:
            raise AssertionError("socket closed instead of echoing after recovery")


def test_websocket_viewer_state_service_error_keeps_connection_open(
    minimal_project, monkeypatch
) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    def value_error(project, snapshot, *, heartbeat=True):
        raise ValueError("boom")

    monkeypatch.setattr("podcast_mcp.gui.routes.session.publish_viewer_snapshot", value_error)

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-boom&role=viewer"

    def receive_type(ws, kind: str) -> dict:
        for _ in range(8):
            frame = ws.receive_json()
            if frame["type"] == kind:
                return frame
        raise AssertionError(f"no {kind} frame")

    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json(
            {
                "type": "ViewerState",
                "snapshot": {"selection": {"kind": "track", "track_id": "host"}},
            }
        )
        err = receive_type(ws, "Error")
        assert err["code"] == "invalid_viewer_state"

        ws.send_json({"type": "Presence", "client_seq": 2, "playhead_sec": 1.0})
        ws.send_json(
            {
                "type": "Command",
                "command_type": "SetPlayhead",
                "payload": {"playhead_sec": 4.0},
                "client_seq": 1,
            }
        )
        echo = receive_type(ws, "Echo")
        assert echo["snapshot"]["playhead_sec"] == 4.0


def test_normalize_presence_playhead_matches_transport_rule() -> None:
    from podcast_mcp.services.session_sync.commands import (
        normalize_presence_meta,
        normalize_presence_playhead,
    )

    for value in (0, 2.5, -1, float("nan"), float("inf"), "x", "12.5", None, True):
        transport = {"playing": False, "playhead_sec": value, "rate": 1}
        valid_meta = normalize_presence_meta({"transport": transport}) is not None
        got = normalize_presence_playhead(value)
        if value is None:
            assert got is None
        else:
            assert (got is not None) == valid_meta, value
    assert normalize_presence_playhead(3) == 3.0
    assert normalize_presence_playhead("12.5") is None
    assert normalize_presence_playhead(True) is None


def test_presence_time_fields_share_presence_sec_rule() -> None:
    from podcast_mcp.services.session_sync.commands import (
        normalize_presence_meta,
        normalize_presence_playhead,
    )

    for value in (0, 2.5, -1, float("nan"), float("inf"), "1.5", True):
        expected = normalize_presence_playhead(value) is not None
        metas = (
            {"cursor": {"t_sec": value}},
            {"viewport": {"start_sec": value, "end_sec": 30.0}},
            {"viewport": {"start_sec": 0.0, "end_sec": value if value != 0 else 30.0}},
            {"selection": {"kind": "marker", "time": value}},
        )
        for meta in metas:
            assert (normalize_presence_meta(meta) is not None) == expected, (meta, value)


def test_set_playhead_drops_invalid_playhead(minimal_project) -> None:
    svc = SessionSyncService(load_project(minimal_project))

    def row(cid: str) -> float | None:
        return next(c["playhead_sec"] for c in svc.snapshot()["clients"] if c["client_id"] == cid)

    svc.submit_control("SetPlayhead", {"playhead_sec": 3.0}, client_id="agent-x")
    for bad in (-1.0, float("nan"), float("inf"), "4"):
        result = svc.submit_control("SetPlayhead", {"playhead_sec": bad}, client_id="agent-x")
        assert result["snapshot"]["playhead_sec"] == 3.0
        assert row("agent-x") == 3.0
    for bad in (-1.0, float("nan"), float("inf"), "4"):
        result = svc.submit_control(
            "SetRegion",
            {"start_sec": 1.0, "end_sec": 2.0, "playhead_sec": bad},
            client_id="agent-r",
        )
        assert result["snapshot"]["playhead_sec"] == 3.0
        assert result["snapshot"]["region"] == {"start_sec": 1.0, "end_sec": 2.0}
        assert row("agent-r") == 3.0


def test_presence_and_ack_drop_invalid_playhead(minimal_project) -> None:
    svc = SessionSyncService(load_project(minimal_project))

    def send(ctype: Literal["Ack", "PresenceHeartbeat"], cid: str, value: object) -> None:
        payload: dict[str, object] = {"playhead_sec": value}
        if ctype == "Ack":
            payload["acked_server_seq"] = 0
        svc.submit(
            SyncCommand(
                type=ctype,
                payload=payload,
                client_id=cid,
                role="viewer",
                client_seq=next_client_seq(),
            )
        )

    def playhead(cid: str) -> float | None:
        return next(c["playhead_sec"] for c in svc.snapshot()["clients"] if c["client_id"] == cid)

    for ctype in ("Ack", "PresenceHeartbeat"):
        cid = f"c-{ctype}"
        send(ctype, cid, 2.0)
        assert playhead(cid) == 2.0
        for bad in (-1.0, float("nan"), float("inf")):
            send(ctype, cid, bad)
            assert playhead(cid) == 2.0
        fresh = f"fresh-{ctype}"
        send(ctype, fresh, -4.0)
        assert playhead(fresh) is None


def test_owner_ws_presence_drops_invalid_playhead(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-ph&role=viewer"
    with client.websocket_connect(url) as ws:
        ws.receive_json()
        ws.send_json({"type": "Presence", "client_seq": 1, "playhead_sec": 3.0})
        ws.send_text('{"type":"Presence","client_seq":2,"playhead_sec":NaN}')
        ws.send_text('{"type":"Presence","client_seq":3,"playhead_sec":Infinity}')
        ws.send_json({"type": "Ack", "client_seq": 4, "playhead_sec": -2.0})
        ws.send_json(
            {
                "type": "Presence",
                "client_seq": 5,
                "playhead_sec": -1.0,
                "meta": {"cursor": {"t_sec": 7.25}},
            }
        )
        mine = None
        for _ in range(50):
            with client.websocket_connect(url.replace("ws-ph", "observer")) as obs:
                snap = obs.receive_json()["snapshot"]
            for c in snap.get("clients") or []:
                if c["client_id"] == "ws-ph" and (c.get("meta") or {}).get("cursor"):
                    mine = c
            if mine:
                break
            time.sleep(0.05)
        assert mine is not None, snap.get("clients")
        assert mine["playhead_sec"] == 3.0


def test_owner_ws_label_sanitized(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    raw = "Ana\x07   Bee" + "z" * 80
    url = (
        f"/api/session/ws?path={quote(str(minimal_project))}"
        f"&client_id=ws-label&role=viewer&label={quote(raw)}"
    )
    with client.websocket_connect(url) as ws:
        snap = ws.receive_json()["snapshot"]
    mine = next(c for c in snap["clients"] if c["client_id"] == "ws-label")
    assert mine["label"] == ("Ana Bee" + "z" * 80)[:40]


def test_list_clients_expires_stale_presence(minimal_project) -> None:
    from podcast_mcp.services.session_sync.log import SyncStore

    proj = load_project(minimal_project)
    store = SyncStore(sync_db_path(proj))
    store.touch_client("stale", role="viewer", label="Old")
    store.touch_client("fresh", role="viewer", label="New")
    # Age the stale client beyond the 30s default window.
    with store._lock:
        store._conn.execute(
            "UPDATE clients SET last_seen_ns = ? WHERE client_id = ?",
            (0, "stale"),
        )
        store._conn.commit()
    clients = store.list_clients(max_age_ns=30_000_000_000)
    ids = {c["client_id"] for c in clients}
    assert "fresh" in ids
    assert "stale" not in ids
    # Explicit short TTL still filters.
    assert store.list_clients(max_age_ns=1) == []


def test_store_commands_after_and_close(minimal_project) -> None:
    from podcast_mcp.services.session_sync.log import SyncStore

    proj = load_project(minimal_project)
    path = sync_db_path(proj)
    store = SyncStore(path)
    row = store.append_command(
        command_id="a1",
        client_id="c",
        client_seq=1,
        role="agent",
        type="SetPlayhead",
        payload={"playhead_sec": 1.0},
        causation_id=None,
    )
    again = store.append_command(
        command_id="a1",
        client_id="c",
        client_seq=1,
        role="agent",
        type="SetPlayhead",
        payload={"playhead_sec": 1.0},
        causation_id=None,
    )
    assert again["server_seq"] == row["server_seq"]
    assert len(store.commands_after(0)) == 1
    assert store.commands_after(row["server_seq"]) == []
    store.close()


def test_authz_rejects_bad_role_and_empty_id() -> None:
    from podcast_mcp.services.session_sync.authz import authorize_client

    assert not authorize_client(client_id="", role="viewer").allowed
    assert not authorize_client(client_id="x", role="admin").allowed


def test_snapshot_apply_edge_commands(minimal_project) -> None:
    from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot

    snap = empty_snapshot()
    apply_command(
        snap,
        {
            "type": "Ack",
            "payload": {},
            "server_seq": 1,
            "client_id": "c",
            "role": "viewer",
            "command_id": "ack1",
            "ts_ns": 1,
        },
    )
    apply_command(
        snap,
        {
            "type": "SetMode",
            "payload": {"audition_mode": "raw"},
            "server_seq": 2,
            "client_id": "c",
            "role": "viewer",
            "command_id": "m1",
            "ts_ns": 2,
        },
    )
    assert snap["source"] == "track"
    apply_command(
        snap,
        {
            "type": "ClearRegion",
            "payload": {"stop": True},
            "server_seq": 3,
            "client_id": "c",
            "role": "viewer",
            "command_id": "clr",
            "ts_ns": 3,
        },
    )
    assert snap["region"] is None
    assert snap["is_playing"] is False
    apply_command(
        snap,
        {
            "type": "UnknownFuture",
            "payload": {},
            "server_seq": 4,
            "client_id": "c",
            "role": "cli",
            "command_id": "u",
            "ts_ns": 4,
        },
    )
    assert snap["origin"] == "agent"  # cli maps to agent alias


@pytest.mark.parametrize(
    ("ctype", "payload", "field", "expected"),
    [
        ("SetPlaying", {"is_playing": True}, "is_playing", True),
        ("SetSelection", {"selection": {"track_id": "host"}}, "selection", {"track_id": "host"}),
        ("SetMuteSolo", {"viewer_mute": {"host": True}}, "viewer_mute", {"host": True}),
        ("PlayOsAudio", {"timeline_start_sec": 1, "timeline_end_sec": 2}, "dry_run", False),
        ("AuditionInViewer", {"timeline_start_sec": 1, "timeline_end_sec": 2}, "dry_run", True),
    ],
)
def test_snapshot_handler_registry_keeps_field_metadata(ctype, payload, field, expected) -> None:
    from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot

    snap = apply_command(
        empty_snapshot(),
        {
            "type": ctype,
            "payload": payload,
            "server_seq": 7,
            "client_id": "viewer-1",
            "role": "viewer",
            "command_id": "cmd-7",
            "ts_ns": 99,
        },
    )
    assert snap[field] == expected
    assert snap["fields"][field] == {
        "value": expected,
        "server_seq": 7,
        "client_id": "viewer-1",
    }
    assert snap["last_command_id"] == "cmd-7"


@pytest.mark.parametrize(
    ("ctype", "playing", "dry_run"),
    [("PlayOsAudio", False, False), ("AuditionInViewer", True, True)],
)
def test_playback_materializer_exact_fields_and_order(ctype, playing, dry_run) -> None:
    from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot

    payload = {
        "timeline_start_sec": 1.25,
        "timeline_end_sec": 2.5,
        "source": "track:host",
        "track_id": "host",
        "query": "hello",
        "match_index": 2,
        "tier": "raw",
        "selection": {"track_id": "host"},
    }
    snap = apply_command(
        empty_snapshot(),
        {
            "type": ctype,
            "payload": payload,
            "server_seq": 7,
            "client_id": "viewer-1",
            "role": "viewer",
            "command_id": "cmd-7",
            "ts_ns": 99,
        },
    )
    expected = {
        "playhead_sec": 1.25,
        "is_playing": playing,
        "region": {"start_sec": 1.25, "end_sec": 2.5},
        "source": "track:host",
        "audition_mode": "raw",
        "track_id": "host",
        "solo_tracks": {"host": True},
        "viewer_mute": {},
        "query": "hello",
        "match_index": 2,
        "tier": "raw",
        "dry_run": dry_run,
        "wav": None,
        "compare_segments": None,
        "selection": {"track_id": "host"},
    }
    assert list(snap["fields"]) == list(expected)
    assert {key: row["value"] for key, row in snap["fields"].items()} == expected
    assert all(
        row["server_seq"] == 7 and row["client_id"] == "viewer-1" for row in snap["fields"].values()
    )


def test_hub_fanout_delivers_applied(minimal_project) -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import get_hub

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    key = str(proj.workspace_path())
    loop = asyncio.new_event_loop()
    queue = get_hub().subscribe(key, loop)
    try:
        svc.submit_control("SetPlayhead", {"playhead_sec": 9.0}, client_id="agent-b")
        # Drain call_soon_threadsafe onto this loop
        loop.call_soon(lambda: None)
        loop.run_until_complete(asyncio.sleep(0))
        event = queue.get_nowait()
        assert event["type"] == "Applied"
        assert event["snapshot"]["playhead_sec"] == 9.0
    finally:
        get_hub().unsubscribe(key, queue)
        loop.close()


def test_websocket_snapshot_on_connect(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    proj = load_project(minimal_project)
    SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 3.0})
    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-a&role=viewer&label=A"
    with client.websocket_connect(url) as ws:
        first = ws.receive_json()
        assert first["type"] == "Snapshot"
        assert first["snapshot"]["playhead_sec"] == 3.0
        ws.send_json(
            {
                "type": "Presence",
                "playhead_sec": 3.0,
                "client_seq": 2,
                "meta": {
                    "cursor": {"t_sec": 3.0, "track_id": "host"},
                    "display_name": "A",
                },
            }
        )


def test_normalize_presence_meta_accepts_and_clears() -> None:
    from podcast_mcp.services.session_sync.commands import (
        normalize_presence_meta,
        presence_color_index,
        sanitize_display_name,
    )

    assert normalize_presence_meta(None) is None
    assert normalize_presence_meta("nope") is None
    assert normalize_presence_meta({"cursor": {"t_sec": -1}}) is None
    accepted = normalize_presence_meta(
        {
            "cursor": {"t_sec": 1.2, "track_id": "host", "extra": "drop"},
            "unknown": True,
        }
    )
    assert accepted is not None
    assert accepted["cursor"]["t_sec"] == 1.2
    assert "extra" not in accepted["cursor"]
    cleared = normalize_presence_meta({"cursor": None})
    assert cleared is not None and "cursor" in cleared and cleared["cursor"] is None
    assert presence_color_index("a") == presence_color_index("a")
    assert 0 <= presence_color_index("a") <= 7
    assert sanitize_display_name("Host", guest=True) == "Host (guest)"
    assert sanitize_display_name("A\x00 B") == "A B"
    nan = normalize_presence_meta({"cursor": {"t_sec": float("nan")}})
    assert nan is None
    inf = normalize_presence_meta({"transport": {"playing": True, "playhead_sec": float("inf")}})
    assert inf is None
    extra_sel = normalize_presence_meta(
        {"selection": {"kind": "clip", "id": "c1", "track_id": "host", "evil": 1}}
    )
    assert extra_sel is not None
    assert "evil" not in extra_sel["selection"]
    # Near-sample zoom: a 50 ms window is valid; under 1 ms is not.
    narrow = normalize_presence_meta({"viewport": {"start_sec": 0, "end_sec": 0.05}})
    assert narrow is not None and narrow["viewport"]["end_sec"] == 0.05
    assert normalize_presence_meta({"viewport": {"start_sec": 0, "end_sec": 0.0005}}) is None
    view = normalize_presence_meta({"viewport": {"start_sec": 0, "end_sec": 12}})
    assert view is not None and view["viewport"]["end_sec"] == 12
    assert sanitize_display_name(12) == "12"
    assert sanitize_display_name("   ") is None


def test_normalize_presence_meta_anchor_and_ui() -> None:
    from podcast_mcp.services.session_sync.commands import normalize_presence_meta

    anchored = normalize_presence_meta(
        {"cursor": {"anchor": "track:host:mute", "x": 0.5, "y": 0.5}}
    )
    assert anchored is not None
    assert anchored["cursor"]["anchor"] == "track:host:mute"
    assert "t_sec" not in anchored["cursor"] or anchored["cursor"]["t_sec"] is None
    lane = normalize_presence_meta({"cursor": {"t_sec": 1.0, "lane_pos": 1.4}})
    assert lane is not None and lane["cursor"]["lane_pos"] == 1.4
    assert normalize_presence_meta({"cursor": {"x": 0.5}}) is None
    assert normalize_presence_meta({"cursor": {"anchor": "Bad Anchor!"}}) is None
    assert normalize_presence_meta({"cursor": {"anchor": "a" * 97}}) is None
    ui = normalize_presence_meta(
        {
            "ui": {
                "tab": "pipeline",
                "audition": "fx",
                "viewer_mute": ["host"],
                "solo": [],
                "junk": 1,
            }
        }
    )
    assert ui is not None
    assert ui["ui"]["tab"] == "pipeline"
    assert ui["ui"]["audition"] == "fx"
    assert ui["ui"]["viewer_mute"] == ["host"]
    assert "junk" not in ui["ui"]
    stripped = normalize_presence_meta({"ui": {"tab": "nope", "audition": "fx"}})
    assert stripped is not None
    assert stripped["ui"].get("tab") is None
    assert stripped["ui"]["audition"] == "fx"
    word = normalize_presence_meta(
        {"selection": {"kind": "transcriptWord", "track_id": "host", "word_index": 12}}
    )
    assert word is not None
    assert word["selection"]["word_index"] == 12
    env = normalize_presence_meta(
        {"selection": {"kind": "envelopePoint", "track_id": "host", "time": 5.0}}
    )
    assert env is not None
    assert env["selection"]["kind"] == "envelopePoint"
    assert env["selection"]["time"] == 5.0
    mix = normalize_presence_meta({"ui": {"tab": "mix"}, "cursor": {"t_sec": 1.2}})
    assert mix is not None
    assert mix["ui"].get("tab") is None
    assert mix["cursor"]["t_sec"] == 1.2
    tighten = normalize_presence_meta({"ui": {"tab": "tighten"}})
    assert tighten is not None
    assert tighten["ui"]["tab"] == "tighten"


def test_touch_client_merges_meta_and_followers(minimal_project) -> None:
    from podcast_mcp.services.session_sync.log import SyncStore

    proj = load_project(minimal_project)
    store = SyncStore(sync_db_path(proj))
    store.touch_client("host", role="viewer", label="Host")
    store.touch_client(
        "host",
        role="viewer",
        meta={"cursor": {"t_sec": 1.0, "track_id": "host"}, "color_index": 99},
    )
    store.touch_client(
        "guest",
        role="viewer",
        meta={"following": "host", "display_name": "G"},
    )
    clients = {c["client_id"]: c for c in store.list_clients()}
    assert clients["host"]["meta"]["cursor"]["t_sec"] == 1.0
    assert clients["host"]["meta"]["color_index"] != 99
    assert clients["host"]["followers"] == 1
    store.touch_client("host", role="viewer", meta={"cursor": None})
    host = next(c for c in store.list_clients() if c["client_id"] == "host")
    assert "cursor" not in (host["meta"] or {})
    store.touch_client("ghost", role="viewer", meta={"following": "missing"})
    ghost = next(c for c in store.list_clients() if c["client_id"] == "ghost")
    assert "following" not in (ghost["meta"] or {})
    store.touch_client("narc", role="viewer", meta={"following": "narc"})
    narc = next(c for c in store.list_clients() if c["client_id"] == "narc")
    assert "following" not in (narc["meta"] or {})
    store.touch_client("talk", role="viewer")
    with store._lock:
        store._conn.execute(
            "UPDATE clients SET meta = ? WHERE client_id = ?",
            ("not-json", "talk"),
        )
    store.touch_client("talk", role="viewer", meta={"cursor": {"t_sec": 2.0}})
    talk = next(c for c in store.list_clients() if c["client_id"] == "talk")
    assert (talk["meta"] or {}).get("cursor", {}).get("t_sec") == 2.0
    store.touch_client("arr", role="viewer")
    with store._lock:
        store._conn.execute(
            "UPDATE clients SET meta = ? WHERE client_id = ?",
            ("[]", "arr"),
        )
    store.touch_client("arr", role="viewer", meta={"cursor": {"t_sec": 3.0}})
    listed = {c["client_id"]: c for c in store.list_clients()}
    assert listed["arr"]["meta"]["cursor"]["t_sec"] == 3.0
    store.touch_client(
        "notdict",
        role="viewer",
        meta={"transport": "nope"},
    )
    store.touch_client("lis", role="viewer")
    with store._lock:
        store._conn.execute(
            "UPDATE clients SET meta = ? WHERE client_id = ?",
            ("1", "lis"),
        )
    assert next(c for c in store.list_clients() if c["client_id"] == "lis")["meta"] is None
    store.remove_client("guest")
    ids = {c["client_id"] for c in store.list_clients()}
    assert "guest" not in ids
    store.touch_client("stale-prune", role="viewer")
    with store._lock:
        store._conn.execute(
            "UPDATE clients SET last_seen_ns = ? WHERE client_id = ?",
            (1, "stale-prune"),
        )
    store.touch_client("fresh-2", role="viewer")
    ids = {c["client_id"] for c in store.list_clients(max_age_ns=10**18)}
    assert "stale-prune" not in ids


def test_agent_durable_command_sets_display_name(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlayhead", {"playhead_sec": 8.0}, client_id="agent-x")
    agent = next(c for c in svc.snapshot()["clients"] if c["client_id"] == "agent-x")
    assert agent["meta"]["display_name"] == "Agent"


def test_ws_disconnect_removes_client(minimal_project) -> None:
    pytest = __import__("pytest")
    pytest.importorskip("fastapi")
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    proj = load_project(minimal_project)
    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=ws-leave&role=viewer"
    with client.websocket_connect(url) as ws:
        ws.receive_json()
        ids = {c["client_id"] for c in SessionSyncService(proj).snapshot()["clients"]}
        assert "ws-leave" in ids
    ids = {c["client_id"] for c in SessionSyncService(proj).snapshot()["clients"]}
    assert "ws-leave" not in ids


def test_document_overflow_resync_keeps_incoming_seq() -> None:
    from podcast_mcp.services.session_sync.hub import document_overflow_resync

    out = document_overflow_resync(
        {
            "type": "Applied",
            "plane": "document",
            "snapshot": {"patch": {"clips": {"stale": True}}, "server_seq": 9},
        }
    )
    assert out["snapshot"]["resync"] is True
    assert out["snapshot"]["server_seq"] == 9


def test_document_hub_overflow_drains_and_tags_resync() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-doc-full"
    q = hub.subscribe(key, loop)
    hub.publish(
        key,
        {
            "type": "Applied",
            "plane": "document",
            "snapshot": {"patch": {"clips": {"stale": True}}, "server_seq": 1},
        },
    )
    loop.run_until_complete(asyncio.sleep(0))
    for i in range(255):
        hub.publish(
            key,
            {
                "type": "Applied",
                "plane": "document",
                "snapshot": {"patch": {"fx": i}, "server_seq": i + 2},
            },
        )
        loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    hub.publish(
        key,
        {
            "type": "Applied",
            "plane": "document",
            "snapshot": {"patch": {"envelopes": 1}, "server_seq": 300},
        },
    )
    loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 1
    got = q.get_nowait()
    assert got["snapshot"]["resync"] is True
    assert got["snapshot"]["server_seq"] == 300
    assert got["snapshot"].get("patch") == {"envelopes": 1}
    hub.unsubscribe(key, q)
    loop.close()


def test_hub_overflow_drops_signal_not_record_applied() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.hub import SessionHub

    hub = SessionHub()
    loop = asyncio.new_event_loop()
    key = "k-signal-full"
    q = hub.subscribe(key, loop)
    for i in range(200):
        hub.publish(key, {"plane": "record", "type": "Applied", "n": i})
        loop.run_until_complete(asyncio.sleep(0))
    for i in range(56):
        hub.publish(key, {"plane": "record", "type": "Signal", "n": i})
        loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    hub.publish(key, {"plane": "record", "type": "Signal", "n": 99})
    loop.run_until_complete(asyncio.sleep(0))
    assert q.qsize() == 256
    kinds = []
    while q.qsize():
        kinds.append(q.get_nowait()["type"])
    assert kinds.count("Applied") == 200
    assert kinds.count("Signal") == 56
    hub.unsubscribe(key, q)
    loop.close()


def test_publish_agent_play_bumps_revision(minimal_project) -> None:
    proj = load_project(minimal_project)
    s1 = publish_agent_play(
        proj,
        timeline_start_sec=10.0,
        timeline_end_sec=20.0,
        source="premix",
        tier="premix",
        dry_run=True,
        query="party",
    )
    assert s1["server_seq"] == 1
    assert s1["origin"] == "agent"
    assert s1["last_command_id"]
    assert s1["region"] == {"start_sec": 10.0, "end_sec": 20.0}
    assert s1["query"] == "party"
    assert s1["audition_mode"] == "mix"
    # dry_run: DAW browser should play (no OS audio)
    assert s1["is_playing"] is True

    s2 = publish_agent_play(
        proj,
        timeline_start_sec=30.0,
        timeline_end_sec=40.0,
        source="processed:host",
        tier="stem",
        dry_run=False,
    )
    assert s2["server_seq"] == 2
    assert s2["last_command_id"] != s1["last_command_id"]
    assert s2["audition_mode"] == "fx"
    assert s2["track_id"] == "host"
    assert s2["solo_tracks"] == {"host": True}
    # Real OS play: seek/highlight only - do not double with browser audio
    assert s2["is_playing"] is False


def test_viewer_snapshot_merge(minimal_project) -> None:
    proj = load_project(minimal_project)
    agent = publish_agent_play(
        proj,
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    assert agent["region"] == {"start_sec": 1.0, "end_sec": 2.0}
    # While playing, viewer playhead is presence-only (no SetPlayhead journal).
    out = publish_viewer_snapshot(
        proj,
        {
            "playhead_sec": 1.5,
            "client_id": "viewer-test",
            "ack_command_id": agent["last_command_id"],
        },
    )
    assert out["region"] == {"start_sec": 1.0, "end_sec": 2.0}
    clients = {c["client_id"]: c for c in (out.get("clients") or [])}
    assert clients["viewer-test"]["playhead_sec"] == 1.5
    # Durable playhead stays at agent region start until paused scrub.
    assert out["playhead_sec"] == 1.0


def test_viewer_heartbeat_reuses_command_snapshot(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.session_sync import presence_fanout

    presence_fanout.reset()
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlaying", {"is_playing": True})
    store = svc.store
    original_snapshot = SessionSyncService.snapshot
    reads = 0
    request_thread = get_ident()

    def counted_snapshot(self: SessionSyncService):
        nonlocal reads
        if get_ident() == request_thread:
            reads += 1
        return original_snapshot(self)

    monkeypatch.setattr(SessionSyncService, "snapshot", counted_snapshot)
    try:
        for n in range(16):
            out = publish_viewer_snapshot(
                proj,
                {"client_id": f"viewer-{n % 8}", "is_playing": True, "playhead_sec": float(n)},
            )
            assert out["clients"]
            assert out["is_playing"] is True
        # One authority read for comparison and one from PresenceHeartbeat;
        # coalesced fanout reads may occur on another thread.
        assert reads == 32
        assert SessionSyncService(proj).store is store
    finally:
        presence_fanout.reset()


def test_viewer_heartbeat_does_not_undo_concurrent_agent_seek(minimal_project, monkeypatch) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    original_snapshot = SessionSyncService.snapshot
    injected = False

    def seek_after_baseline(self: SessionSyncService):
        nonlocal injected
        baseline = original_snapshot(self)
        if not injected:
            injected = True
            svc.submit_control("SetPlayhead", {"playhead_sec": 5.0})
        return baseline

    monkeypatch.setattr(SessionSyncService, "snapshot", seek_after_baseline)
    out = publish_viewer_snapshot(proj, {"client_id": "viewer", "playhead_sec": 0.0})
    assert injected
    assert out["playhead_sec"] == 5.0
    assert original_snapshot(svc)["playhead_sec"] == 5.0


def test_viewer_snapshot_skips_invalid_paused_playhead(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlayhead", {"playhead_sec": 3.0})
    seq = svc.snapshot()["server_seq"]
    for bad in (-1.0, float("nan"), float("inf"), True):
        out = publish_viewer_snapshot(proj, {"client_id": "viewer-bad", "playhead_sec": bad})
        assert out["playhead_sec"] == 3.0
    assert SessionSyncService(proj).snapshot()["server_seq"] == seq
    out = publish_viewer_snapshot(proj, {"client_id": "viewer-bad", "playhead_sec": 4.0})
    assert out["playhead_sec"] == 4.0
    assert SessionSyncService(proj).snapshot()["server_seq"] == seq + 1


def test_session_meta_missing_and_present(minimal_project) -> None:
    meta = SessionSyncService.open(minimal_project).meta()
    assert meta["exists"] is False
    proj = load_project(minimal_project)
    publish_agent_play(
        proj,
        timeline_start_sec=0.0,
        timeline_end_sec=1.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    meta2 = SessionSyncService.open(minimal_project).meta()
    assert meta2["exists"] is True
    assert meta2["mtime_ns"] > 0


def test_sync_db_path_for_workspace_matches_project(minimal_project) -> None:
    proj = load_project(minimal_project)
    assert sync_db_path_for_workspace(proj.workspace_path()) == sync_db_path(proj)


def test_session_meta_does_not_parse_the_project(minimal_project, monkeypatch) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    r = svc.submit_control("SetPlayhead", {"playhead_sec": 1.0})

    from podcast_mcp.project_store import ProjectStore

    def _boom(self):
        raise AssertionError("session_meta must not parse the project")

    monkeypatch.setattr(ProjectStore, "load", _boom)

    meta = session_meta(minimal_project)
    assert meta["exists"] is True
    assert meta["server_seq"] == r["server_seq"]

    meta_from_dir = session_meta(minimal_project.parent)
    assert meta_from_dir["server_seq"] == r["server_seq"]


def test_session_meta_does_not_create_sync_db(minimal_project) -> None:
    proj = load_project(minimal_project)
    db_path = sync_db_path(proj)
    assert not db_path.exists()
    meta = session_meta(minimal_project)
    assert meta == {
        "path": str(db_path.resolve()),
        "mtime_ns": 0,
        "size": 0,
        "exists": False,
        "server_seq": 0,
    }
    assert not db_path.exists()


def test_session_meta_changes_on_every_durable_commit(minimal_project, monkeypatch) -> None:
    import itertools

    from podcast_mcp.services.session_sync import log as session_sync_log
    from podcast_mcp.services.session_sync.service import _snapshot_size

    ticker = itertools.count(10**18, 1000)
    monkeypatch.setattr(session_sync_log.time, "time_ns", lambda: next(ticker))

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    r1 = svc.submit_control("SetPlayhead", {"playhead_sec": 1.0})
    meta1 = session_meta(minimal_project)
    r2 = svc.submit_control("SetPlayhead", {"playhead_sec": 2.0})
    meta2 = session_meta(minimal_project)

    assert meta2["mtime_ns"] != meta1["mtime_ns"]
    assert meta2["server_seq"] == meta1["server_seq"] + 1
    assert meta2["server_seq"] == r2["server_seq"]
    assert meta1["server_seq"] == r1["server_seq"]
    assert meta2["mtime_ns"] == svc.store.get_snapshot()["updated_at_ns"]
    assert meta2["size"] == _snapshot_size(svc.store.get_snapshot())
    assert meta1["size"] > 0


def test_session_meta_ignores_presence_writes(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_control("SetPlayhead", {"playhead_sec": 1.0})
    before = session_meta(minimal_project)

    svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "DAW", "playhead_sec": 1.0},
            client_id="viewer-new",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    seq = before["server_seq"]
    svc.submit(
        SyncCommand(
            type="Ack",
            payload={"acked_server_seq": seq, "label": "DAW"},
            client_id="viewer-new",
            role="viewer",
            client_seq=next_client_seq(),
        )
    )
    svc.store._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    after = session_meta(minimal_project)
    assert after["mtime_ns"] == before["mtime_ns"]
    assert after["server_seq"] == before["server_seq"]
    assert after["size"] == before["size"]


def test_cached_sync_store_if_exists_never_creates(tmp_path) -> None:
    path = tmp_path / "nested" / "sync.db"
    assert session_sync_log.cached_sync_store_if_exists(path) is None
    assert not path.parent.exists()


def test_cached_sync_store_if_exists_prefers_the_cached_store(tmp_path, monkeypatch) -> None:
    path = tmp_path / "sync.db"
    store = session_sync_log.cached_sync_store(path)
    try:
        assert session_sync_log.cached_sync_store_if_exists(path) is store
        monkeypatch.setattr(type(path), "is_file", lambda self: False)
        assert session_sync_log.cached_sync_store_if_exists(path) is store
        with pytest.raises(ValueError):
            session_sync_log.cached_sync_store_if_exists(path, enforce_command_ids=True)
    finally:
        monkeypatch.undo()
        session_sync_log._STORE_CACHE.pop(session_sync_log.sync_store_cache_key(path), None)
        store.close()


@pytest.mark.parametrize("exc", [OSError("nope"), sqlite3.DatabaseError("malformed")])
def test_session_meta_read_errors_report_missing(minimal_project, monkeypatch, exc) -> None:
    from podcast_mcp.services.session_sync import service as session_service

    proj = load_project(minimal_project)
    SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 1.0})

    def _boom(*_a, **_k):
        raise exc

    monkeypatch.setattr(session_service, "_existing_store_at", _boom)
    meta = session_meta(minimal_project)
    assert meta["exists"] is False
    assert meta["mtime_ns"] == 0 and meta["size"] == 0 and meta["server_seq"] == 0


@pytest.mark.parametrize(
    "exc",
    [
        OSError(errno.ELOOP, "Too many levels of symbolic links"),
        RuntimeError("Symlink loop from '/loop'"),
    ],
)
def test_session_meta_path_resolution_error_reports_missing(monkeypatch, exc) -> None:
    from podcast_mcp.services.session_sync import service as session_service

    def _boom(_path):
        raise exc

    monkeypatch.setattr(session_service, "resolve_project_path", _boom)
    meta = session_meta("/loop/episode.project.json")
    assert meta["exists"] is False and meta["server_seq"] == 0


def test_session_meta_never_raises_on_a_real_symlink_loop(tmp_path) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    a.symlink_to(b)
    b.symlink_to(a)
    meta = session_meta(a / "episode.project.json")
    assert meta["exists"] is False and meta["server_seq"] == 0


def _loop_artifacts(workspace) -> None:
    (workspace / "artifacts").symlink_to(workspace / "artifacts2")
    (workspace / "artifacts2").symlink_to(workspace / "artifacts")


def test_meta_reads_never_raise_on_a_real_symlink_loop_under_artifacts(tmp_path) -> None:
    from podcast_mcp.services.document_sync.service import document_server_seq
    from podcast_mcp.services.session_sync.service import session_meta_at

    project = tmp_path / "episode.project.json"
    project.write_text("{}")
    _loop_artifacts(tmp_path)
    meta = session_meta(project)
    assert meta["exists"] is False and meta["server_seq"] == 0
    assert session_meta_at(tmp_path / "artifacts" / "session" / "sync.db")["exists"] is False
    # 3.11/3.12 raise on resolve (-> None); 3.13+ resolve non-strictly (-> no db, 0).
    assert document_server_seq(project) in (0, None)


def test_meta_reads_convert_a_db_path_symlink_loop_runtime_error(tmp_path, monkeypatch) -> None:
    """Deterministic on every Python: the pre-3.13 RuntimeError from resolving the db path."""
    from pathlib import Path

    from podcast_mcp.services.document_sync.service import document_server_seq

    real_resolve = Path.resolve

    def _resolve(self, strict=False):
        if "artifacts" in self.parts:
            raise RuntimeError(f"Symlink loop from {str(self)!r}")
        return real_resolve(self, strict=strict)

    monkeypatch.setattr(Path, "resolve", _resolve)
    project = tmp_path / "episode.project.json"
    meta = session_meta(project)
    assert meta["exists"] is False and meta["server_seq"] == 0
    assert document_server_seq(project) is None


def test_resolve_meta_path_converts_a_symlink_loop_runtime_error(monkeypatch, tmp_path) -> None:
    from pathlib import Path

    from podcast_mcp.services.session_sync.service import resolve_meta_path

    def _boom(self, strict=False):
        raise RuntimeError("Symlink loop from '/x'")

    monkeypatch.setattr(Path, "resolve", _boom)
    with pytest.raises(OSError) as info:
        resolve_meta_path(tmp_path / "sync.db")
    assert info.value.errno == errno.ELOOP


def test_best_effort_meta_returns_the_default_on_read_errors() -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _boom() -> int:
        raise sqlite3.OperationalError("database is locked")

    assert best_effort_meta(_boom, 7, what="x", path="/p") == 7
    assert best_effort_meta(lambda: 3, 7, what="x", path="/p") == 3


def test_best_effort_meta_does_not_swallow_other_errors() -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _boom() -> int:
        raise ValueError("bug")

    with pytest.raises(ValueError):
        best_effort_meta(_boom, 0, what="x", path="/p")


def test_best_effort_meta_warns_once_per_path_on_a_corrupt_store(caplog, tmp_path) -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _corrupt() -> int:
        raise sqlite3.DatabaseError("file is not a database")

    path = tmp_path / "sync.db"
    with caplog.at_level(logging.DEBUG, logger="podcast_mcp.services.session_sync.service"):
        for _ in range(3):
            assert best_effort_meta(_corrupt, 0, what="session meta", path=path) == 0
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "corrupt" in warnings[0].getMessage()


def test_best_effort_meta_warns_again_after_the_store_recovers(caplog, tmp_path) -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _corrupt() -> int:
        raise sqlite3.DatabaseError("file is not a database")

    path = tmp_path / "sync.db"
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.session_sync.service"):
        best_effort_meta(_corrupt, 0, what="session meta", path=path)
        best_effort_meta(_corrupt, 0, what="session meta", path=path)
        assert best_effort_meta(lambda: 5, 0, what="session meta", path=path) == 5
        best_effort_meta(_corrupt, 0, what="session meta", path=path)
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2


def test_best_effort_meta_keys_corrupt_warnings_on_the_resolved_path(caplog, tmp_path) -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _corrupt() -> int:
        raise sqlite3.DatabaseError("file is not a database")

    real = tmp_path / "sync.db"
    real.write_bytes(b"x")
    link = tmp_path / "link.db"
    link.symlink_to(real)
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.session_sync.service"):
        for spelling in (real, link, str(real)):
            best_effort_meta(_corrupt, 0, what="session meta", path=spelling)
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1


def test_best_effort_meta_keeps_transient_errors_at_debug(caplog, tmp_path) -> None:
    from podcast_mcp.services.session_sync.service import best_effort_meta

    def _locked() -> int:
        raise sqlite3.OperationalError("database is locked")

    with caplog.at_level(logging.DEBUG, logger="podcast_mcp.services.session_sync.service"):
        best_effort_meta(_locked, 0, what="session meta", path=tmp_path / "sync.db")
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_meta_reads_treat_a_corrupt_store_as_missing(minimal_project, caplog) -> None:
    from podcast_mcp.services.document_sync.service import document_server_seq

    session_dir = minimal_project.parent / "artifacts" / "session"
    session_dir.mkdir(parents=True, exist_ok=True)
    garbage = b"not a sqlite database\x00" * 512
    (session_dir / "sync.db").write_bytes(garbage)
    (session_dir / "document.db").write_bytes(garbage)
    cached_before = set(session_sync_log._STORE_CACHE)

    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.session_sync.service"):
        for _ in range(2):
            meta = session_meta(minimal_project)
            assert meta["exists"] is False
            assert meta["mtime_ns"] == 0 and meta["size"] == 0 and meta["server_seq"] == 0
            assert document_server_seq(minimal_project) is None

    assert set(session_sync_log._STORE_CACHE) == cached_before
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2  # one per store, not one per poll


def test_cached_sync_store_if_exists_does_not_recreate_a_vanished_file(
    tmp_path, monkeypatch
) -> None:
    path = tmp_path / "sync.db"
    # Simulate another process deleting the file after the is_file() check.
    monkeypatch.setattr(type(path), "is_file", lambda self: True)
    with pytest.raises(sqlite3.OperationalError):
        session_sync_log.cached_sync_store_if_exists(path)
    monkeypatch.undo()
    assert not path.exists()
    assert session_sync_log.sync_store_cache_key(path) not in session_sync_log._STORE_CACHE


def test_sync_store_closes_its_connection_when_schema_setup_fails(tmp_path, monkeypatch) -> None:
    opened = []
    real_connect = session_sync_log.connect_session_db

    def _record(path, **kwargs):
        conn = real_connect(path, **kwargs)
        opened.append(conn)
        return conn

    monkeypatch.setattr(session_sync_log, "connect_session_db", _record)
    monkeypatch.setattr(session_sync_log, "_schema", lambda _prefix: "NOT VALID SQL;")
    with pytest.raises(sqlite3.OperationalError):
        SyncStore(tmp_path / "sync.db")
    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError):
        opened[0].execute("SELECT 1")


def test_session_control_seek_stop_mode(minimal_project) -> None:
    import pytest

    from podcast_mcp.services.session_sync.commands import (
        SyncCommand,
        audition_mode_from_source,
    )

    assert audition_mode_from_source(None) == "mix"
    assert audition_mode_from_source("follow-transcript:processed:host") == "fx"

    ws = ProjectWorkspace.open(minimal_project)
    svc = SessionControlService(ws)
    sync = SessionSyncService(ws.project)
    assert svc.get_state() is None
    seeked = svc.seek(12.5, selection={"kind": "clip", "id": "c1"})
    assert seeked["playhead_sec"] == 12.5
    assert seeked["selection"]["id"] == "c1"
    for bad in (-1.0, float("nan"), float("inf")):
        with pytest.raises(ValueError, match="finite"):
            svc.seek(bad)
    state = svc.get_state()
    assert state is not None and state["playhead_sec"] == 12.5
    roster = svc.presence()
    assert any(c.get("role") == "agent" for c in roster)
    assert any(c.get("display_name") == "Agent" for c in roster)
    assert all("ui" in c for c in roster)
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "CLI", "meta": {"display_name": "CLI"}},
            client_id="cli-1",
            role="cli",
            client_seq=1,
        )
    )
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "G", "meta": {"display_name": "G"}},
            client_id="guest-xxxx-tab",
            role="viewer",
            client_seq=1,
        )
    )
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "Host", "meta": {"display_name": "Host"}},
            client_id="viewer-host",
            role="viewer",
            client_seq=1,
        )
    )
    ordered = [c["client_id"] for c in svc.presence()]
    assert ordered.index("viewer-host") < ordered.index("cli-1")
    assert ordered.index("cli-1") < ordered.index("guest-xxxx-tab")
    selected = svc.set_selection({"kind": "clip", "id": "c1"})
    assert selected["selection"]["id"] == "c1"
    assert seeked["origin"] == "agent"
    with pytest.raises(ValueError, match="playhead_sec"):
        svc.seek(-1.0)
    playing = svc.set_playing(True)
    assert playing["is_playing"] is True
    mode = svc.set_mode("fx")
    assert mode["audition_mode"] == "fx"
    with pytest.raises(ValueError, match="mode"):
        svc.set_mode("nope")
    region = svc.set_region(
        10.0,
        15.0,
        playing=True,
        query="x",
        selection={"kind": "clip", "id": "c1"},
    )
    assert region["is_playing"] is True
    assert region["query"] == "x"
    with pytest.raises(ValueError, match="end_sec"):
        svc.set_region(5.0, 5.0)
    for bad_start, bad_end in ((-5.0, 2.0), (float("nan"), 2.0), (1.0, float("inf"))):
        with pytest.raises(ValueError, match="finite"):
            svc.set_region(bad_start, bad_end)
    cleared = sync.submit_control("ClearRegion", {"stop": False})["snapshot"]
    assert cleared["region"] is None
    solo = sync.submit_control("SetMuteSolo", {"solo_tracks": {"host": True}})["snapshot"]
    assert solo["solo_tracks"] == {"host": True}
    mute = sync.submit_control("SetMuteSolo", {"viewer_mute": {"host": True}})["snapshot"]
    assert mute["viewer_mute"] == {"host": True}
    stopped = svc.stop()
    assert stopped["is_playing"] is False
    assert stopped["region"] is None
    opened = SessionControlService(ProjectWorkspace.open(minimal_project))
    assert opened.get_state() is not None


def test_track_id_and_mode_helpers(minimal_project) -> None:
    from podcast_mcp.services.session_sync.commands import (
        audition_mode_from_source,
        track_id_from_source,
    )

    assert track_id_from_source("") is None
    assert track_id_from_source("track:host") == "host"
    assert track_id_from_source("follow-transcript:processed:olga") == "olga"
    assert audition_mode_from_source("track:host") == "raw"

    proj = load_project(minimal_project)
    SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 1.0})
    viewer = publish_viewer_snapshot(
        proj, {"playhead_sec": 2.0, "client_id": "v1", "ack_command_id": None}
    )
    assert viewer["playhead_sec"] == 2.0
    assert viewer["server_seq"] >= 1

    control = SessionControlService(ProjectWorkspace.open(minimal_project))
    assert control.seek(3.0)["playhead_sec"] == 3.0
    assert control.set_playing(True)["is_playing"] is True
    assert control.set_mode("fx")["audition_mode"] == "fx"
    selected = control.set_selection({"kind": "clip", "id": "c9"})
    assert selected["selection"] == {"kind": "clip", "id": "c9"}
    regioned = control.set_region(1.0, 2.0, playing=True, query="hi")
    assert regioned["region"]["end_sec"] == 2.0
    assert regioned["query"] == "hi"
    assert regioned["is_playing"] is True
    stopped = control.stop()
    assert stopped["region"] is None
    assert stopped["is_playing"] is False
    # SessionControlService has no mute/solo facade; submit the typed command directly.
    muted = SessionSyncService(proj).submit_control(
        "SetMuteSolo", {"solo_tracks": {"host": True}, "viewer_mute": {"guest": True}}
    )["snapshot"]
    assert muted["solo_tracks"] == {"host": True}
    assert muted["viewer_mute"] == {"guest": True}


def test_read_empty_authority_returns_none(minimal_project) -> None:
    from podcast_mcp.services.session_sync.snapshot import empty_snapshot

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.store.put_snapshot(0, empty_snapshot())
    assert read_session_state(proj) is None


def test_state_or_none_missing_db(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    assert svc.state_or_none() is None
    # Reading must not create sync.db as a side effect.
    assert not sync_db_path(proj).exists()
    assert svc.meta()["exists"] is False


def test_state_or_none_empty_authority(minimal_project) -> None:
    from podcast_mcp.services.session_sync.snapshot import empty_snapshot

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.store.put_snapshot(0, empty_snapshot())
    assert sync_db_path(proj).is_file()
    assert svc.state_or_none() is None
    assert svc.meta()["exists"] is False


def test_state_or_none_populated_snapshot(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    applied = svc.submit_control("SetPlayhead", {"playhead_sec": 4.0})
    state = svc.state_or_none()
    assert state is not None
    assert state["playhead_sec"] == 4.0
    assert state["server_seq"] == applied["server_seq"] >= 1
    assert state["last_command_id"] == applied["command"]["command_id"]
    via_fn = read_session_state(proj)
    assert via_fn is not None
    assert via_fn["last_command_id"] == state["last_command_id"]
    meta = svc.meta()
    assert meta["exists"] is True
    assert meta["server_seq"] == state["server_seq"]


def test_snapshot_has_no_legacy_alias_fields(minimal_project) -> None:
    proj = load_project(minimal_project)
    assert not sync_db_path(proj).exists()
    svc = SessionSyncService(proj)
    result = svc.submit_control("SetPlayhead", {"playhead_sec": 2.0})
    raw = svc.store.get_snapshot()
    assert raw is not None
    for out in (flatten_for_api(raw, svc.store.list_clients()), svc.snapshot(), result["snapshot"]):
        assert "revision" not in out
        assert "command_id" not in out
        assert out["last_command_id"] == result["command"]["command_id"]
        assert out["server_seq"] == result["server_seq"] >= 1


def test_viewer_snapshot_field_commands(minimal_project) -> None:
    proj = load_project(minimal_project)
    agent = publish_agent_play(
        proj,
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    out = publish_viewer_snapshot(
        proj,
        {
            "client_id": "v-fields",
            "ack_command_id": agent["last_command_id"],
            "selection": {"kind": "track", "track_id": "host"},
            "viewer_mute": {"host": True},
            "solo_tracks": {},
            "audition_mode": "raw",
            "source": "track:host",
            "playhead_sec": 1.25,
            "is_playing": False,
            "region": None,
        },
    )
    assert out["selection"]["track_id"] == "host"
    assert out["viewer_mute"] == {"host": True}
    assert out["audition_mode"] == "raw"
    assert out["playhead_sec"] == 1.25
    assert out["is_playing"] is False
    assert out["region"] is None
    assert out["server_time_ns"] > 0


def test_client_role_literal_sets_are_shared() -> None:
    from typing import get_args

    from podcast_mcp.services.document_sync.commands import ClientRole as DocumentRole
    from podcast_mcp.services.session_sync.authz import _KNOWN_ROLES, ClientRole
    from podcast_mcp.services.session_sync.commands import TransportRole

    assert DocumentRole is ClientRole
    assert frozenset(get_args(ClientRole)) == _KNOWN_ROLES
    assert set(get_args(TransportRole)) == set(get_args(ClientRole)) - {"guest"}
