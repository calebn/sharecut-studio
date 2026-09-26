"""Record keeper chunk upload + resume ACK."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import podcast_mcp.gui.routes.record_upload_http as upload_http
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.service import (
    RecordSessionService,
    next_record_client_seq,
    release_connection,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.upload import (
    CLIPPING_MAX_REGIONS,
    JOIN_OFFSET_MAX_MS,
    ROOM_TONE_MAX_PCM_BYTES,
    ROOM_TONE_TAKE_INDEX,
    LandRollbackKey,
    RecordUploadError,
    RecordUploadService,
    RecordUploadStore,
    parse_clipping_regions,
    parse_upload_kind,
    sha256_hex,
)
from podcast_mcp.services.share import ShareService
from podcast_mcp.util.wav import pcm_wav_header


def _isolate() -> None:
    reset_record_runtime_for_tests()


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    return ws, room, TestClient(create_app())


def _join(wsock, *, name: str, seq: int = 1):
    wsock.send_json(
        {
            "type": "Record",
            "command_type": "Join",
            "payload": {"display_name": name},
            "client_seq": seq,
        }
    )


def _drain_until(wsock, predicate, *, n: int = 20):
    for _ in range(n):
        msg = wsock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message not received")


def _pcm_part(n: int = 200) -> tuple[bytes, str, str]:
    pcm = bytes([i % 256 for i in range(n)])
    wav = pcm_wav_header(len(pcm)) + pcm
    return pcm, sha256_hex(pcm), sha256_hex(wav)


def _host_cmd(svc, ctype: str, *, now: int, payload: dict | None = None):
    return svc.submit(
        RecordCommand.parse(
            command_type=ctype,
            payload=payload or {},
            client_id="host",
            role="host",
            participant_id="p_host",
            client_seq=next_record_client_seq(),
        ),
        now_wall_ms=now,
    )


def _guest_join(
    svc, room, *, name: str, conn: str, pid: str | None = None, lease: str | None = None
) -> tuple[str, str]:
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name=name,
        participant_id=pid,
        lease=lease,
        client_id=name,
        connection_id=conn,
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    return echo["participant_id"], echo["lease"]


def _guest_consent(svc, pid: str, *, name: str, accepted: bool, seq: int):
    return svc.submit(
        RecordCommand.parse(
            command_type="Consent",
            payload={"accepted": accepted, "display_name": name},
            client_id=name,
            role="guest",
            participant_id=pid,
            client_seq=seq,
        ),
        capabilities=["join", "monitor"],
    )


def _consented_take(ws, room) -> tuple[str, str]:
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc.join(
        token=room["guest"]["token"],
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    _guest_consent(svc, pid, name="Ava", accepted=True, seq=2)
    _host_cmd(svc, "Start", now=1000)
    _host_cmd(svc, "Stop", now=2000)
    return pid, lease


def _post_keeper(client, token: str, pid: str, lease: str, *, take: int, segment: int = 0):
    pcm, digest, wav_hash = _pcm_part(64)
    return client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": take,
            "segment_index": segment,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": wav_hash,
            "final": True,
            "expected_parts": 1,
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )


def test_service_acks_parts_and_resumes_after_gap(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    sid = "room1"
    svc = RecordUploadService(ws.project)
    first, h1, _ = _pcm_part(100)
    second, h2, file_hash = _pcm_part(80)
    wav = pcm_wav_header(len(first) + len(second)) + first + second
    file_hash = sha256_hex(wav)
    a = svc.ingest_part(
        session_id=sid,
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=h1,
        expected_parts=2,
    )
    assert a["acked"] is True
    assert a["file_ack"] is False
    status = svc.status(session_id=sid, participant_id="p_aa")
    assert status["segments"][0]["acked_parts"] == [0]
    assert status["segments"][0]["expected_parts"] == 2
    with pytest.raises(RecordUploadError, match="expected_parts incomplete"):
        svc.ingest_part(
            session_id=sid,
            take_index=0,
            participant_id="p_aa",
            segment_index=1,
            part_seq=1,
            data=second,
            digest=h2,
            file_sha256=file_hash,
            final=True,
            expected_parts=2,
        )
    b = svc.ingest_part(
        session_id=sid,
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=1,
        data=second,
        digest=h2,
        file_sha256=file_hash,
        final=True,
        expected_parts=2,
    )
    assert b["file_ack"] is True
    assert b["newly_acked"] is True
    again = svc.ingest_part(
        session_id=sid,
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=1,
        data=second,
        digest=h2,
        file_sha256=file_hash,
        final=True,
        expected_parts=2,
    )
    assert again["file_ack"] is True
    assert again["newly_acked"] is False
    dest = (
        Path(ws.project.workspace_dir)
        / "artifacts"
        / "record"
        / "acked"
        / sid
        / "0"
        / "p_aa"
        / "0.wav"
    )
    assert dest.read_bytes() == wav


def test_expected_chunks_survive_reconnect_and_gate_file_ack(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    sid = "room1"
    first, first_hash, _ = _pcm_part(64)
    second, second_hash, _ = _pcm_part(32)
    file_hash = sha256_hex(pcm_wav_header(len(first) + len(second)) + first + second)
    svc = RecordUploadService(ws.project)
    svc.ingest_part(
        session_id=sid,
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=first_hash,
        expected_parts=2,
    )
    reset_record_runtime_for_tests()
    svc = RecordUploadService(ws.project)
    segment = svc.status(session_id=sid)["segments"][0]
    assert segment["acked_parts"] == [0]
    assert segment["expected_parts"] == 2
    assert segment["file_ack"] is False
    with pytest.raises(RecordUploadError, match="expected_parts mismatch"):
        svc.ingest_part(
            session_id=sid,
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=first,
            digest=first_hash,
            file_sha256=file_hash,
            final=True,
        )
    with pytest.raises(RecordUploadError, match="expected_parts incomplete"):
        svc.ingest_part(
            session_id=sid,
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=first,
            digest=first_hash,
            file_sha256=file_hash,
            final=True,
            expected_parts=2,
        )
    assert svc.status(session_id=sid)["segments"][0]["file_ack"] is False
    with pytest.raises(RecordUploadError, match="expected_parts mismatch"):
        svc.ingest_part(
            session_id=sid,
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=1,
            data=second,
            digest=second_hash,
            expected_parts=3,
        )
    assert svc.status(session_id=sid)["segments"][0]["acked_parts"] == [0]
    result = svc.ingest_part(
        session_id=sid,
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=1,
        data=second,
        digest=second_hash,
        file_sha256=file_hash,
        final=True,
        expected_parts=2,
    )
    assert result["file_ack"] is True
    segment = svc.status(session_id=sid)["segments"][0]
    assert segment["file_ack"] is True
    assert segment["expected_parts"] == 2


def test_legacy_final_keeper_infers_count_and_requires_all_parts(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    first, first_hash, _ = _pcm_part(64)
    second, second_hash, _ = _pcm_part(32)
    file_hash = sha256_hex(pcm_wav_header(len(first) + len(second)) + first + second)
    with pytest.raises(RecordUploadError, match="expected_parts incomplete"):
        svc.ingest_part(
            session_id="legacy-room",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=1,
            data=second,
            digest=second_hash,
            file_sha256=file_hash,
            final=True,
        )
    svc.ingest_part(
        session_id="legacy-room",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=first_hash,
    )
    ack = svc.ingest_part(
        session_id="legacy-room",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=1,
        data=second,
        digest=second_hash,
        file_sha256=file_hash,
        final=True,
    )
    assert ack["file_ack"] is True
    assert svc.status(session_id="legacy-room")["segments"][0]["expected_parts"] == 2


def test_service_rejects_bad_hash_and_path(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    pcm, digest, _ = _pcm_part()
    with pytest.raises(RecordUploadError, match="sha256 mismatch"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest="deadbeef",
        )
    with pytest.raises(RecordUploadError, match="invalid"):
        svc.ingest_part(
            session_id="../x",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
        )
    with pytest.raises(RecordUploadError, match="invalid participant"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="../p",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
        )
    with pytest.raises(RecordUploadError, match="invalid take"):
        svc.ingest_part(
            session_id="room1",
            take_index=-1,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
        )
    with pytest.raises(RecordUploadError, match="empty part"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=b"",
            digest="",
        )
    with pytest.raises(RecordUploadError, match="expected_parts incomplete"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=1,
            part_seq=0,
            data=b"",
            digest="",
            file_sha256="ab",
            final=True,
            expected_parts=1,
        )
    first, h1, _ = _pcm_part(32)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=h1,
    )
    other, h2, _ = _pcm_part(40)
    with pytest.raises(RecordUploadError, match="part hash mismatch"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=other,
            digest=h2,
        )


def test_service_omits_missing_part_files_and_restores(minimal_project, sample_wav, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    assert RecordUploadService(ws.project)._store is svc._store
    pcm, digest, _ = _pcm_part(40)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
    )
    part = (
        Path(ws.project.workspace_dir)
        / "artifacts"
        / "record"
        / "uploads"
        / "room1"
        / "0"
        / "p_aa"
        / "0"
        / "0.part"
    )
    assert part.is_file()
    part.unlink()
    status = svc.status(session_id="room1", participant_id="p_aa")
    assert status["segments"][0]["acked_parts"] == []
    again = svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
    )
    assert again["acked"] is True
    assert part.is_file()
    monkeypatch.setattr(
        "podcast_mcp.services.record.upload.RECORD_UPLOAD_PENDING_QUOTA",
        10,
    )
    big, big_digest, _ = _pcm_part(32)
    with pytest.raises(RecordUploadError, match="quota"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=1,
            data=big,
            digest=big_digest,
        )
    with pytest.raises(RecordUploadError, match="too many parts"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=256,
            data=pcm,
            digest=digest,
        )
    with pytest.raises(RecordUploadError, match="expected_parts incomplete"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=2,
            part_seq=0,
            data=b"",
            digest="",
            file_sha256="ab",
            final=True,
            expected_parts=1,
        )


def test_sweep_stale_parts_and_assembled_size_cap(
    minimal_project, sample_wav, monkeypatch, tmp_path
):
    from podcast_mcp.services.record.upload import sweep_stale_record_uploads

    stale = tmp_path / "0.part"
    stale.write_bytes(b"x")
    os.utime(stale, (0, 0))
    assert sweep_stale_record_uploads(tmp_path, ttl_sec=1) == 1
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    pcm, digest, wav_hash = _pcm_part(40)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.record.upload.RECORD_UPLOAD_MAX_ASSEMBLED",
        10,
    )
    with pytest.raises(RecordUploadError, match="assembled file too large"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=wav_hash,
            final=True,
            expected_parts=1,
        )


def test_guest_upload_resume_and_producer_forbidden(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    pid, lease = _consented_take(_ws, room)
    headers = {"X-Record-Participant": pid, "X-Record-Lease": lease}
    missing = client.get(f"/api/rec/{token}/upload")
    assert missing.status_code == 422
    first, h1, _ = _pcm_part(120)
    second, h2, _ = _pcm_part(40)
    wav = pcm_wav_header(len(first) + len(second)) + first + second
    file_hash = sha256_hex(wav)
    q = {"take_index": 0, "segment_index": 0, "part_seq": 0, "sha256": h1}
    r1 = client.post(f"/api/rec/{token}/upload", params=q, headers=headers, content=first)
    assert r1.status_code == 200, r1.text
    assert r1.json()["file_ack"] is False
    killed = client.get(f"/api/rec/{token}/upload", headers=headers)
    assert killed.json()["segments"][0]["acked_parts"] == [0]
    q2 = {
        "take_index": 0,
        "segment_index": 0,
        "part_seq": 1,
        "sha256": h2,
        "file_sha256": file_hash,
        "final": True,
        "expected_parts": 2,
    }
    r2 = client.post(f"/api/rec/{token}/upload", params=q2, headers=headers, content=second)
    assert r2.status_code == 200, r2.text
    assert r2.json()["file_ack"] is True
    done = client.get(f"/api/rec/{token}/upload", headers=headers)
    assert done.json()["segments"][0]["file_ack"] is True
    other = client.post(
        f"/api/rec/{token}/upload",
        params=q,
        headers={"X-Record-Participant": "p_other", "X-Record-Lease": lease},
        content=first,
    )
    assert other.status_code == 403
    prod = room["producer"]["token"]
    denied = client.post(
        f"/api/rec/{prod}/upload",
        params={"take_index": 0, "segment_index": 0, "part_seq": 0, "sha256": "x"},
        headers={"X-Record-Participant": "p_x", "X-Record-Lease": "nope"},
        content=b"x",
    )
    assert denied.status_code == 403


def test_host_upload_acks_own_keeper(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    path = str(minimal_project)
    RecordSessionService(ws.project, session_id=room["session_id"]).join(
        token=room["guest"]["token"],
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pcm, digest, wav_hash = _pcm_part(64)
    params = {
        "path": path,
        "take_index": 0,
        "segment_index": 0,
        "part_seq": 0,
        "sha256": digest,
        "file_sha256": wav_hash,
        "final": True,
        "expected_parts": 1,
    }
    res = client.post("/api/record/upload", params=params, content=pcm)
    assert res.status_code == 200, res.text
    assert res.json()["participant_id"] == "p_host"
    assert res.json()["file_ack"] is True
    status = client.get("/api/record/upload", params={"path": path})
    assert status.status_code == 200
    assert status.json()["segments"][0]["file_ack"] is True


def test_host_status_lists_guest_segments(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    pid, lease = _consented_take(_ws, room)
    res = _post_keeper(client, token, pid, lease, take=0)
    assert res.status_code == 200, res.text
    status = client.get("/api/record/upload", params={"path": str(minimal_project)})
    assert status.status_code == 200
    segs = status.json()["segments"]
    assert segs[0]["participant_id"] == pid
    assert segs[0]["file_ack"] is True
    own = client.get(
        f"/api/rec/{token}/upload",
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
    )
    assert own.status_code == 200
    assert own.json()["segments"][0]["file_ack"] is True


def test_join_offset_not_persisted_on_rejected_part(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    pcm, digest, wav_hash = _pcm_part(32)
    with pytest.raises(RecordUploadError, match="sha256 mismatch"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest="deadbeef",
            join_offset_ms=100,
        )
    assert svc.status(session_id="room1")["segments"] == []
    with pytest.raises(RecordUploadError, match="empty part"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=b"",
            digest="",
            join_offset_ms=100,
        )
    assert svc.status(session_id="room1")["segments"] == []
    with pytest.raises(RecordUploadError, match="too large"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            join_offset_ms=JOIN_OFFSET_MAX_MS + 1,
        )
    first = svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=wav_hash,
        final=True,
        expected_parts=1,
        join_offset_ms=250,
    )
    assert first["newly_acked"] is True
    assert first["landed"] is False
    assert first["land_failed"] is False
    assert svc.status(session_id="room1")["segments"][0]["join_offset_ms"] == 250
    svc.mark_land_failed(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
    )
    failed = svc.status(session_id="room1")["segments"][0]
    assert failed["file_ack"] is True
    assert failed["landed"] is False
    assert failed["land_failed"] is True
    svc.mark_landed(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
    )
    recovered = svc.status(session_id="room1")["segments"][0]
    assert recovered["landed"] is True
    assert recovered["land_failed"] is False
    with pytest.raises(RecordUploadError, match="refused after land"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=wav_hash,
            final=True,
            expected_parts=1,
            join_offset_ms=500,
        )


def test_parse_upload_kind_rejects_unknown() -> None:
    assert parse_upload_kind(None) == "keeper"
    assert parse_upload_kind("room_tone") == "room_tone"
    with pytest.raises(RecordUploadError, match="invalid kind"):
        parse_upload_kind("camera")


def test_room_tone_kind_acks_single_part(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    pcm, digest, wav_hash = _pcm_part(480)
    result = svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=wav_hash,
        final=True,
        kind="room_tone",
    )
    assert result["kind"] == "room_tone"
    assert result["file_ack"] is True
    assert svc.status(session_id="room1")["segments"] == []
    beds = svc.room_tone_status(session_id="room1")
    assert len(beds) == 1
    assert beds[0]["participant_id"] == "p_aa"
    wav = (
        Path(ws.project.workspace_dir)
        / "artifacts"
        / "record"
        / "acked"
        / "room1"
        / "room_tone"
        / "p_aa.wav"
    )
    assert wav.is_file()


def test_room_tone_kind_rejects_oversize_and_extra_part(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    huge = b"\x00" * (ROOM_TONE_MAX_PCM_BYTES + 1)
    digest = sha256_hex(huge)
    with pytest.raises(RecordUploadError, match="room tone too large"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=huge,
            digest=digest,
            file_sha256=sha256_hex(pcm_wav_header(len(huge)) + huge),
            final=True,
            kind="room_tone",
        )
    pcm, digest, wav_hash = _pcm_part(64)
    with pytest.raises(RecordUploadError, match="single part"):
        svc.ingest_part(
            session_id="room1",
            take_index=0,
            participant_id="p_aa",
            segment_index=0,
            part_seq=1,
            data=pcm,
            digest=digest,
            file_sha256=wav_hash,
            final=True,
            kind="room_tone",
        )
    with pytest.raises(RecordUploadError, match="invalid"):
        svc.ingest_part(
            session_id="room1",
            take_index=-1,
            participant_id="p_aa",
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=wav_hash,
            final=True,
            kind="room_tone",
        )


def test_guest_room_tone_upload_requires_consent_producer_denied(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
        pcm, digest, wav_hash = _pcm_part(96)
        params = {
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": wav_hash,
            "final": True,
            "kind": "room_tone",
        }
        headers = {"X-Record-Participant": pid, "X-Record-Lease": lease}
        denied = client.post(
            f"/api/rec/{token}/upload",
            params=params,
            headers=headers,
            content=pcm,
        )
        assert denied.status_code == 403, denied.text
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Consent",
                "payload": {"accepted": True},
                "client_seq": 2,
            }
        )
        _drain_until(sock, lambda m: m.get("type") == "Applied")
        res = client.post(
            f"/api/rec/{token}/upload",
            params=params,
            headers=headers,
            content=pcm,
        )
        assert res.status_code == 200, res.text
        assert res.json()["kind"] == "room_tone"
    prod = room["producer"]["token"]
    producer_denied = client.post(
        f"/api/rec/{prod}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": "x",
            "kind": "room_tone",
        },
        headers={"X-Record-Participant": "p_x", "X-Record-Lease": "nope"},
        content=b"x",
    )
    assert producer_denied.status_code == 403


def test_host_room_tone_upload_and_replace(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    path = str(minimal_project)
    RecordSessionService(ws.project, session_id=room["session_id"]).join(
        token=room["guest"]["token"],
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    first, digest, wav_hash = _pcm_part(64)
    params = {
        "path": path,
        "take_index": 0,
        "segment_index": 0,
        "part_seq": 0,
        "sha256": digest,
        "file_sha256": wav_hash,
        "final": True,
        "kind": "room_tone",
    }
    res = client.post("/api/record/upload", params=params, content=first)
    assert res.status_code == 200, res.text
    assert res.json()["kind"] == "room_tone"
    status = client.get("/api/record/upload", params={"path": path})
    assert status.status_code == 200
    beds = status.json()["room_tone_status"]
    assert len(beds) == 1
    assert beds[0]["file_ack"] is True
    second, digest2, wav_hash2 = _pcm_part(80)
    replaced = client.post(
        "/api/record/upload",
        params={
            "path": path,
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest2,
            "file_sha256": wav_hash2,
            "final": True,
            "kind": "room_tone",
        },
        content=second,
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["file_ack"] is True
    revoked = client.delete(
        "/api/record/upload",
        params={"path": path, "kind": "room_tone"},
    )
    assert revoked.status_code == 200, revoked.text
    empty = client.get("/api/record/upload", params={"path": path})
    assert empty.json()["room_tone_status"] == []


def test_room_tone_replace_supersedes_acked_bed(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    first, digest, wav_hash = _pcm_part(48)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=digest,
        file_sha256=wav_hash,
        final=True,
        kind="room_tone",
    )
    second, digest2, wav_hash2 = _pcm_part(96)
    result = svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=second,
        digest=digest2,
        file_sha256=wav_hash2,
        final=True,
        kind="room_tone",
    )
    assert result["file_ack"] is True
    beds = svc.room_tone_status(session_id="room1")
    assert beds[0]["file_sha256"] == wav_hash2
    wav = (
        Path(ws.project.workspace_dir)
        / "artifacts"
        / "record"
        / "acked"
        / "room1"
        / "room_tone"
        / "p_aa.wav"
    )
    assert wav.read_bytes()[44:] == second


def test_acked_file_sha256_tracks_ack_generation(minimal_project, sample_wav):
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)

    assert (
        svc.acked_file_sha256(
            session_id="room1",
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id="p_aa",
            segment_index=0,
        )
        is None
    )

    first, digest, wav_hash = _pcm_part(48)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=first,
        digest=digest,
        file_sha256=wav_hash,
        final=True,
        kind="room_tone",
    )
    assert (
        svc.acked_file_sha256(
            session_id="room1",
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id="p_aa",
            segment_index=0,
        )
        == wav_hash
    )

    second, digest2, wav_hash2 = _pcm_part(96)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_aa",
        segment_index=0,
        part_seq=0,
        data=second,
        digest=digest2,
        file_sha256=wav_hash2,
        final=True,
        kind="room_tone",
    )
    assert (
        svc.acked_file_sha256(
            session_id="room1",
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id="p_aa",
            segment_index=0,
        )
        == wav_hash2
    )

    svc.revoke_room_tone("room1", "p_aa")
    assert (
        svc.acked_file_sha256(
            session_id="room1",
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id="p_aa",
            segment_index=0,
        )
        is None
    )

    keeper, kdigest, keeper_hash = _pcm_part(64)
    svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id="p_bb",
        segment_index=0,
        part_seq=0,
        data=keeper,
        digest=kdigest,
        file_sha256=keeper_hash,
        final=True,
    )
    assert (
        svc.acked_file_sha256(
            session_id="room1", take_index=0, participant_id="p_bb", segment_index=0
        )
        == keeper_hash
    )


def test_guest_keeper_upload_requires_take_consent(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    svc.join(
        token=token,
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    bea_pid, bea_lease = _guest_join(svc, room, name="Bea", conn="b1")
    _guest_consent(svc, bea_pid, name="Bea", accepted=True, seq=2)
    _host_cmd(svc, "Start", now=1000)

    ava_pid, ava_lease = _guest_join(svc, room, name="Ava", conn="a1")
    denied_ava = _post_keeper(client, token, ava_pid, ava_lease, take=0)
    assert denied_ava.status_code == 403, denied_ava.text
    assert denied_ava.json()["detail"] == "consent required"

    cal_pid, cal_lease = _guest_join(svc, room, name="Cal", conn="c1")
    _guest_consent(svc, cal_pid, name="Cal", accepted=False, seq=3)
    denied_cal = _post_keeper(client, token, cal_pid, cal_lease, take=0)
    assert denied_cal.status_code == 403

    ok_bea = _post_keeper(client, token, bea_pid, bea_lease, take=0)
    assert ok_bea.status_code == 200, ok_bea.text

    denied_take = _post_keeper(client, token, bea_pid, bea_lease, take=5)
    assert denied_take.status_code == 403

    _guest_consent(svc, ava_pid, name="Ava", accepted=True, seq=4)
    ok_ava = _post_keeper(client, token, ava_pid, ava_lease, take=0, segment=1)
    assert ok_ava.status_code == 200, ok_ava.text

    _host_cmd(svc, "Stop", now=2000)
    release_connection(bea_pid, "b1", hub_key=svc._hub_key)
    rejoin_pid, rejoin_lease = _guest_join(
        svc, room, name="Bea", conn="b2", pid=bea_pid, lease=bea_lease
    )
    ok_rejoin = _post_keeper(client, token, rejoin_pid, rejoin_lease, take=0, segment=2)
    assert ok_rejoin.status_code == 200, ok_rejoin.text


def test_guest_room_tone_upload_rejected_after_decline(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    _guest_consent(svc, pid, name="Ava", accepted=False, seq=2)
    pcm, digest, wav_hash = _pcm_part(96)
    res = client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": wav_hash,
            "final": True,
            "kind": "room_tone",
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )
    assert res.status_code == 403, res.text


def test_guest_keeper_upload_rejected_after_host_removal(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    svc.join(
        token=token,
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    _guest_consent(svc, pid, name="Ava", accepted=True, seq=2)
    _host_cmd(svc, "Start", now=1000)
    ok = _post_keeper(client, token, pid, lease, take=0)
    assert ok.status_code == 200, ok.text
    _host_cmd(svc, "RemoveParticipant", now=1500, payload={"participant_id": pid})
    assert not svc.verify_lease(pid, lease, token=token)
    status = client.get(
        f"/api/rec/{token}/upload",
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
    )
    assert status.status_code == 403, status.text
    assert status.json()["detail"] == "invalid lease"
    denied = _post_keeper(client, token, pid, lease, take=0, segment=1)
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"] == "invalid lease"


def test_removed_guest_fails_lease_check_if_revocation_is_interrupted(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    monkeypatch.setattr(svc._participants, "revoke", lambda *args, **kwargs: None)
    _host_cmd(svc, "RemoveParticipant", now=1500, payload={"participant_id": pid})
    assert svc._participants.verify(pid, lease, token=token, session_id=room["session_id"])
    denied = client.get(
        f"/api/rec/{token}/upload",
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"] == "invalid lease"


def test_remove_replay_revokes_only_persisted_target(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    ava, ava_lease = _guest_join(svc, room, name="Ava", conn="a1")
    bea, bea_lease = _guest_join(svc, room, name="Bea", conn="b1")

    def host_command(ctype: str, target: str, seq: int) -> None:
        svc.submit(
            RecordCommand.parse(
                command_type=ctype,
                payload={"participant_id": target} if ctype == "RemoveParticipant" else {},
                client_id="replay-host",
                role="host",
                participant_id="p_host",
                client_seq=seq,
            )
        )

    host_command("Heartbeat", ava, 10)
    host_command("RemoveParticipant", bea, 10)
    assert svc.verify_lease(bea, bea_lease, token=token)

    host_command("RemoveParticipant", ava, 11)
    host_command("RemoveParticipant", bea, 11)
    assert not svc.verify_lease(ava, ava_lease, token=token)
    assert svc.verify_lease(bea, bea_lease, token=token)


def test_guest_keeper_upload_rechecks_consent_after_body_read(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    svc.join(
        token=token,
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    _guest_consent(svc, pid, name="Ava", accepted=True, seq=2)
    _host_cmd(svc, "Start", now=1000)
    real_read = upload_http.read_body_capped

    async def _read_then_decline(request, limit):
        data = await real_read(request, limit)
        _guest_consent(svc, pid, name="Ava", accepted=False, seq=3)
        return data

    monkeypatch.setattr(upload_http, "read_body_capped", _read_then_decline)
    res = _post_keeper(client, token, pid, lease, take=0)
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "consent required"
    status = RecordUploadService(_ws.project).status(
        session_id=room["session_id"], participant_id=pid
    )
    assert status["segments"] == []


def test_guest_keeper_upload_rechecks_lease_after_body_read(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    svc = RecordSessionService(_ws.project, session_id=room["session_id"])
    svc.join(
        token=token,
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pid, lease = _guest_join(svc, room, name="Ava", conn="a1")
    _guest_consent(svc, pid, name="Ava", accepted=True, seq=2)
    _host_cmd(svc, "Start", now=1000)
    real_read = upload_http.read_body_capped

    async def _read_then_remove(request, limit):
        data = await real_read(request, limit)
        _host_cmd(svc, "RemoveParticipant", now=1500, payload={"participant_id": pid})
        return data

    monkeypatch.setattr(upload_http, "read_body_capped", _read_then_remove)
    res = _post_keeper(client, token, pid, lease, take=0)
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "invalid lease"
    status = RecordUploadService(_ws.project).status(
        session_id=room["session_id"], participant_id=pid
    )
    assert status["segments"] == []


def test_parse_clipping_regions() -> None:
    assert parse_clipping_regions("") == []
    assert parse_clipping_regions("100-250,1500-1600") == [[100, 250], [1500, 1600]]
    assert parse_clipping_regions("0-1,1-2") == [[0, 1], [1, 2]]
    bad = [
        "x" * 5000,
        "100",
        "a-b",
        "5-5",
        "9-3",
        "-1-5",
        f"0-{JOIN_OFFSET_MAX_MS + 1}",
        "10-20,15-30",
        "30-40,10-20",
        ",".join(f"{i * 2}-{i * 2 + 1}" for i in range(CLIPPING_MAX_REGIONS + 1)),
    ]
    for value in bad:
        with pytest.raises(RecordUploadError):
            parse_clipping_regions(value)


def _ingest_final(
    svc, pid="p_aa", *, clipping=None, clipping_truncated=False, seq=0, final=True, kind=None
):
    pcm, digest, wav_hash = _pcm_part(32)
    return svc.ingest_part(
        session_id="room1",
        take_index=0,
        participant_id=pid,
        segment_index=0,
        part_seq=seq,
        data=pcm,
        digest=digest,
        file_sha256=wav_hash if final else None,
        final=final,
        expected_parts=1 if final else None,
        clipping=clipping,
        clipping_truncated=clipping_truncated,
        kind=kind,
    )


def test_clipping_is_stored_on_the_final_part_and_shown_in_status(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc, clipping="100-250,1500-1600")
    row = svc.status(session_id="room1")["segments"][0]
    assert row["clipping_regions"] == [[100, 250], [1500, 1600]]
    file_row = svc._store.file_row(
        session_id="room1", take_index=0, participant_id="p_aa", segment_index=0
    )
    assert file_row is not None
    assert file_row["clipping_regions"] == [[100, 250], [1500, 1600]]


def test_clipping_absent_reads_as_none(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc)
    assert svc.status(session_id="room1")["segments"][0]["clipping_regions"] is None


def test_clipping_rejected_on_non_final_part_and_room_tone(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    with pytest.raises(RecordUploadError, match="final part"):
        _ingest_final(svc, clipping="1-2", final=False)
    with pytest.raises(RecordUploadError, match="room tone"):
        _ingest_final(svc, clipping="1-2", kind="room_tone")
    assert svc.status(session_id="room1")["segments"] == []


def test_clipping_truncated_is_stored_and_shown_in_status(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc, clipping="1-2", clipping_truncated=True)
    assert svc.status(session_id="room1")["segments"][0]["clipping_truncated"] is True
    file_row = svc._store.file_row(
        session_id="room1", take_index=0, participant_id="p_aa", segment_index=0
    )
    assert file_row is not None
    assert file_row["clipping_truncated"] is True


def test_clipping_truncated_defaults_false(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc, clipping="1-2")
    assert svc.status(session_id="room1")["segments"][0]["clipping_truncated"] is False


def test_clipping_truncated_needs_clipping_and_not_room_tone(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    with pytest.raises(RecordUploadError, match="needs clipping"):
        _ingest_final(svc, clipping_truncated=True)
    with pytest.raises(RecordUploadError, match="room tone"):
        _ingest_final(svc, clipping="1-2", clipping_truncated=True, kind="room_tone")


def test_clipping_truncated_replay_after_land(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc, clipping="1-2", clipping_truncated=True)
    svc.mark_landed(session_id="room1", take_index=0, participant_id="p_aa", segment_index=0)
    _ingest_final(svc, clipping="1-2", clipping_truncated=True)
    with pytest.raises(RecordUploadError, match="clipping_truncated refused after land"):
        _ingest_final(svc, clipping="1-2", clipping_truncated=False)


def test_clipping_refused_after_land(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    _ingest_final(svc, clipping="1-2")
    svc.mark_landed(session_id="room1", take_index=0, participant_id="p_aa", segment_index=0)
    with pytest.raises(RecordUploadError, match="clipping refused after land"):
        _ingest_final(svc, clipping="5-6")
    assert svc.status(session_id="room1")["segments"][0]["clipping_regions"] == [[1, 2]]


def test_final_part_replay_after_land_is_idempotent(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    svc = RecordUploadService(ws.project)
    pcm, digest, wav_hash = _pcm_part(32)
    part: dict[str, Any] = {
        "session_id": "room1",
        "take_index": 0,
        "participant_id": "p_aa",
        "segment_index": 0,
        "part_seq": 0,
        "data": pcm,
        "digest": digest,
        "file_sha256": wav_hash,
        "final": True,
        "expected_parts": 1,
        "join_offset_ms": 250,
        "clipping": "1-2",
    }
    svc.ingest_part(**part)
    svc.mark_landed(session_id="room1", take_index=0, participant_id="p_aa", segment_index=0)
    replay = svc.ingest_part(**part)
    assert replay["file_ack"] is True
    assert replay["landed"] is True
    assert replay["newly_acked"] is False
    row = svc.status(session_id="room1")["segments"][0]
    assert row["join_offset_ms"] == 250
    assert row["clipping_regions"] == [[1, 2]]
    with pytest.raises(RecordUploadError, match="join_offset refused after land"):
        svc.ingest_part(**{**part, "join_offset_ms": 500})
    with pytest.raises(RecordUploadError, match="clipping refused after land"):
        svc.ingest_part(**{**part, "clipping": "5-6"})


def test_old_upload_db_gains_the_clipping_column(tmp_path: Path):
    import sqlite3

    from podcast_mcp.services.record.upload import RecordUploadStore

    db = tmp_path / "sync.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE record_upload_files (session_id TEXT NOT NULL, take_index INTEGER NOT NULL,"
        " participant_id TEXT NOT NULL, segment_index INTEGER NOT NULL, file_sha256 TEXT,"
        " byte_length INTEGER, expected_parts INTEGER, acked_ns INTEGER, join_offset_ms INTEGER,"
        " landed_ns INTEGER, land_failed_ns INTEGER,"
        " PRIMARY KEY (session_id, take_index, participant_id, segment_index))"
    )
    conn.commit()
    conn.close()
    store = RecordUploadStore(db)
    store.set_clipping_regions(
        session_id="s", take_index=0, participant_id="p_a", segment_index=0, regions=[[1, 2]]
    )
    store.set_clipping_truncated(
        session_id="s", take_index=0, participant_id="p_a", segment_index=0, truncated=True
    )
    store.close()


def test_clipping_replay_after_land_compares_values_not_json_text(tmp_path: Path):
    from podcast_mcp.services.record.upload import RecordUploadStore

    store = RecordUploadStore(tmp_path / "sync.db")
    key: dict[str, Any] = {
        "session_id": "s",
        "take_index": 0,
        "participant_id": "p_a",
        "segment_index": 0,
    }
    store.set_clipping_regions(**key, regions=[[1, 2]])
    # Stored with different spacing (compact separators), then landed.
    store._conn.execute(
        "UPDATE record_upload_files SET clipping_regions = ?, landed_ns = 1", ("[[1,2]]",)
    )
    store.set_clipping_regions(**key, regions=[[1, 2]])  # identical replay: no-op
    with pytest.raises(RecordUploadError, match="clipping refused after land"):
        store.set_clipping_regions(**key, regions=[[1, 3]])
    store.close()


def test_clipping_truncated_null_on_landed_row_replays_as_false(tmp_path: Path):
    from podcast_mcp.services.record.upload import RecordUploadStore

    store = RecordUploadStore(tmp_path / "sync.db")
    key: dict[str, Any] = {
        "session_id": "s",
        "take_index": 0,
        "participant_id": "p_a",
        "segment_index": 0,
    }
    store.set_clipping_regions(**key, regions=[[1, 2]])
    # A row landed before the column existed (or before the flag was written) stores NULL.
    store._conn.execute("UPDATE record_upload_files SET clipping_truncated = NULL, landed_ns = 1")
    store.set_clipping_truncated(**key, truncated=False)  # identical replay: no-op
    with pytest.raises(RecordUploadError, match="clipping_truncated refused after land"):
        store.set_clipping_truncated(**key, truncated=True)
    store.close()


def test_http_rejects_bad_clipping_with_400(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    RecordSessionService(ws.project, session_id=room["session_id"]).join(
        token=room["guest"]["token"],
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    pcm, digest, wav_hash = _pcm_part(64)
    params = {
        "path": str(minimal_project),
        "take_index": 0,
        "segment_index": 0,
        "part_seq": 0,
        "sha256": digest,
        "file_sha256": wav_hash,
        "final": True,
        "expected_parts": 1,
        "clipping": "20-10",
    }
    res = client.post("/api/record/upload", params=params, content=pcm)
    assert res.status_code == 400, res.text
    params["clipping"] = "10-20"
    res = client.post("/api/record/upload", params=params, content=pcm)
    assert res.status_code == 200, res.text
    status = client.get("/api/record/upload", params={"path": str(minimal_project)})
    assert status.json()["segments"][0]["clipping_regions"] == [[10, 20]]


def test_land_rollbacks_defer_list_clear_and_survive_revoke(tmp_path):
    store = RecordUploadStore(tmp_path / "sync.db")
    key = LandRollbackKey("s1", 0, "p_a", 0, "aa")
    store.defer_land_rollback(key, raw_rel="r/one.wav", raw_revision=[1, 2], prior_json="{}")
    store.defer_land_rollback(key, raw_rel="r/other.wav", raw_revision=[9], prior_json="{1}")
    store.defer_land_rollback(
        LandRollbackKey("s1", 0, "p_a", 1, "bb"),
        raw_rel="r/two.wav",
        raw_revision=[3],
        prior_json="{}",
    )
    store.defer_land_rollback(
        LandRollbackKey("s2", 0, "p_a", 0, "aa"), raw_rel="x.wav", raw_revision=[], prior_json="{}"
    )
    rows = store.land_rollbacks(session_id="s1")
    assert [r["raw_rel"] for r in rows] == ["r/one.wav", "r/two.wav"]
    assert json.loads(rows[0]["raw_revision"]) == [1, 2]
    assert rows[0]["prior_json"] == "{}"
    store.delete_segment(session_id="s1", take_index=0, participant_id="p_a", segment_index=0)
    assert len(store.land_rollbacks(session_id="s1")) == 2
    store.clear_land_rollback(key)
    assert [r["raw_rel"] for r in store.land_rollbacks(session_id="s1")] == ["r/two.wav"]
    assert len(store.land_rollbacks(session_id="s2")) == 1


def test_land_rollback_failure_is_counted_and_backs_off(tmp_path):
    store = RecordUploadStore(tmp_path / "sync.db")
    key = LandRollbackKey("s1", 0, "p_a", 0, "aa")
    store.defer_land_rollback(key, raw_rel="r/one.wav", raw_revision=[], prior_json="{}")
    store.note_land_rollback_failure(key, retry_after_ns=123)
    store.note_land_rollback_failure(key, retry_after_ns=123)
    (row,) = store.land_rollbacks(session_id="s1")
    assert row["attempts"] == 2
    assert row["retry_after_ns"] == 123


def test_land_rollbacks_purged_on_take_tombstone_and_session_clear(tmp_path):
    store = RecordUploadStore(tmp_path / "sync.db")
    for take in (0, 1, ROOM_TONE_TAKE_INDEX):
        store.defer_land_rollback(
            LandRollbackKey("s1", take, "p_a", 0, "aa"),
            raw_rel="r/x.wav",
            raw_revision=[],
            prior_json="{}",
        )
    store.tombstone_take("s1", 0)
    rows = store.land_rollbacks(session_id="s1")
    assert sorted(int(r["take_index"]) for r in rows) == sorted([1, ROOM_TONE_TAKE_INDEX])
    assert store.clear_session_land_rollbacks("s1") == 2
    assert store.land_rollbacks(session_id="s1") == []
