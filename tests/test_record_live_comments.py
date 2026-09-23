"""Live comments during recording: host rewrite, visibility, land, discard."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.comments import COMMENT_BODY_MAX
from podcast_mcp.edits.share_registry import reset_share_registry_for_tests
from podcast_mcp.gui.server import create_app
from podcast_mcp.history import HistoryManager
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordAuthzError, RecordCommand
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.live_comments import (
    RECORD_LIVE_COMMENT_MAX,
    RecordLiveCommentError,
    RecordLiveCommentStore,
    parse_comment_id,
)
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    filter_record_event_for_guest,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.share import ShareService


def _isolate(tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_workspace / "shares_index.json"))
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_workspace / "reg.sqlite"))
    reset_share_registry_for_tests()
    reset_record_runtime_for_tests()


def _seed(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _cmd(ctype: str, *, pid: str = "p_host", payload: dict | None = None, role: str = "host"):
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id=f"c-{pid}",
        role=role,  # type: ignore[arg-type]
        participant_id=pid,
        client_seq=next_record_client_seq(),
    )


def _comment_payload(cid: str, *, body: str = "Marker", pressed: int = 123_400) -> dict:
    nid = cid if cid.startswith("live-") else f"live-{cid}"
    return {
        "id": nid,
        "take_index": 99,
        "recording_ms": 9_999_999,
        "pressed_wall_ms": pressed,
        "body": body,
    }


def _consent_room(ws, room, *, name: str = "Ava", connection_id: str = "c1"):
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name=name,
        client_id=f"rec-{connection_id}",
        connection_id=connection_id,
        capabilities=["join", "monitor", "comment"],
        client_seq=1,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id=f"rec-{connection_id}",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=["join", "monitor", "comment"],
        connection_id=connection_id,
    )
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    return svc, echo["participant_id"]


def test_host_rewrites_recording_ms_and_lands_comment(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("marker-1", pressed=123_400),
        ),
        now_wall_ms=200_000,
        capabilities=["join", "monitor", "comment"],
    )
    live = svc.snapshot()["comments"]
    assert len(live) == 1
    assert live[0]["id"] == "live-marker-1"
    assert live[0]["recording_ms"] == 123_400
    assert live[0]["take_index"] == 0
    assert live[0]["author"] == guest
    assert live[0]["body"] == "Marker"
    svc.submit(_cmd("Stop"), now_wall_ms=200_000)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []
    assert len(result["comments"]) == 1
    assert result["comments"][0]["timeline_start"] == pytest.approx(123.4)
    assert len(ws.project.comments) == 1
    comment = ws.project.comments[0]
    assert comment.id == "live-marker-1"
    assert comment.body == "Marker"
    assert comment.author == guest
    assert comment.timeline_start == pytest.approx(123.4, abs=0.25)
    assert getattr(comment, "title", None) is None
    HistoryManager(minimal_project).undo(ws.project)
    assert ws.project.comments == []


def test_paused_comment_lands_at_pause_point(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Pause"), now_wall_ms=60_000)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("pause-note", body="hold", pressed=70_000),
        ),
        now_wall_ms=80_000,
        capabilities=["join", "monitor", "comment"],
    )
    assert svc.snapshot()["comments"][0]["recording_ms"] == 60_000
    svc.submit(_cmd("Stop"), now_wall_ms=80_000)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["comments"][0]["timeline_start"] == pytest.approx(60.0)


def test_guest_visibility_is_host_enforced(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest_a = _consent_room(ws, room)
    echo_b, _ = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Bea",
        client_id="rec-b",
        connection_id="c-b",
        capabilities=["join", "monitor", "comment"],
        client_seq=1,
    )
    guest_b = echo_b["participant_id"]
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-b",
        role="guest",
        participant_id=guest_b,
        seq=2,
        capabilities=["join", "monitor", "comment"],
        connection_id="c-b",
    )
    prod, _ = svc.join(
        token=room["producer"]["token"],
        role="producer",
        display_name="Pat",
        client_id="rec-p",
        connection_id="c-p",
        capabilities=["monitor", "comment"],
        client_seq=1,
    )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest_a,
            role="guest",
            payload=_comment_payload("a-note", body="from A", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    event = {
        "plane": "record",
        "type": "Applied",
        "snapshot": svc.snapshot(),
    }
    host = filter_record_event_for_guest(event, participant_id="p_host", role="host")
    producer = filter_record_event_for_guest(
        event, participant_id=prod["participant_id"], role="producer"
    )
    other = filter_record_event_for_guest(event, participant_id=guest_b, role="guest")
    own = filter_record_event_for_guest(event, participant_id=guest_a, role="guest")
    assert host is not None and len(host["snapshot"]["comments"]) == 1
    assert producer is not None and len(producer["snapshot"]["comments"]) == 1
    assert own is not None and [c["id"] for c in own["snapshot"]["comments"]] == ["live-a-note"]
    assert other is not None and other["snapshot"]["comments"] == []


def test_reconnect_upserts_once(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    payload = _comment_payload("queued-1", body="once", pressed=5_000)
    for _ in range(2):
        svc.submit(
            _cmd("Comment", pid=guest, role="guest", payload=payload),
            now_wall_ms=6_000,
            capabilities=["join", "monitor", "comment"],
        )
    comments = svc.snapshot()["comments"]
    assert [row["id"] for row in comments] == ["live-queued-1"]
    assert comments[0]["body"] == "once"


def test_discard_take_deletes_live_and_landed_comments(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("gone", body="drop me", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    RecordLandingService(ws).land(align=lambda _p: None)
    assert len(ws.project.comments) == 1
    RecordLandingService(ws).delete_take(0)
    ws.reload()
    assert ws.project.comments == []
    assert (
        RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()["comments"] == []
    )


def test_comment_forbidden_without_cap_and_outside_take(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    with pytest.raises(RecordStateError, match="cannot comment"):
        svc.submit(
            _cmd(
                "Comment",
                pid=guest,
                role="guest",
                payload=_comment_payload("early"),
            ),
            now_wall_ms=10,
            capabilities=["join", "monitor", "comment"],
        )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    with pytest.raises(RecordAuthzError, match="comment capability"):
        svc.submit(
            _cmd(
                "Comment",
                pid=guest,
                role="guest",
                payload=_comment_payload("no-cap"),
            ),
            now_wall_ms=10,
            capabilities=["join", "monitor"],
        )
    host_snap = svc.submit(
        _cmd("Comment", payload=_comment_payload("host-m", pressed=10)),
        now_wall_ms=20,
    )
    assert any(row["author"] == "p_host" for row in host_snap["comments"])


def test_guest_ws_snapshot_hides_other_guest_comments(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest_a = _consent_room(ws, room)
    echo_b, _ = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Bea",
        client_id="rec-b",
        connection_id="c-b",
        capabilities=["join", "monitor", "comment"],
        client_seq=1,
    )
    guest_b = echo_b["participant_id"]
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-b",
        role="guest",
        participant_id=guest_b,
        seq=2,
        capabilities=["join", "monitor", "comment"],
        connection_id="c-b",
    )
    prod_echo, _ = svc.join(
        token=room["producer"]["token"],
        role="producer",
        display_name="Pat",
        client_id="rec-p",
        connection_id="c-p",
        capabilities=["monitor", "comment"],
        client_seq=1,
    )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest_a,
            role="guest",
            payload=_comment_payload("ws-a", body="A only", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    svc.disconnect(guest_b, connection_id="c-b")
    svc.disconnect(prod_echo["participant_id"], connection_id="c-p")
    client = TestClient(create_app())

    def drain(sock, pred, n=30):
        for _ in range(n):
            msg = sock.receive_json()
            if pred(msg):
                return msg
        raise AssertionError("expected message not received")

    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws?name=Bea") as sock:
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Join",
                "payload": {
                    "display_name": "Bea",
                    "participant_id": guest_b,
                    "lease": echo_b["lease"],
                },
                "client_seq": 3,
            }
        )
        snap = drain(sock, lambda m: m.get("type") == "Snapshot")
        assert snap["snapshot"]["comments"] == []

    with client.websocket_connect(f"/api/rec/{room['producer']['token']}/ws?name=Pat") as sock:
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Join",
                "payload": {
                    "display_name": "Pat",
                    "participant_id": prod_echo["participant_id"],
                    "lease": prod_echo["lease"],
                },
                "client_seq": 2,
            }
        )
        snap = drain(sock, lambda m: m.get("type") == "Snapshot")
        assert any(row["id"] == "live-ws-a" for row in snap["snapshot"]["comments"])


def test_live_comment_store_guards_and_ignores_landed(tmp_path):
    store = RecordLiveCommentStore(tmp_path / "sync.db")
    with pytest.raises(RecordLiveCommentError, match="invalid comment id"):
        parse_comment_id("not valid!")
    with pytest.raises(RecordLiveCommentError, match="invalid comment id"):
        parse_comment_id("marker-1")
    with pytest.raises(RecordLiveCommentError, match="body is required"):
        store.upsert(
            session_id="s",
            comment_id="live-c1",
            take_index=0,
            recording_ms=0,
            pressed_wall_ms=0,
            author="a",
            body="  ",
        )
    with pytest.raises(RecordLiveCommentError, match="exceeds"):
        store.upsert(
            session_id="s",
            comment_id="live-c1",
            take_index=0,
            recording_ms=0,
            pressed_wall_ms=0,
            author="a",
            body="x" * (COMMENT_BODY_MAX + 1),
        )
    with pytest.raises(RecordLiveCommentError, match="author is required"):
        store.upsert(
            session_id="s",
            comment_id="live-c1",
            take_index=0,
            recording_ms=0,
            pressed_wall_ms=0,
            author=" ",
            body="hi",
        )
    store.upsert(
        session_id="s",
        comment_id="live-keep",
        take_index=0,
        recording_ms=1,
        pressed_wall_ms=1,
        author="a",
        body="first",
    )
    store.upsert(
        session_id="s",
        comment_id="live-keep",
        take_index=1,
        recording_ms=2,
        pressed_wall_ms=2,
        author="a",
        body="second",
    )
    assert store.get("s", "live-keep")["body"] == "second"
    with pytest.raises(RecordLiveCommentError, match="another participant"):
        store.upsert(
            session_id="s",
            comment_id="live-keep",
            take_index=1,
            recording_ms=3,
            pressed_wall_ms=3,
            author="b",
            body="stolen",
        )
    assert store.get("s", "live-keep")["author"] == "a"
    store.mark_landed("s", ["live-keep"])
    store.upsert(
        session_id="s",
        comment_id="live-keep",
        take_index=0,
        recording_ms=9,
        pressed_wall_ms=9,
        author="a",
        body="ignored",
    )
    assert store.get("s", "live-keep")["body"] == "second"
    for i in range(RECORD_LIVE_COMMENT_MAX):
        store.upsert(
            session_id="full",
            comment_id=f"live-n{i}",
            take_index=0,
            recording_ms=i,
            pressed_wall_ms=i,
            author="a",
            body="x",
        )
    with pytest.raises(RecordLiveCommentError, match="too many"):
        store.upsert(
            session_id="full",
            comment_id="live-overflow",
            take_index=0,
            recording_ms=0,
            pressed_wall_ms=0,
            author="a",
            body="x",
        )
    store.mark_landed("full", ["live-n0"])
    store.upsert(
        session_id="full",
        comment_id="live-after-land",
        take_index=0,
        recording_ms=0,
        pressed_wall_ms=0,
        author="a",
        body="x",
    )
    store.mark_landed("s", [])
    assert store.get("s", "missing") is None
    assert store.delete_take("empty", 0) == []
    store.close()


def test_future_pressed_wall_clamps_to_now(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("clamped", pressed=50_000),
        ),
        now_wall_ms=10_000,
        capabilities=["join", "monitor", "comment"],
    )
    assert svc.snapshot()["comments"][0]["recording_ms"] == 10_000
    assert svc.snapshot()["comments"][0]["pressed_wall_ms"] == 10_000


def test_comment_keeps_original_take_after_stop_start(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    payload = _comment_payload("take0", body="first take", pressed=1_000)
    svc.submit(
        _cmd("Comment", pid=guest, role="guest", payload=payload),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    svc.submit(_cmd("Start"), now_wall_ms=5_000)
    svc.submit(
        _cmd("Comment", pid=guest, role="guest", payload=payload),
        now_wall_ms=6_000,
        capabilities=["join", "monitor", "comment"],
    )
    live = svc.snapshot()["comments"]
    assert len(live) == 1
    assert live[0]["take_index"] == 0
    assert live[0]["recording_ms"] == 1_000


def test_producer_cannot_overwrite_guest_comment(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    prod, _ = svc.join(
        token=room["producer"]["token"],
        role="producer",
        display_name="Pat",
        client_id="rec-p",
        connection_id="c-p",
        capabilities=["monitor", "comment"],
        client_seq=1,
    )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("owned", body="guest note", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    with pytest.raises(RecordStateError, match="another participant"):
        svc.submit(
            _cmd(
                "Comment",
                pid=prod["participant_id"],
                role="producer",
                payload=_comment_payload("owned", body="stolen", pressed=1_500),
            ),
            now_wall_ms=2_000,
            capabilities=["monitor", "comment"],
        )
    assert svc.snapshot()["comments"][0]["body"] == "guest note"
    assert svc.snapshot()["comments"][0]["author"] == guest


def test_discard_take_drops_unlanded_comments(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("unlanded", body="only sqlite", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    assert svc.snapshot()["comments"]
    RecordLandingService(ws).delete_take(0)
    ws.reload()
    assert ws.project.comments == []
    assert (
        RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()["comments"] == []
    )


def test_land_skips_foreign_comment_id(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.edits.comments import add_comment

    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    add_comment(
        ws.project,
        body="host note",
        author="host",
        timeline_start=1.0,
        comment_id="live-collide",
    )
    save_project(ws.project, minimal_project)
    ws.reload()
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            pid=guest,
            role="guest",
            payload=_comment_payload("collide", body="guest", pressed=1_000),
        ),
        now_wall_ms=2_000,
        capabilities=["join", "monitor", "comment"],
    )
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["comments"] == []
    assert [c.author for c in ws.project.comments] == ["host"]
    assert ws.project.comments[0].body == "host note"
