from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from podcast_mcp.models import load_project
from podcast_mcp.services.session_sync.commands import SyncCommand
from podcast_mcp.services.session_sync.service import (
    SessionSyncService,
    next_client_seq,
    sync_db_path,
)


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


def test_legacy_json_mirror_written(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_play(
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    assert sync_db_path(proj).is_file()
    legacy = proj.artifacts_dir() / "session_state.json"
    assert legacy.is_file()
    data = json.loads(legacy.read_text())
    assert data["region"]["start_sec"] == 1.0


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


def test_legacy_seed_and_open(minimal_project) -> None:
    import json

    from podcast_mcp.services.session_sync.service import (
        _STORE_CACHE,
        SessionSyncService,
        sync_db_path,
    )

    proj = load_project(minimal_project)
    legacy = proj.artifacts_dir() / "session_state.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(
        json.dumps(
            {
                "playhead_sec": 11.0,
                "is_playing": False,
                "audition_mode": "mix",
                "region": {"start_sec": 11.0, "end_sec": 12.0},
                "command_id": "legacy-cmd",
                "origin": "agent",
            }
        ),
        encoding="utf-8",
    )
    # Drop cached store so seed runs
    key = f"{sync_db_path(proj).resolve()}|"
    _STORE_CACHE.pop(key, None)
    if sync_db_path(proj).is_file():
        sync_db_path(proj).unlink()
    svc = SessionSyncService.open(minimal_project)
    snap = svc.snapshot()
    assert snap["playhead_sec"] == 11.0
    assert snap["command_id"] == "legacy-cmd"
    assert svc.meta()["exists"] is True
    # Re-open with existing snapshot skips re-seed
    _STORE_CACHE.pop(key, None)
    again = SessionSyncService(proj).snapshot()
    assert again["playhead_sec"] == 11.0


def test_legacy_seed_corrupt_and_non_dict(minimal_project) -> None:
    from podcast_mcp.services.session_sync.service import (
        _STORE_CACHE,
        SessionSyncService,
        sync_db_path,
    )

    proj = load_project(minimal_project)
    legacy = proj.artifacts_dir() / "session_state.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    key = f"{sync_db_path(proj).resolve()}|"
    for bad in ("{not-json", "[]"):
        _STORE_CACHE.pop(key, None)
        if sync_db_path(proj).is_file():
            sync_db_path(proj).unlink()
        legacy.write_text(bad, encoding="utf-8")
        snap = SessionSyncService(proj).snapshot()
        assert snap["server_seq"] == 0
        assert snap.get("command_id") is None


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


def test_list_clients_expires_stale_presence(minimal_project) -> None:
    from podcast_mcp.services.session_sync.log import SyncStore
    from podcast_mcp.services.session_sync.service import sync_db_path

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
    from podcast_mcp.services.session_sync.service import sync_db_path

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
    assert normalize_presence_meta({"viewport": {"start_sec": 0, "end_sec": 0.05}}) is None
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
    from podcast_mcp.services.session_sync.service import sync_db_path

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


def test_legacy_json_has_no_roster(minimal_project) -> None:
    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.submit_play(
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    data = json.loads((proj.artifacts_dir() / "session_state.json").read_text())
    assert "clients" not in data
    assert "meta" not in data


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
