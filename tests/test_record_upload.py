"""Record keeper chunk upload + resume ACK."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.service import RecordSessionService, reset_record_runtime_for_tests
from podcast_mcp.services.record.upload import (
    JOIN_OFFSET_MAX_MS,
    ROOM_TONE_MAX_PCM_BYTES,
    RecordUploadError,
    RecordUploadService,
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
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
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
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
        pcm, digest, wav_hash = _pcm_part(48)
        res = client.post(
            f"/api/rec/{token}/upload",
            params={
                "take_index": 0,
                "segment_index": 0,
                "part_seq": 0,
                "sha256": digest,
                "file_sha256": wav_hash,
                "final": True,
                "expected_parts": 1,
            },
            headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
            content=pcm,
        )
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
