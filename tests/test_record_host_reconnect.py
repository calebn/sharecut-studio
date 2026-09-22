"""Host live-room reconnect: forced pause, remint guard, restart, landing."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_registry import reset_share_registry_for_tests
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.review import create_record_room_tool
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.record.service import (
    _CONN_LOCK,
    _HOST_CONNS,
    RecordSessionService,
    _persist_host_offline_since,
    apply_record_ws_message,
    assert_no_open_take,
    infer_host_offline_since,
    next_record_client_seq,
    record_hub_key,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.state import (
    HOST_OFFLINE_PAUSE_MS,
    HOST_PARTICIPANT_ID,
    TAKE_OPEN_REMINT_MSG,
    empty_record_snapshot,
)
from podcast_mcp.services.record.upload import RecordUploadService, pcm_wav_header, sha256_hex
from podcast_mcp.services.share import ShareService


def _isolate(tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(tmp_workspace / "shares_index.json"))
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


def _pcm(n: int = 480) -> tuple[bytes, str, str]:
    pcm = bytes([i % 256 for i in range(n)])
    wav = pcm_wav_header(len(pcm)) + pcm
    return pcm, sha256_hex(pcm), sha256_hex(wav)


def _ack(
    uploader: RecordUploadService,
    *,
    session_id: str,
    take: int,
    pid: str,
    segment: int,
    join_offset_ms: int,
    nbytes: int = 480,
) -> None:
    pcm, digest, file_hash = _pcm(nbytes)
    uploader.ingest_part(
        session_id=session_id,
        take_index=take,
        participant_id=pid,
        segment_index=segment,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        expected_parts=1,
        join_offset_ms=join_offset_ms,
    )


def _cmd(ctype: str, *, pid: str = "p_host", payload: dict | None = None, seq: int | None = None):
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id="cli",
        role="host" if pid == "p_host" else "guest",
        participant_id=pid,
        client_seq=seq if seq is not None else next_record_client_seq(),
    )


def _consent_room(ws, room):
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
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
        client_id="rec-guest",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="c1",
    )
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    return svc, echo["participant_id"]


def test_service_host_leave_join_threshold_and_resume(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)
    svc.disconnect(HOST_PARTICIPANT_ID)
    snap = svc.snapshot()
    assert snap["state"] == "recording"
    assert snap["host_offline_since_wall_ms"]
    svc.submit(
        _cmd("Join", payload={"display_name": "Host"}),
        now_wall_ms=snap["host_offline_since_wall_ms"] + HOST_OFFLINE_PAUSE_MS,
    )
    paused = svc.snapshot()
    assert paused["state"] == "paused"
    assert paused["pause_reason"] == "host_reconnect"
    assert paused["takes"][0]["pauses"][0]["pause_reason"] == "host_reconnect"
    svc.submit(_cmd("Resume"), now_wall_ms=40_000)
    resumed = svc.snapshot()
    assert resumed["state"] == "recording"
    assert resumed["pause_reason"] is None


def test_restart_empty_conns_still_pauses_on_host_join(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)
    svc.submit(_cmd("Leave"), now_wall_ms=20_000)
    assert svc.snapshot()["host_offline_since_wall_ms"] == 20_000
    db_path = Path(ws.project.workspace_dir) / "artifacts" / "session" / "sync.db"
    assert db_path.is_file()
    reset_record_runtime_for_tests()
    fresh = RecordSessionService(ws.project, session_id=room["session_id"])
    assert fresh.snapshot()["host_offline_since_wall_ms"] == 20_000
    fresh.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-restart",
        connection_id="h-restart",
        capabilities=["join", "monitor"],
    )
    # join() uses wall clock; offline-since is 20s epoch so the gap always exceeds 10s
    out = fresh.snapshot()
    assert out["state"] == "paused"
    assert out["pause_reason"] == "host_reconnect"
    assert out["host_offline_since_wall_ms"] is None


def test_remint_refused_while_recording_or_paused_allowed_when_idle(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)
    with pytest.raises(RecordStateError, match="A take is open"):
        ShareService(ws).create_record_room()
    client = TestClient(create_app())
    conflict = client.post("/api/shares/record", json={"path": str(ws.path)})
    assert conflict.status_code == 409
    assert TAKE_OPEN_REMINT_MSG in conflict.json()["detail"]
    runner = CliRunner()
    cli = runner.invoke(cli_app, ["review", "share", "--project", str(ws.path), "--kind", "record"])
    assert cli.exit_code != 0
    assert TAKE_OPEN_REMINT_MSG in cli.output
    with pytest.raises(RecordStateError, match="A take is open"):
        create_record_room_tool(str(ws.path))
    svc.submit(_cmd("Pause"), now_wall_ms=20)
    with pytest.raises(RecordStateError, match="A take is open"):
        ShareService(ws).create_record_room()
    svc.submit(_cmd("Stop"), now_wall_ms=30)
    idle = ShareService(ws).create_record_room()
    assert idle["session_id"] != room["session_id"]
    fresh = RecordSessionService(ws.project, session_id=idle["session_id"])
    assert fresh.snapshot()["state"] == "lobby"


def test_land_after_host_reconnect_pause_clips_abut(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Leave"), now_wall_ms=20_000)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=35_000)
    assert svc.snapshot()["state"] == "paused"
    svc.submit(_cmd("Resume"), now_wall_ms=50_000)
    svc.submit(_cmd("Stop"), now_wall_ms=51_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        nbytes=960,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=1,
        join_offset_ms=35_000,
        nbytes=480,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    clips = sorted(result["clips"], key=lambda row: row["segment_index"])
    assert len(clips) == 2
    assert clips[0]["track_id"] == clips[1]["track_id"]
    assert clips[1]["timeline_start"] == pytest.approx(35.0)
    # Host keeper re-arm after a WS blip is covered by
    # gui/web/src/record/useHostKeeperCapture.test.ts (resetKey stays put
    # under 10s; host-reconnect pause seq remounts).


def test_restart_without_leave_still_pauses_on_host_join(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)
    host = next(
        p for p in svc.snapshot()["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID
    )
    assert host["connected"] is True
    assert svc.snapshot()["host_offline_since_wall_ms"] is None
    reset_record_runtime_for_tests()
    fresh = RecordSessionService(ws.project, session_id=room["session_id"])
    ghost = next(
        p for p in fresh.snapshot()["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID
    )
    assert ghost["connected"] is True
    fresh.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-crash",
        connection_id="h-crash",
        capabilities=["join", "monitor"],
    )
    out = fresh.snapshot()
    assert out["state"] == "paused"
    assert out["pause_reason"] == "host_reconnect"
    assert out["host_offline_since_wall_ms"] is None


@pytest.mark.parametrize(("close_wall_ms", "return_wall_ms"), [(4_900, 10_100), (5_100, 10_200)])
def test_observed_host_disconnect_uses_close_time_for_reconnect_threshold(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, close_wall_ms, return_wall_ms
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    clock = {"wall_ms": 0}
    monkeypatch.setattr(
        "podcast_mcp.services.record.service.time.time_ns",
        lambda: clock["wall_ms"] * 1_000_000,
    )
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-live",
        connection_id="h-live",
        capabilities=["join", "monitor"],
    )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    clock["wall_ms"] = close_wall_ms
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-live")
    snap = svc.snapshot()
    assert snap["state"] == "recording"
    assert snap["host_offline_since_wall_ms"] == close_wall_ms

    clock["wall_ms"] = return_wall_ms
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-return",
        connection_id="h-return",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "recording"

    clock["wall_ms"] = 11_000
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-return")
    clock["wall_ms"] = 21_100
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-late-return",
        connection_id="h-late-return",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "paused"
    assert svc.snapshot()["pause_reason"] == "host_reconnect"


@pytest.mark.parametrize(("close_wall_ms", "return_wall_ms"), [(9_000, 12_000), (31_000, 32_000)])
def test_delayed_host_disconnect_uses_stale_beat_for_reconnect_threshold(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, close_wall_ms, return_wall_ms
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    clock = {"wall_ms": 1_000}
    monkeypatch.setattr(
        "podcast_mcp.services.record.service.time.time_ns",
        lambda: clock["wall_ms"] * 1_000_000,
    )
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-live",
        connection_id="h-live",
        capabilities=["join", "monitor"],
    )
    svc.submit(_cmd("Start"), now_wall_ms=1_000)
    clock["wall_ms"] = close_wall_ms
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-live")
    assert svc.snapshot()["host_offline_since_wall_ms"] == 1_000

    clock["wall_ms"] = return_wall_ms
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-return",
        connection_id="h-return",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "paused"
    assert svc.snapshot()["pause_reason"] == "host_reconnect"


def test_new_take_ignores_stopped_interval_when_host_reconnects(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    clock = {"wall_ms": 1_000}
    monkeypatch.setattr(
        "podcast_mcp.services.record.service.time.time_ns",
        lambda: clock["wall_ms"] * 1_000_000,
    )
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-live",
        connection_id="h-live",
        capabilities=["join", "monitor"],
    )
    svc.submit(_cmd("Start"), now_wall_ms=1_000)
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)

    clock["wall_ms"] = 100_000
    svc.submit(_cmd("Start"), now_wall_ms=100_000)
    assert svc.snapshot()["host_last_beat_wall_ms"] == 100_000
    clock["wall_ms"] = 100_050
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-second",
        connection_id="h-second",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "recording"

    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-second")
    clock["wall_ms"] = 100_100
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-live")
    assert svc.snapshot()["host_offline_since_wall_ms"] == 100_100
    clock["wall_ms"] = 100_200
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-return",
        connection_id="h-return",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "recording"


def test_resumed_take_ignores_paused_interval_when_host_reconnects(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    clock = {"wall_ms": 1_000}
    monkeypatch.setattr(
        "podcast_mcp.services.record.service.time.time_ns",
        lambda: clock["wall_ms"] * 1_000_000,
    )
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-live",
        connection_id="h-live",
        capabilities=["join", "monitor"],
    )
    svc.submit(_cmd("Start"), now_wall_ms=1_000)
    svc.submit(_cmd("Pause"), now_wall_ms=2_000)

    clock["wall_ms"] = 100_000
    svc.submit(_cmd("Resume"), now_wall_ms=100_000)
    assert svc.snapshot()["host_last_beat_wall_ms"] == 100_000
    clock["wall_ms"] = 100_100
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h-live")
    assert svc.snapshot()["host_offline_since_wall_ms"] == 100_100
    clock["wall_ms"] = 100_200
    svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-return",
        connection_id="h-return",
        capabilities=["join", "monitor"],
    )
    assert svc.snapshot()["state"] == "recording"


def test_begin_record_session_refuses_open_take(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.record.service import begin_record_session

    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)
    with pytest.raises(RecordStateError, match="A take is open"):
        begin_record_session(ws.project, "brand-new")
    assert svc.snapshot()["state"] == "recording"


def test_infer_host_offline_since_stale_bucket_fresh_conn_and_fallback() -> None:
    reset_record_runtime_for_tests()
    snap = empty_record_snapshot("sess")
    snap.state = "lobby"
    assert infer_host_offline_since("hub", snap, now_wall_ms=99_000) is None
    snap.state = "recording"
    assert infer_host_offline_since("hub", snap, now_wall_ms=12_000) == 2_000
    snap.host_last_beat_wall_ms = 3_000
    assert infer_host_offline_since("hub", snap, now_wall_ms=20_000) == 3_000
    snap.host_offline_since_wall_ms = 4_000
    assert infer_host_offline_since("hub", snap, now_wall_ms=20_000) == 4_000
    snap.host_offline_since_wall_ms = None
    with _CONN_LOCK:
        _HOST_CONNS["hub"] = {"h1": (0.0, 5_000), "h2": (0.0, 6_000)}
    assert infer_host_offline_since("hub", snap, now_wall_ms=6_000 + HOST_OFFLINE_PAUSE_MS) == 6_000
    assert infer_host_offline_since("hub", snap, now_wall_ms=6_500) is None
    reset_record_runtime_for_tests()


def test_persist_host_offline_since_skips_lobby_and_already_stamped(tmp_path: Path) -> None:
    from podcast_mcp.services.session_sync.log import SyncStore

    rec = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    rec.put_snapshot(1, empty_record_snapshot("sess").model_dump())
    _persist_host_offline_since(rec, 1_000)
    assert rec.get_snapshot()["host_offline_since_wall_ms"] is None
    body = empty_record_snapshot("sess").model_dump()
    body["state"] = "recording"
    rec.put_snapshot(2, body)
    _persist_host_offline_since(rec, 2_000)
    assert rec.get_snapshot()["host_offline_since_wall_ms"] == 2_000
    _persist_host_offline_since(rec, 3_000)
    assert rec.get_snapshot()["host_offline_since_wall_ms"] == 2_000
    rec.close()


def test_assert_no_open_take_skips_missing_snapshot(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    ShareService(ws).create_record_token(role="guest", session_id="ghost", require_room=False)
    assert_no_open_take(ws.project)


def test_verify_lease_rejects_host(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    assert svc.verify_lease(HOST_PARTICIPANT_ID, "lease", token=room["guest"]["token"]) is False


def test_failed_host_join_persists_last_conn_beat(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=10)

    def boom(*_args, **_kwargs):
        raise RecordStateError("join boom")

    monkeypatch.setattr(svc, "submit", boom)
    with pytest.raises(RecordStateError, match="join boom"):
        svc.join(
            token="",
            role="host",
            display_name="Host",
            client_id="host-fail",
            connection_id="h-fail",
            capabilities=["join", "monitor"],
        )
    assert svc.snapshot()["host_offline_since_wall_ms"] is not None
    assert record_hub_key(ws.project) not in _HOST_CONNS


def test_guest_leave_skipped_while_connection_held(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    still = svc.submit(_cmd("Leave", pid=guest), connection_id="c1")
    person = next(p for p in still["participants"] if p["participant_id"] == guest)
    assert person["connected"] is True
