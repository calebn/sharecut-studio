"""Record landing: raw/ clips, take gap, join offsets, skip ingest suggest."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from filelock import FileLock

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import SourceClippingRegion, load_project, save_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.landing import (
    _LAND_LOCKS,
    RecordLandingError,
    RecordLandingService,
    _upsert_source,
    measure_keeper_drifts,
    record_land_lock_path,
    release_session_land_lock,
    remove_session_land_lock_file,
    wav_pcm_info,
)
from podcast_mcp.services.record.landing_math import (
    ALIGN_DRIFT_MS,
    DRIFT_WINDOW_S,
    TAKE_GAP_MS,
    clip_timeline_s,
    duration_error_ms,
    duration_s,
    expected_span_s,
    needs_align_fallback,
    origin_pad_samples,
    overlap_window_s,
    pad_samples,
    take_offsets_s,
)
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.state import (
    HOST_PARTICIPANT_ID,
    PauseEntry,
    TakeState,
    take_recording_duration_ms,
)
from podcast_mcp.services.record.upload import (
    KEEPER_SAMPLE_RATE,
    RecordUploadService,
    sha256_hex,
)
from podcast_mcp.services.share import ShareService
from podcast_mcp.util.wav import pcm_wav_header


def _isolate() -> None:
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


def _ack_pcm(
    uploader: RecordUploadService,
    *,
    session_id: str,
    take: int,
    pid: str,
    segment: int,
    join_offset_ms: int,
    pcm: bytes,
    clipping: str | None = None,
    clipping_truncated: bool = False,
) -> None:
    wav = pcm_wav_header(len(pcm)) + pcm
    uploader.ingest_part(
        session_id=session_id,
        take_index=take,
        participant_id=pid,
        segment_index=segment,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        expected_parts=1,
        join_offset_ms=join_offset_ms,
        clipping=clipping,
        clipping_truncated=clipping_truncated,
    )


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
    pcm, _digest, _file_hash = _pcm(nbytes)
    _ack_pcm(
        uploader,
        session_id=session_id,
        take=take,
        pid=pid,
        segment=segment,
        join_offset_ms=join_offset_ms,
        pcm=pcm,
    )


def _noise_pcm(*, duration_s: float = 2.0, delay_ms: float = 0.0, sr: int = 48_000) -> bytes:
    rng = np.random.default_rng(0)
    n = int(duration_s * sr)
    sig = 0.4 * rng.normal(size=n)
    delay = round(delay_ms * sr / 1000.0)
    if delay > 0:
        sig = np.concatenate([np.zeros(delay), sig[: n - delay]])
    elif delay < 0:
        d = -delay
        sig = np.concatenate([sig[d:], np.zeros(d)])
    pcm = np.clip(np.round(sig * 32767.0), -32767, 32767).astype("<i2")
    return pcm.tobytes()


def _cmd(ctype: str, *, pid: str = "p_host", payload: dict | None = None, seq: int | None = None):
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id="cli",
        role="host",
        participant_id=pid,
        client_seq=seq if seq is not None else next_record_client_seq(),
    )


def _consent_guest(ws, room):
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
    return svc, echo["participant_id"], echo["lease"]


def _consent_room(ws, room):
    svc, pid, _lease = _consent_guest(ws, room)
    return svc, pid


def _race_on_commit(monkeypatch, *, when, race):
    """Run *race* once, right before the first ``ProjectStore.commit`` whose
    project satisfies *when*.

    ``run_mutation`` commits exactly once, after ``mutate`` runs, so by the
    time this fires the project already reflects that mutation's in-memory
    changes but the commit has not yet reached disk -- the window where a
    concurrent re-ACK or revoke can change the upload row landing already
    checked (#366).
    """
    from podcast_mcp.project_store import ProjectStore

    original_commit = ProjectStore.commit
    fired = {"done": False}

    def patched(self, project):
        if not fired["done"] and when(project):
            fired["done"] = True
            race()
        return original_commit(self, project)

    monkeypatch.setattr(ProjectStore, "commit", patched)


def test_pad_math_late_join_and_later_segments() -> None:
    assert pad_samples(10_000) == 480_000
    assert abs(pad_samples(10_000) - 10_000 * KEEPER_SAMPLE_RATE / 1000) <= 1
    assert origin_pad_samples(segment_index=0, join_offset_ms=10_000) == 480_000
    assert origin_pad_samples(segment_index=1, join_offset_ms=10_000) == 0
    assert duration_s(48_000) == 1.0
    assert duration_s(0) == 0.0
    assert duration_s(10, 0) == 0.0
    assert clip_timeline_s(0.0, 10_000) == 10.0
    assert expected_span_s(0, take_duration_ms=2_000) == 2.0
    assert expected_span_s(1_000, take_duration_ms=2_000, next_join_offset_ms=1_500) == 0.5
    assert expected_span_s(2_000, take_duration_ms=2_000) == 0.0
    assert duration_error_ms(1.0, 1.0) == 0.0
    assert duration_error_ms(0.5, 2.0) == pytest.approx(-1_500.0)
    assert duration_error_ms(1.0, 0.0) is None


def test_take_offsets_include_gap_and_skip_tombstones() -> None:
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=5_000,
        ),
        TakeState(
            take_index=1,
            session_start_wall_ms=8_000,
            session_start_iso="t1",
            stopped_wall_ms=9_000,
        ),
    ]
    assert take_recording_duration_ms(takes[0]) == 5_000
    assert (
        take_recording_duration_ms(
            TakeState(take_index=2, session_start_wall_ms=0, session_start_iso="open")
        )
        == 0
    )
    offsets = take_offsets_s(takes)
    assert offsets[0] == 0.0
    assert offsets[1] == pytest.approx(5.0 + TAKE_GAP_MS / 1000)
    skipped = take_offsets_s(takes, tombstoned={0})
    assert skipped[1] == 0.0


def test_paused_span_does_not_consume_take_offset() -> None:
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=10_000,
            pauses=[PauseEntry(seq=1, pause_wall_ms=4_000, resume_wall_ms=9_000)],
        ),
        TakeState(
            take_index=1,
            session_start_wall_ms=12_000,
            session_start_iso="t1",
            stopped_wall_ms=13_000,
        ),
    ]
    assert take_recording_duration_ms(takes[0]) == 5_000
    assert take_offsets_s(takes)[1] == pytest.approx(5.0 + TAKE_GAP_MS / 1000)


def test_wav_pcm_info_rejects_junk(tmp_path: Path) -> None:
    path = tmp_path / "x.wav"
    path.write_bytes(b"not a wav")
    with pytest.raises(RecordLandingError, match="invalid keeper wav"):
        wav_pcm_info(path)
    import wave

    packed24 = tmp_path / "i24.wav"
    with wave.open(str(packed24), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(3)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00\x01" * 16)
    with pytest.raises(RecordLandingError, match="invalid keeper wav"):
        wav_pcm_info(packed24)


def test_align_fallback_missing_session_start_or_drift() -> None:
    missing = [
        TakeState(take_index=0, session_start_wall_ms=0, session_start_iso=""),
    ]
    present = [
        TakeState(
            take_index=0, session_start_wall_ms=1, session_start_iso="2026-01-01T00:00:00+00:00"
        ),
    ]
    assert needs_align_fallback(missing) is True
    assert needs_align_fallback(present) is False
    assert needs_align_fallback(present, drift_ms=ALIGN_DRIFT_MS) is False
    assert needs_align_fallback(present, drift_ms=ALIGN_DRIFT_MS + 1) is True


def test_land_late_join_clip_skips_ingest_suggest(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=12_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=10_000,
        nbytes=960,
    )
    aligns: list[int] = []
    waveforms: list[str] = []
    monkeypatch.setattr(
        "podcast_mcp.services.record.landing.schedule_track_waveforms",
        lambda _project, track: waveforms.append(track.id),
    )
    result = RecordLandingService(ws).land(align=lambda _p: aligns.append(1))
    assert waveforms == [result["clips"][0]["track_id"]]
    assert result["ingest_suggest"] is False
    assert result["align_fallback"] is False
    assert aligns == []
    clips = result["clips"]
    assert len(clips) == 1
    assert clips[0]["timeline_start"] == pytest.approx(10.0)
    assert abs(clips[0]["timeline_start"] - 10.0) <= 1 / KEEPER_SAMPLE_RATE
    raw = Path(ws.project.workspace_dir) / clips[0]["raw_path"]
    assert raw.is_file()
    assert raw.parent.name == "raw"
    track_clips = [c for c in ws.project.clips if c.track_id == clips[0]["track_id"]]
    assert len(track_clips) == 1
    assert track_clips[0].source_start == 0.0
    assert track_clips[0].source_end == pytest.approx(duration_s(480))


def test_leave_rejoin_two_clips_one_track(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=400_000)
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
        join_offset_ms=340_000,
        nbytes=480,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    clips = sorted(result["clips"], key=lambda row: row["segment_index"])
    assert len(clips) == 2
    assert clips[0]["track_id"] == clips[1]["track_id"]
    assert clips[1]["timeline_start"] == pytest.approx(340.0)
    assert abs(clips[1]["timeline_start"] - 340.0) <= 1 / KEEPER_SAMPLE_RATE
    guest_clips = [c for c in ws.project.clips if c.track_id == clips[0]["track_id"]]
    assert len(guest_clips) == 2
    track = ws.project.track_by_id(clips[0]["track_id"])
    assert track is not None and track.media is not None
    assert track.media.path == clips[0]["raw_path"]


def test_second_take_lands_after_gap_while_first_still_uploading(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=5_000)
    svc.submit(_cmd("Start"), now_wall_ms=6_000)
    svc.submit(_cmd("Stop"), now_wall_ms=7_000)
    uploader = RecordUploadService(ws.project)
    pcm, digest, _ = _pcm(200)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=1,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        nbytes=480,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert len(result["clips"]) == 1
    assert result["clips"][0]["take_index"] == 1
    assert result["clips"][0]["timeline_start"] == pytest.approx(5.0 + TAKE_GAP_MS / 1000)


def test_union_tracks_and_absent_participant(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    svc.submit(_cmd("Start"), now_wall_ms=4_000)
    svc.submit(_cmd("Stop"), now_wall_ms=5_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid="p_host",
        segment=0,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=1,
        pid="p_host",
        segment=0,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=1,
        pid="p_bb",
        segment=0,
        join_offset_ms=0,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    tracks = {row["track_id"] for row in result["clips"]}
    assert len(tracks) == 3
    guest_take2 = [
        row
        for row in result["clips"]
        if row["track_id"] == slug_of(guest) and row["take_index"] == 1
    ]
    assert guest_take2 == []


def slug_of(pid: str) -> str:
    from podcast_mcp.edits.track_ids import slug_track_id

    return slug_track_id(pid)


def test_refuse_delete_while_non_terminal_then_tombstone_resets_offset(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=4_000)
    svc.submit(_cmd("Start"), now_wall_ms=5_000)
    svc.submit(_cmd("Stop"), now_wall_ms=6_000)
    uploader = RecordUploadService(ws.project)
    pcm, digest, _ = _pcm(200)
    wav_hash = sha256_hex(pcm_wav_header(len(pcm)) + pcm)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        join_offset_ms=0,
    )
    landing = RecordLandingService(ws)
    with pytest.raises(RecordLandingError, match="not terminal"):
        landing.delete_take(0)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=wav_hash,
        final=True,
        expected_parts=1,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=1,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    out = RecordLandingService(ws).delete_take(0)
    assert out["discarded_take"] == 0
    take1 = [row for row in out["clips"] if row["take_index"] == 1]
    assert take1
    assert take1[0]["timeline_start"] == pytest.approx(0.0)
    status = uploader.status(session_id=room["session_id"])
    assert all(int(row["take_index"]) != 0 for row in status["segments"])


def test_http_final_ack_copies_into_raw(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app())
    token = room["guest"]["token"]
    svc, pid, lease = _consent_guest(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    pcm, digest, file_hash = _pcm(480)
    res = client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": file_hash,
            "final": "true",
            "expected_parts": 1,
            "join_offset_ms": 250,
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["file_ack"] is True
    assert body.get("landed") is True
    clips = body.get("clips") or []
    assert clips
    assert clips[0]["timeline_start"] == pytest.approx(0.25)
    raw = Path(ws.project.workspace_dir) / clips[0]["raw_path"]
    assert raw.is_file()
    reloaded = load_project(minimal_project)
    assert any(abs(c.timeline_start - 0.25) < 1e-9 for c in reloaded.clips)


def test_cli_land_and_mcp_registered(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app as cli_app
    from podcast_mcp.mcp.tools.record import record_land_tool

    runner = CliRunner()
    result = runner.invoke(cli_app, ["record", "land", "--project", str(minimal_project)])
    assert result.exit_code == 0, result.output
    assert "clips" in result.output
    payload = record_land_tool(str(minimal_project))
    assert "clips" in payload
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import record as record_tools

    mcp = MCPServer("t")
    record_tools.register(mcp)
    names = {t.name for t in mcp._tool_manager.list_tools()}
    assert "record_land_tool" in names
    assert "record_discard_take_tool" in names
    ctrl = RecordControlService(ws)
    again = ctrl.land()
    assert again["ingest_suggest"] is False
    assert again["clips"] == []


def test_refuse_delete_while_take_open(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    with pytest.raises(RecordLandingError, match="still open"):
        RecordLandingService(ws).delete_take(0)
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app as cli_app

    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        ["record", "discard-take", "--project", str(minimal_project), "--take-index", "0"],
    )
    assert result.exit_code == 1
    assert "still open" in result.output


def test_align_fallback_does_not_invoke_conversation_align(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    called: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        lambda project: called.append(project),
    )
    result = RecordLandingService(ws).land(drift_ms=ALIGN_DRIFT_MS + 1)
    assert result["align_fallback"] is True
    assert result["drift_ms"] == ALIGN_DRIFT_MS + 1
    assert not called


def test_producer_keeper_is_not_landed(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    prod, _snap = svc.join(
        token=room["producer"]["token"],
        role="producer",
        display_name="Pat",
        client_id="rec-prod",
        connection_id="c-prod",
        capabilities=["monitor"],
        client_seq=next_record_client_seq(),
    )
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=prod["participant_id"],
        segment=0,
        join_offset_ms=0,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    tracks = {row["track_id"] for row in result["clips"]}
    assert slug_of(guest) in tracks
    assert slug_of(prod["participant_id"]) not in tracks
    status = uploader.status(session_id=room["session_id"])
    prod_rows = [
        row for row in status["segments"] if row["participant_id"] == prod["participant_id"]
    ]
    assert prod_rows
    assert all(row["landed"] for row in prod_rows)


def test_land_without_room_and_missing_acked_wav(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    with pytest.raises(FileNotFoundError, match="no active record room"):
        RecordLandingService(ws)
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app as cli_app

    runner = CliRunner()
    missing = runner.invoke(cli_app, ["record", "land", "--project", str(minimal_project)])
    assert missing.exit_code == 1
    client = TestClient(create_app())
    assert client.post("/api/record/land", params={"path": str(minimal_project)}).status_code == 404
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    from podcast_mcp.mcp.tools.record import record_discard_take_tool

    with pytest.raises(RecordLandingError, match="still open"):
        record_discard_take_tool(str(minimal_project), 0)
    refused = client.post(
        "/api/record/discard-take",
        json={"path": str(minimal_project), "take_index": 0},
    )
    assert refused.status_code == 400
    svc.submit(_cmd("Stop"), now_wall_ms=500)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    acked = uploader.acked_wav(room["session_id"], 0, guest, 0)
    acked.unlink()
    skipped = RecordLandingService(ws).land(align=lambda _p: None)
    assert skipped["clips"] == []
    status = uploader.status(session_id=room["session_id"])
    guest_rows = [row for row in status["segments"] if row["participant_id"] == guest]
    assert guest_rows
    assert all(row["land_failed"] and not row["landed"] for row in guest_rows)
    land = client.post("/api/record/land", params={"path": str(minimal_project)})
    assert land.status_code == 200
    assert land.json()["clips"] == []
    status_after = uploader.status(session_id=room["session_id"])
    guest_rows_after = [row for row in status_after["segments"] if row["participant_id"] == guest]
    assert guest_rows_after
    assert all(row["land_failed"] and not row["landed"] for row in guest_rows_after)


def test_concurrent_land_keeps_one_clip(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    results: list[dict] = []

    def _go() -> None:
        results.append(RecordLandingService(ws).land(align=lambda _p: None))

    workers = [threading.Thread(target=_go) for _ in range(2)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    landed = [clip for row in results for clip in row["clips"]]
    assert sum(1 for row in results if row["clips"]) == 1
    rec_clips = [clip for clip in ws.project.clips if clip.source_id.startswith("rec-")]
    assert len(rec_clips) == 1
    assert len(landed) == 1


def test_land_waits_for_cross_process_land_lock(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A land holding the workspace land lock in another process blocks this land (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    # A separate FileLock instance opens its own OS lock, as another process would.
    other = FileLock(
        str(record_land_lock_path(ws.project.workspace_path(), room["session_id"])),
        thread_local=False,
    )
    other.acquire()
    results: list[dict] = []
    worker = threading.Thread(
        target=lambda: results.append(RecordLandingService(ws).land(align=lambda _p: None))
    )
    try:
        worker.start()
        worker.join(timeout=0.5)
        assert worker.is_alive()
        assert results == []
    finally:
        other.release()
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert [clip["participant_id"] for clip in results[0]["clips"]] == [guest]


def test_land_times_out_on_held_cross_process_land_lock(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A held land lock times out with 'land in progress' and leaks nothing (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    monkeypatch.setattr("podcast_mcp.services.record.landing.RECORD_LAND_LOCK_TIMEOUT_SEC", 0.1)
    other = FileLock(
        str(record_land_lock_path(ws.project.workspace_path(), room["session_id"])),
        thread_local=False,
    )
    other.acquire()
    try:
        with pytest.raises(RecordLandingError, match="land in progress"):
            RecordLandingService(ws).land(align=lambda _p: None)
    finally:
        other.release()
    clips = RecordLandingService(ws).land(align=lambda _p: None)["clips"]
    assert [clip["participant_id"] for clip in clips] == [guest]


def test_discard_waits_for_cross_process_land_lock(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A discard waits on another process's land lock too, like land (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    other = FileLock(
        str(record_land_lock_path(ws.project.workspace_path(), room["session_id"])),
        thread_local=False,
    )
    other.acquire()
    results: list[dict] = []
    worker = threading.Thread(
        target=lambda: results.append(RecordLandingService(ws).delete_take(0))
    )
    try:
        worker.start()
        worker.join(timeout=0.5)
        assert worker.is_alive()
        assert results == []
    finally:
        other.release()
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert len(results) == 1
    assert ws.project.track_by_id(slug_of(guest)) is None


def test_revoke_room_removes_land_lock_file(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Revoking a room deletes its land lock file (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    lock = record_land_lock_path(ws.project.workspace_path(), room["session_id"])
    assert lock.exists()
    ShareService(ws).revoke_room(room["session_id"])
    assert not lock.exists()


def test_remove_session_land_lock_file_skips_held_and_missing(tmp_path):
    path = record_land_lock_path(tmp_path, "s1")
    remove_session_land_lock_file(tmp_path, "s1")
    path.parent.mkdir(parents=True)
    other = FileLock(str(path), thread_local=False)
    other.acquire()
    remove_session_land_lock_file(tmp_path, "s1")
    assert path.exists()
    other.release()
    remove_session_land_lock_file(tmp_path, "s1")
    assert not path.exists()


def test_landing_services_rebind_after_reload(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Cached services are rebuilt when the workspace swaps its project object (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _consent_room(ws, room)
    svc = RecordLandingService(ws)
    assert svc._upload is svc._upload
    assert svc._room is svc._room
    before_upload, before_room = svc._upload, svc._room
    ws._loaded_file_signature = None  # force a real reload, as after another writer's save
    ws.reload()
    assert svc._upload is not before_upload
    assert svc._room is not before_room
    assert svc._upload._project is ws.project
    assert svc._room.project is ws.project


def test_land_on_stale_workspace_keeps_earlier_land(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A land whose workspace predates another land's commit keeps that land (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(
        _cmd(
            "Comment",
            payload={
                "id": "live-host-marker",
                "take_index": 0,
                "recording_ms": 0,
                "pressed_wall_ms": 500,
                "body": "Marker",
            },
        ),
        now_wall_ms=600,
    )
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    # Opened before any land, like an upload request still reading its body.
    stale = ProjectWorkspace.open(minimal_project)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
    )
    first = RecordLandingService(ws).land(align=lambda _p: None)
    assert [row["id"] for row in first["comments"]] == ["live-host-marker"]
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    before = stale.project
    lander = RecordLandingService(stale)
    second = lander.land(align=lambda _p: None)
    assert stale.project is not before  # the land re-read the saved project
    assert lander._room.project is stale.project
    assert [clip["participant_id"] for clip in second["clips"]] == [guest]
    saved = load_project(minimal_project)
    assert [comment.id for comment in saved.comments] == ["live-host-marker"]
    landed_tracks = {clip.track_id for clip in saved.clips if clip.source_id.startswith("rec-")}
    assert len(landed_tracks) == 2


def test_land_discards_unsaved_workspace_edits(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Land re-reads the saved project, so unsaved edits on the workspace are dropped (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.project.meta.name = "unsaved rename"
    # Another writer commits, so the saved file is newer than this workspace's copy.
    ProjectWorkspace.open(minimal_project).mutate("b", "a", lambda p: None)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    second = RecordLandingService(ws).land(align=lambda _p: None)
    assert [clip["participant_id"] for clip in second["clips"]] == [guest]
    assert ws.project.meta.name != "unsaved rename"
    assert load_project(minimal_project).meta.name != "unsaved rename"


def test_land_keeps_commit_made_during_copy_phase(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Another writer committing between the raw copy and the land mutation is kept (#503)."""
    from podcast_mcp.edits.comments import add_comment
    from podcast_mcp.services.record import landing as landing_module

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    original_copy = landing_module._copy_into_raw
    fired = {"done": False}

    def copy_then_commit(*args, **kwargs):
        result = original_copy(*args, **kwargs)
        if not fired["done"]:
            fired["done"] = True
            other = ProjectWorkspace.open(minimal_project)
            other.mutate(
                "before note",
                "after note",
                lambda project: add_comment(
                    project,
                    body="Concurrent note",
                    author="editor",
                    timeline_start=0.5,
                    comment_id="concurrent-note",
                ),
            )
        return result

    monkeypatch.setattr(landing_module, "_copy_into_raw", copy_then_commit)
    out = RecordLandingService(ws).land(align=lambda _p: None)
    assert fired["done"]
    assert [clip["participant_id"] for clip in out["clips"]] == [guest]
    saved = load_project(minimal_project)
    assert "concurrent-note" in {comment.id for comment in saved.comments}
    assert any(clip.source_id.startswith("rec-") for clip in saved.clips)
    assert "concurrent-note" in {comment.id for comment in ws.project.comments}


def test_missing_acked_with_source_in_raw_stays_landed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    first = RecordLandingService(ws).land(align=lambda _p: None)
    raw = Path(ws.project.workspace_dir) / first["clips"][0]["raw_path"]
    assert raw.is_file()

    uploader.acked_wav(room["session_id"], 0, guest, 0).unlink()
    # Stand-in for RecordUploadStore.tombstone_take clearing landed_ns on the session's
    # remaining rows after its first take discard. mark_land_failed also sets
    # land_failed_ns, but _gate_acked only reads landed_ns, so the missing-acked branch
    # runs the same way.
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["clips"] == []
    row = next(
        r
        for r in uploader.status(session_id=room["session_id"])["segments"]
        if r["participant_id"] == guest
    )
    assert row["landed"] is True
    assert row["land_failed"] is False
    assert raw.is_file()

    raw.unlink()
    # Stand-in for RecordUploadStore.tombstone_take clearing landed_ns on the session's
    # remaining rows after its first take discard. mark_land_failed also sets
    # land_failed_ns, but _gate_acked only reads landed_ns, so the missing-acked branch
    # runs the same way.
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )
    again2 = RecordLandingService(ws).land(align=lambda _p: None)
    assert again2["clips"] == []
    row2 = next(
        r
        for r in uploader.status(session_id=room["session_id"])["segments"]
        if r["participant_id"] == guest
    )
    assert row2["landed"] is False
    assert row2["land_failed"] is True


def test_concurrent_land_with_missing_acked_is_deterministic(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    first = RecordLandingService(ws).land(align=lambda _p: None)
    raw = Path(ws.project.workspace_dir) / first["clips"][0]["raw_path"]
    uploader.acked_wav(room["session_id"], 0, guest, 0).unlink()

    def _race() -> tuple[list[dict], dict]:
        # Stand-in for RecordUploadStore.tombstone_take clearing landed_ns on the session's
        # remaining rows after its first take discard. mark_land_failed also sets
        # land_failed_ns, but _gate_acked only reads landed_ns, so the missing-acked branch
        # runs the same way.
        uploader.mark_land_failed(
            session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
        )
        results: list[dict] = []

        def _go() -> None:
            results.append(RecordLandingService(ws).land(align=lambda _p: None))

        workers = [threading.Thread(target=_go) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        row = next(
            r
            for r in uploader.status(session_id=room["session_id"])["segments"]
            if r["participant_id"] == guest
        )
        return results, row

    results, row = _race()
    assert len(results) == 2
    assert all(r["clips"] == [] for r in results)
    assert row["landed"] is True
    assert row["land_failed"] is False

    raw.unlink()
    results, row = _race()
    assert len(results) == 2
    assert all(r["clips"] == [] for r in results)
    assert row["landed"] is False
    assert row["land_failed"] is True


def test_missing_acked_rerecorded_room_tone_does_not_reuse_old_bed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX
    from podcast_mcp.util.hashing import sha256_file

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)

    def _ingest_bed(nbytes: int) -> str:
        pcm, digest, file_hash = _pcm(nbytes)
        uploader.ingest_part(
            session_id=room["session_id"],
            take_index=0,
            participant_id=guest,
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=file_hash,
            final=True,
            kind="room_tone",
        )
        return file_hash

    hash_a = _ingest_bed(480)
    RecordLandingService(ws).land(align=lambda _p: None)
    bed = Path(ws.project.workspace_dir) / "raw" / "room-tone" / room["session_id"] / f"{guest}.wav"
    assert sha256_file(bed) == hash_a

    hash_b = _ingest_bed(960)
    assert hash_b != hash_a
    assert uploader.room_tone_status(session_id=room["session_id"])[0]["landed"] is False
    uploader.acked_wav(room["session_id"], ROOM_TONE_TAKE_INDEX, guest, 0).unlink()

    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["clips"] == []
    beds = uploader.room_tone_status(session_id=room["session_id"])
    assert beds[0]["landed"] is False
    assert beds[0]["land_failed"] is True
    assert sha256_file(bed) == hash_a


def test_missing_acked_unreadable_source_marks_land_failed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    RecordLandingService(ws).land(align=lambda _p: None)
    uploader.acked_wav(room["session_id"], 0, guest, 0).unlink()
    # Stand-in for tombstone_take clearing landed_ns (mark_land_failed also sets
    # land_failed_ns); see test_missing_acked_with_source_in_raw_stays_landed.
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )

    def _boom(_path: Path) -> str:
        raise OSError("unreadable")

    monkeypatch.setattr("podcast_mcp.services.record.landing.sha256_file", _boom)
    RecordLandingService(ws).land(align=lambda _p: None)
    row = next(
        r
        for r in uploader.status(session_id=room["session_id"])["segments"]
        if r["participant_id"] == guest
    )
    assert row["landed"] is False
    assert row["land_failed"] is True


def test_missing_acked_source_removed_during_hash_stays_failed(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.util.hashing import sha256_file

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    first = RecordLandingService(ws).land(align=lambda _p: None)
    uploader.acked_wav(room["session_id"], 0, guest, 0).unlink()
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )

    def remove_source_during_check(path: Path) -> str:
        digest = sha256_file(path)
        ws.mutate(
            "before source removal",
            "after source removal",
            lambda project: setattr(project, "sources", []),
        )
        return digest

    monkeypatch.setattr(
        "podcast_mcp.services.record.landing.sha256_file", remove_source_during_check
    )
    assert RecordLandingService(ws).land(align=lambda _p: None)["clips"] == []
    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["landed"] is False
    assert row["land_failed"] is True
    assert (Path(ws.project.workspace_dir) / first["clips"][0]["raw_path"]).is_file()


def test_missing_acked_source_removed_by_another_writer_during_hash_stays_failed(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.util.hashing import sha256_file

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    first = RecordLandingService(ws).land(align=lambda _p: None)
    uploader.acked_wav(room["session_id"], 0, guest, 0).unlink()
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )

    def remove_source_during_check(path: Path) -> str:
        digest = sha256_file(path)
        ProjectWorkspace.open(minimal_project).mutate(
            "before source removal",
            "after source removal",
            lambda project: setattr(project, "sources", []),
        )
        return digest

    monkeypatch.setattr(
        "podcast_mcp.services.record.landing.sha256_file", remove_source_during_check
    )
    assert RecordLandingService(ws).land(align=lambda _p: None)["clips"] == []
    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["landed"] is False
    assert row["land_failed"] is True
    assert (Path(ws.project.workspace_dir) / first["clips"][0]["raw_path"]).is_file()


def test_reused_raw_source_removed_before_landed_mark_stays_failed(
    minimal_project, sample_wav, monkeypatch
):
    import podcast_mcp.services.record.landing as landing_module

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    first = RecordLandingService(ws).land(align=lambda _p: None)
    raw = Path(ws.project.workspace_dir) / first["clips"][0]["raw_path"]
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )
    copy_into_raw = landing_module._copy_into_raw

    def remove_reused_source(*args, **kwargs):
        copied = copy_into_raw(*args, **kwargs)
        raw.unlink()
        ws.mutate(
            "before source removal",
            "after source removal",
            lambda project: setattr(project, "sources", []),
        )
        return copied

    monkeypatch.setattr(landing_module, "_copy_into_raw", remove_reused_source)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["landed"] is False
    assert row["land_failed"] is True
    assert result["clips"] == []
    assert {clip.id for clip in ws.project.clips} == {first["clips"][0]["clip_id"]}


def test_new_raw_removed_before_registration_creates_no_clip(
    minimal_project, sample_wav, monkeypatch
):
    import podcast_mcp.services.record.landing as landing_module

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    copy_into_raw = landing_module._copy_into_raw

    def remove_new_raw(*args, **kwargs):
        dest, rel = copy_into_raw(*args, **kwargs)
        dest.unlink()
        return dest, rel

    monkeypatch.setattr(landing_module, "_copy_into_raw", remove_new_raw)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []
    assert ws.project.clips == []
    assert ws.project.sources == []
    assert uploader.status(session_id=room["session_id"])["segments"][0]["land_failed"] is True


def test_retry_replaces_corrupt_registered_raw_source(minimal_project, sample_wav):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    first = RecordLandingService(ws).land(align=lambda _p: None)
    old_rel = first["clips"][0]["raw_path"]
    (Path(ws.project.workspace_dir) / old_rel).write_bytes(b"corrupt raw")
    uploader.mark_land_failed(
        session_id=room["session_id"], take_index=0, participant_id=guest, segment_index=0
    )

    retried = RecordLandingService(ws).land(align=lambda _p: None)
    assert len(retried["clips"]) == 1
    new_rel = retried["clips"][0]["raw_path"]
    assert new_rel != old_rel
    assert ws.project.sources[-1].path == new_rel
    track = ws.project.track_by_id(retried["clips"][0]["track_id"])
    assert track is not None and track.media is not None
    assert track.media.path == new_rel
    assert len(ws.project.clips) == 1
    assert uploader.status(session_id=room["session_id"])["segments"][0]["landed"] is True


def test_landed_status_waits_for_project_commit(minimal_project, sample_wav, monkeypatch):
    from podcast_mcp.project_store import ProjectStore

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    at_commit = threading.Event()
    release_commit = threading.Event()

    def fail_commit(_self, _project):
        at_commit.set()
        assert release_commit.wait(timeout=5)
        raise OSError("project commit failed")

    monkeypatch.setattr(ProjectStore, "commit", fail_commit)
    failures: list[Exception] = []

    def land():
        try:
            RecordLandingService(ws).land(align=lambda _p: None)
        except Exception as exc:
            failures.append(exc)

    worker = threading.Thread(target=land)
    worker.start()
    assert at_commit.wait(timeout=5)
    try:
        row = uploader.status(session_id=room["session_id"])["segments"][0]
        assert row["landed"] is False
    finally:
        release_commit.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert len(failures) == 1 and isinstance(failures[0], OSError)
    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["landed"] is False
    assert row["land_failed"] is True


def test_room_tone_reack_during_landed_mark_keeps_replacement_pending(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    replacement_hash = "f" * 64
    # Landing creates its own service instance; patch the class method for this call.
    original_service_mark = RecordUploadService.mark_landed

    def race_mark(self, **kwargs):
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )
        return original_service_mark(self, **kwargs)

    monkeypatch.setattr(RecordUploadService, "mark_landed", race_mark)
    RecordLandingService(ws).land(align=lambda _p: None)
    row = uploader.room_tone_status(session_id=room["session_id"])[0]
    assert row["file_sha256"] == replacement_hash
    assert row["landed"] is False
    assert row["land_failed"] is False
    track = ws.project.track_by_id(slug_track_id(guest))
    assert track is None or track.room_tone is None


def test_land_notifies_document_plane(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    seen: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.services.record.landing.after_agent_mutation",
        lambda workspace: seen.append(workspace),
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    assert seen


def test_discard_drops_empty_track_and_repeat_keeps_landed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    svc.submit(_cmd("Start"), now_wall_ms=3_000)
    svc.submit(_cmd("Stop"), now_wall_ms=4_000)
    uploader = RecordUploadService(ws.project)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    _ack(
        uploader,
        session_id=room["session_id"],
        take=1,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    RecordLandingService(ws).delete_take(0)
    take1 = [
        row
        for row in uploader.status(session_id=room["session_id"])["segments"]
        if int(row["take_index"]) == 1
    ]
    assert take1 and take1[0]["landed"]
    RecordLandingService(ws).delete_take(0)
    take1_again = [
        row
        for row in uploader.status(session_id=room["session_id"])["segments"]
        if int(row["take_index"]) == 1
    ]
    assert take1_again and take1_again[0]["landed"]
    RecordLandingService(ws).delete_take(1)
    assert ws.project.track_by_id(slug_of(guest)) is None


def test_discard_reloads_the_project_once(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    """Discard reads the saved project at most once (only when it changed); the follow-up land does not read it again (#503)."""
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    calls = {"n": 0}
    original = ProjectStore.load

    def counting(self):
        calls["n"] += 1
        return original(self)

    monkeypatch.setattr(ProjectStore, "load", counting)
    RecordLandingService(ws).delete_take(0)
    assert calls["n"] <= 1
    assert ws.project.track_by_id(slug_of(guest)) is None


def test_guest_ack_hides_other_participant_clips(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app())
    token = room["guest"]["token"]
    svc, pid, lease = _consent_guest(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid="p_host",
        segment=0,
        join_offset_ms=0,
    )
    pcm, digest, file_hash = _pcm(480)
    res = client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": file_hash,
            "final": "true",
            "expected_parts": 1,
            "join_offset_ms": 0,
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["newly_acked"] is True
    assert body["landed"] is True
    clips = body.get("clips") or []
    assert clips
    assert all(clip["participant_id"] == pid for clip in clips)
    reloaded = load_project(minimal_project)
    rec = [clip for clip in reloaded.clips if clip.source_id.startswith("rec-")]
    assert len(rec) == 2


def test_host_upload_join_offset_auto_lands(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, _guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    pcm, digest, file_hash = _pcm(480)
    client = TestClient(create_app())
    res = client.post(
        "/api/record/upload",
        params={
            "path": str(minimal_project),
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": file_hash,
            "final": True,
            "expected_parts": 1,
            "join_offset_ms": 250,
        },
        content=pcm,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["newly_acked"] is True
    assert body["landed"] is True
    clips = body.get("clips") or []
    assert clips
    assert clips[0]["participant_id"] == "p_host"
    assert clips[0]["timeline_start"] == pytest.approx(0.25)
    host_land = client.post("/api/record/land", params={"path": str(minimal_project)})
    assert host_land.status_code == 200
    assert host_land.json()["clips"] == []


def test_guest_upload_persists_land_failure_until_host_retry(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, pid, lease = _consent_guest(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    original_land = RecordLandingService.land

    def fail_land(_self, **_kwargs):
        raise RecordLandingError("landing temporarily unavailable")

    monkeypatch.setattr(RecordLandingService, "land", fail_land)
    client = TestClient(create_app())
    token = room["guest"]["token"]
    pcm, digest, file_hash = _pcm(480)
    response = client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": file_hash,
            "final": "true",
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )
    assert response.status_code == 200, response.text
    assert response.json()["landed"] is False
    assert response.json()["land_failed"] is True
    uploader = RecordUploadService(ws.project)
    failed = uploader.status(session_id=room["session_id"])["segments"][0]
    assert failed["file_ack"] is True
    assert failed["landed"] is False
    assert failed["land_failed"] is True

    monkeypatch.setattr(RecordLandingService, "land", original_land)
    retry = client.post("/api/record/land", params={"path": str(minimal_project)})
    assert retry.status_code == 200, retry.text
    recovered = uploader.status(session_id=room["session_id"])["segments"][0]
    assert recovered["landed"] is True
    assert recovered["land_failed"] is False


def test_manual_land_failure_persists_for_retry(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid="p_host",
        segment=0,
        join_offset_ms=0,
    )

    def fail_locked(_self, **_kwargs):
        raise RecordLandingError("landing temporarily unavailable")

    monkeypatch.setattr(RecordLandingService, "_land_locked", fail_locked)
    with pytest.raises(RecordLandingError, match="temporarily unavailable"):
        RecordControlService(ws).land()
    status = RecordUploadService(ws.project).status(session_id=room["session_id"])
    assert status["segments"][0]["land_failed"] is True
    assert RecordUploadService(ws.project).acked_wav(room["session_id"], 0, "p_host", 0).is_file()


def test_overlap_window_caps_at_drift_window() -> None:
    assert overlap_window_s(0, 120.0, 0, 120.0) == (0.0, DRIFT_WINDOW_S)
    assert overlap_window_s(0, 5.0, 2_000, 5.0) == (2.0, 3.0)
    assert overlap_window_s(0, 0.01, 0, 0.01) is None
    assert overlap_window_s(10_000, 1.0, 0, 2.0) is None


def _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    return ws, room, guest


def test_land_duration_mismatch_sets_align_fallback_hint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    uploader = RecordUploadService(ws.project)
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=2.0, delay_ms=0.0),
    )
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=0.2, delay_ms=0.0),
    )
    called: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        lambda project: called.append(project),
    )
    before = [clip.id for clip in ws.project.clips]
    result = RecordLandingService(ws).land()
    assert result["align_fallback"] is True
    assert result["drift_ms"] == pytest.approx(1_800.0, abs=50.0)
    guest_row = next(row for row in result["drift"] if row["participant_id"] == guest)
    assert guest_row["drift_ms"] == pytest.approx(-1_800.0, abs=50.0)
    assert guest_row["duration_error_ms"] == pytest.approx(-1_800.0, abs=50.0)
    assert not called
    assert [clip.id for clip in ws.project.clips if clip.id in before] == before


def test_land_matching_durations_skip_fallback(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    uploader = RecordUploadService(ws.project)
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=2.0, delay_ms=0.0),
    )
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=2.0, delay_ms=10.0),
    )
    called: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        lambda project: called.append(project),
    )
    result = RecordLandingService(ws).land()
    assert result["align_fallback"] is False
    assert result["drift_ms"] == pytest.approx(0.0, abs=5.0)
    assert abs(result["drift_ms"]) <= ALIGN_DRIFT_MS
    assert not called


def test_land_independent_talkers_do_not_invoke_align(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    uploader = RecordUploadService(ws.project)
    host_pcm = 0.4 * np.random.default_rng(1).normal(size=48_000 * 2)
    guest_pcm = 0.4 * np.random.default_rng(2).normal(size=48_000 * 2)
    host_bytes = np.clip(np.round(host_pcm * 32767.0), -32767, 32767).astype("<i2").tobytes()
    guest_bytes = np.clip(np.round(guest_pcm * 32767.0), -32767, 32767).astype("<i2").tobytes()
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
        pcm=host_bytes,
    )
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=guest_bytes,
    )
    called: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        lambda project: called.append(project),
    )
    result = RecordLandingService(ws).land()
    assert result["align_fallback"] is False
    assert result["drift_ms"] == pytest.approx(0.0, abs=5.0)
    assert not called


def test_land_single_participant_skips_drift(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["drift_ms"] is None
    assert result["drift"] == []
    assert result["align_fallback"] is False


def test_land_silence_does_not_false_trigger(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    silent = b"\x00\x00" * (48_000 * 2)
    uploader = RecordUploadService(ws.project)
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
        pcm=silent,
    )
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=silent,
    )
    called: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.conversation_align.run_conversation_align",
        lambda project: called.append(project),
    )
    result = RecordLandingService(ws).land()
    assert result["align_fallback"] is False
    assert result["drift_ms"] == pytest.approx(0.0, abs=5.0)
    assert not called


def test_measure_keeper_drifts_skips_pcm_windows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import wave

    sr = 8000
    seconds = 62.0
    host = tmp_path / "host.wav"
    guest = tmp_path / "guest.wav"
    silence = b"\x00\x00" * int(seconds * sr)
    for path in (host, guest):
        with wave.open(str(path), "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(silence)
    reads: list[tuple[float, int]] = []

    def wrapped(path: Path, *, start_sec: float = 0.0, duration_sec: float, out_rate: int):
        reads.append((duration_sec, 0))
        raise AssertionError("land must not decode dry keepers for PHAT")

    monkeypatch.setattr("podcast_mcp.engines.align.read_wav_mono_window", wrapped)
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=62_000,
        )
    ]
    segments = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": HOST_PARTICIPANT_ID,
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_guest",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
    ]
    paths = {HOST_PARTICIPANT_ID: host, "p_guest": guest}
    max_abs, details = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=segments,
        acked_wav=lambda _sid, _take, pid, _seg: paths[pid],
        tombstoned=set(),
        roles={HOST_PARTICIPANT_ID: "host", "p_guest": "guest"},
    )
    assert max_abs == pytest.approx(0.0, abs=1.0)
    assert reads == []
    assert any(row.get("reference") for row in details)


def test_measure_keeper_drifts_skips_producer(tmp_path: Path) -> None:
    import wave

    sr = 8000
    host = tmp_path / "host.wav"
    prod = tmp_path / "prod.wav"
    pcm = _noise_pcm(duration_s=1.0, delay_ms=0.0, sr=sr)
    delayed = _noise_pcm(duration_s=1.0, delay_ms=120.0, sr=sr)
    for path, payload in ((host, pcm), (prod, delayed)):
        with wave.open(str(path), "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(payload)
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=1_000,
        )
    ]
    segments = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": HOST_PARTICIPANT_ID,
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_prod",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
    ]
    paths = {HOST_PARTICIPANT_ID: host, "p_prod": prod}
    max_abs, details = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=segments,
        acked_wav=lambda _sid, _take, pid, _seg: paths[pid],
        tombstoned=set(),
        roles={HOST_PARTICIPANT_ID: "host", "p_prod": "producer"},
    )
    assert max_abs is None
    assert details == []


def _silence_wav(path: Path, *, seconds: float = 1.0, sr: int = 8000) -> None:
    import wave

    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"\x00\x00" * int(seconds * sr))


def test_measure_keeper_drifts_edges(tmp_path: Path) -> None:
    a = tmp_path / "a.wav"
    b = tmp_path / "b.wav"
    _silence_wav(a)
    _silence_wav(b)
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=1_000,
        )
    ]
    guests = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_a",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_b",
            "segment_index": 1,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_b",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": False,
            "take_index": 0,
            "participant_id": "p_c",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 9,
            "participant_id": "p_a",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
    ]
    roles = {"p_a": "guest", "p_b": "guest", "p_c": "guest"}
    tombstoned = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=guests[:3],
        acked_wav=lambda *_a: a,
        tombstoned={0},
        roles=roles,
    )
    assert tombstoned == (None, [])
    missing_ref = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=guests[:2],
        acked_wav=lambda *_a: tmp_path / "nope.wav",
        tombstoned=set(),
        roles=roles,
    )
    assert missing_ref[0] is None
    paths = {"p_a": a, "p_b": tmp_path / "missing-b.wav"}
    missing_sig = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=guests[:2],
        acked_wav=lambda _sid, _take, pid, _seg: paths[pid],
        tombstoned=set(),
        roles=roles,
    )
    assert missing_sig[0] is None
    assert any(row.get("reference") for row in missing_sig[1])
    far = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_a",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_b",
            "segment_index": 0,
            "join_offset_ms": 120_000,
        },
    ]
    no_overlap, details = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=far,
        acked_wav=lambda _sid, _take, pid, _seg: a if pid == "p_a" else b,
        tombstoned=set(),
        roles=roles,
    )
    assert no_overlap is None
    assert any(row["drift_ms"] is None and row.get("confidence") == 0.0 for row in details)
    unknown_take = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=[row for row in guests if int(row["take_index"]) == 9],
        acked_wav=lambda *_a: a,
        tombstoned=set(),
        roles=roles,
    )
    assert unknown_take == (None, [])


def _pcm_wav(path: Path, *, seconds: float, sr: int = 8000) -> None:
    import wave

    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"\x00\x00" * int(seconds * sr))


def test_measure_keeper_drifts_uses_first_overlapping_segments(tmp_path: Path) -> None:
    host0 = tmp_path / "host0.wav"
    host1 = tmp_path / "host1.wav"
    guest = tmp_path / "guest.wav"
    _pcm_wav(host0, seconds=1.0)
    _pcm_wav(host1, seconds=1.0)
    _pcm_wav(guest, seconds=1.0)
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
            stopped_wall_ms=2_000,
        )
    ]
    segments = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": HOST_PARTICIPANT_ID,
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": HOST_PARTICIPANT_ID,
            "segment_index": 1,
            "join_offset_ms": 1_000,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_guest",
            "segment_index": 0,
            "join_offset_ms": 1_000,
        },
    ]
    paths = {
        (HOST_PARTICIPANT_ID, 0): host0,
        (HOST_PARTICIPANT_ID, 1): host1,
        ("p_guest", 0): guest,
    }
    max_abs, details = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=segments,
        acked_wav=lambda _sid, _take, pid, seg: paths[(pid, seg)],
        tombstoned=set(),
        roles={HOST_PARTICIPANT_ID: "host", "p_guest": "guest"},
    )
    assert max_abs == pytest.approx(0.0, abs=1.0)
    guest_row = next(row for row in details if row["participant_id"] == "p_guest")
    assert guest_row["drift_ms"] == pytest.approx(0.0, abs=1.0)
    assert guest_row["confidence"] == 1.0


def test_land_skips_bad_keeper_and_copies_the_rest(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    uploader = RecordUploadService(ws.project)
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=HOST_PARTICIPANT_ID,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=2.0),
    )
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=_noise_pcm(duration_s=2.0),
    )
    guest_path = uploader.acked_wav(room["session_id"], 0, guest, 0)
    guest_path.write_bytes(b"not a wav")
    result = RecordLandingService(ws).land(align=lambda _p: None)
    pids = {row["participant_id"] for row in result["clips"]}
    assert HOST_PARTICIPANT_ID in pids
    assert guest not in pids


def test_land_skips_drift_when_pending_empty(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    calls: list[int] = []
    real = measure_keeper_drifts

    def wrapped(**kwargs):
        calls.append(1)
        return real(**kwargs)

    monkeypatch.setattr("podcast_mcp.services.record.landing.measure_keeper_drifts", wrapped)
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["clips"] == []
    assert calls == []


def test_release_session_land_lock_drops_idle_entry() -> None:
    _LAND_LOCKS["idle-session"] = threading.Lock()
    release_session_land_lock("idle-session")
    assert "idle-session" not in _LAND_LOCKS
    held = threading.Lock()
    held.acquire()
    _LAND_LOCKS["busy-session"] = held
    release_session_land_lock("busy-session")
    assert "busy-session" in _LAND_LOCKS
    held.release()
    release_session_land_lock("busy-session")
    assert "busy-session" not in _LAND_LOCKS
    release_session_land_lock("missing-session")


def test_measure_keeper_drifts_handles_raise_and_open_take(tmp_path: Path) -> None:
    host = tmp_path / "host.wav"
    guest = tmp_path / "guest.wav"
    _pcm_wav(host, seconds=1.0)
    _pcm_wav(guest, seconds=1.0)
    takes = [
        TakeState(
            take_index=0,
            session_start_wall_ms=0,
            session_start_iso="t0",
        )
    ]
    segments = [
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": HOST_PARTICIPANT_ID,
            "segment_index": 0,
            "join_offset_ms": 0,
        },
        {
            "file_ack": True,
            "take_index": 0,
            "participant_id": "p_guest",
            "segment_index": 0,
            "join_offset_ms": 0,
        },
    ]
    roles = {HOST_PARTICIPANT_ID: "host", "p_guest": "guest"}
    open_take = measure_keeper_drifts(
        session_id="sess",
        takes=takes,
        segments=segments,
        acked_wav=lambda _sid, _take, pid, _seg: host if pid == HOST_PARTICIPANT_ID else guest,
        tombstoned=set(),
        roles=roles,
    )
    assert open_take[0] is None
    assert any(row["drift_ms"] is None for row in open_take[1])

    def boom(_sid: str, _take: int, pid: str, _seg: int) -> Path:
        if pid != HOST_PARTICIPANT_ID:
            raise ValueError("guest wav")
        return host

    raised = measure_keeper_drifts(
        session_id="sess",
        takes=[
            TakeState(
                take_index=0,
                session_start_wall_ms=0,
                session_start_iso="t0",
                stopped_wall_ms=1_000,
            )
        ],
        segments=segments,
        acked_wav=boom,
        tombstoned=set(),
        roles=roles,
    )
    assert raised[0] is None
    host0 = tmp_path / "host0.wav"
    host1 = tmp_path / "host1.wav"
    _pcm_wav(host1, seconds=1.0)
    paths = {
        (HOST_PARTICIPANT_ID, 0): host0,
        (HOST_PARTICIPANT_ID, 1): host1,
        ("p_guest", 0): guest,
    }
    skipped_first = measure_keeper_drifts(
        session_id="sess",
        takes=[
            TakeState(
                take_index=0,
                session_start_wall_ms=0,
                session_start_iso="t0",
                stopped_wall_ms=2_000,
            )
        ],
        segments=[
            {
                "file_ack": True,
                "take_index": 0,
                "participant_id": HOST_PARTICIPANT_ID,
                "segment_index": 0,
                "join_offset_ms": 0,
            },
            {
                "file_ack": True,
                "take_index": 0,
                "participant_id": HOST_PARTICIPANT_ID,
                "segment_index": 1,
                "join_offset_ms": 1_000,
            },
            {
                "file_ack": True,
                "take_index": 0,
                "participant_id": "p_guest",
                "segment_index": 0,
                "join_offset_ms": 1_000,
            },
        ],
        acked_wav=lambda _sid, _take, pid, seg: paths[(pid, seg)],
        tombstoned=set(),
        roles=roles,
    )
    guest_row = next(row for row in skipped_first[1] if row["participant_id"] == "p_guest")
    assert guest_row["drift_ms"] == pytest.approx(0.0, abs=1.0)


def test_injected_align_runs_on_fallback_hint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, guest = _stopped_room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    _ack(
        RecordUploadService(ws.project),
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
    )
    called: list[object] = []
    result = RecordLandingService(ws).land(
        align=lambda project: called.append(project),
        drift_ms=ALIGN_DRIFT_MS + 1,
    )
    assert result["align_fallback"] is True
    assert called


def test_land_sets_track_room_tone_under_lock(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.edits.timeline_ops import room_tone_source_id
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []
    tid = slug_track_id(guest)
    track = ws.project.track_by_id(tid)
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == f"raw/room-tone/{room['session_id']}/{guest}.wav"
    dest = Path(ws.project.workspace_dir) / track.room_tone.path
    assert dest.is_file()
    src = next(s for s in ws.project.sources if s.id == room_tone_source_id(tid))
    assert src.path == track.room_tone.path
    beds = uploader.room_tone_status(session_id=room["session_id"])
    assert beds and beds[0]["landed"] is True
    assert beds[0]["take_index"] == ROOM_TONE_TAKE_INDEX
    HistoryService(ws).undo()
    ws.reload()
    restored = ws.project.track_by_id(tid)
    assert restored is None or restored.room_tone is None
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["clips"] == []
    ws.reload()
    relanded = ws.project.track_by_id(tid)
    assert relanded is not None
    assert relanded.room_tone is not None


def test_land_rejects_oversize_room_tone_before_copy(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.record.upload import ROOM_TONE_MAX_PCM_BYTES

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    acked = uploader.acked_wav(
        room["session_id"],
        uploader.room_tone_status(session_id=room["session_id"])[0]["take_index"],
        guest,
        0,
    )
    acked.write_bytes(b"RIFF" + b"\x00" * (ROOM_TONE_MAX_PCM_BYTES + 80))
    with pytest.raises(RecordLandingError, match="too large"):
        RecordLandingService(ws).land(align=lambda _p: None)
    dest = (
        Path(ws.project.workspace_dir) / "raw" / "room-tone" / room["session_id"] / f"{guest}.wav"
    )
    assert not dest.is_file()


def test_missing_acked_room_tone_lands_only_with_registered_bed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []
    bed = Path(ws.project.workspace_dir) / "raw" / "room-tone" / room["session_id"] / f"{guest}.wav"
    assert bed.is_file()
    beds = uploader.room_tone_status(session_id=room["session_id"])
    assert beds and beds[0]["landed"] is True

    uploader.acked_wav(room["session_id"], ROOM_TONE_TAKE_INDEX, guest, 0).unlink()
    # Real trigger: land() re-checks a landed bed only when track.room_tone is None
    # (e.g. after undoing the land); clear it instead of injecting land_failed.
    track = ws.project.track_by_id(slug_track_id(guest))
    assert track is not None
    track.room_tone = None
    ws.save()  # land re-reads the saved project, so persist the cleared bed
    again = RecordLandingService(ws).land(align=lambda _p: None)
    assert again["clips"] == []
    beds_again = uploader.room_tone_status(session_id=room["session_id"])
    assert beds_again[0]["landed"] is True
    assert beds_again[0]["land_failed"] is False
    assert bed.is_file()

    bed.unlink()
    again2 = RecordLandingService(ws).land(align=lambda _p: None)
    assert again2["clips"] == []
    beds_final = uploader.room_tone_status(session_id=room["session_id"])
    assert beds_final[0]["landed"] is False
    assert beds_final[0]["land_failed"] is True


def test_overlapping_sessions_room_tone_keep_own_verified_bytes(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Two sessions landing the same participant's room tone must not clobber
    each other's raw bytes; each session's landed row keeps its own file."""
    from podcast_mcp.edits.timeline_ops import room_tone_source_id
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record import landing
    from podcast_mcp.util.hashing import sha256_file

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    uploader = RecordUploadService(ws.project)

    def _ingest_bed(session_id: str, nbytes: int) -> str:
        pcm, digest, file_hash = _pcm(nbytes)
        uploader.ingest_part(
            session_id=session_id,
            take_index=0,
            participant_id=HOST_PARTICIPANT_ID,
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=file_hash,
            final=True,
            kind="room_tone",
        )
        return file_hash

    room_a = ShareService(ws).create_record_room()
    _consent_room(ws, room_a)
    hash_a = _ingest_bed(room_a["session_id"], 480)
    land_a = RecordLandingService(ws)

    copied_event = threading.Event()
    resume_event = threading.Event()
    real_copy_room_tone = landing._copy_room_tone

    def _paced_copy_room_tone(project, acked, session_id, participant_id):
        rel = real_copy_room_tone(project, acked, session_id, participant_id)
        if session_id == room_a["session_id"]:
            copied_event.set()
            assert resume_event.wait(timeout=5), "test main thread never resumed session A"
        return rel

    monkeypatch.setattr(landing, "_copy_room_tone", _paced_copy_room_tone)

    result_a: dict[str, Any] = {}

    def _land_a() -> None:
        result_a["out"] = land_a.land(align=lambda _p: None)

    thread = threading.Thread(target=_land_a)
    thread.start()
    try:
        assert copied_event.wait(timeout=5), "session A never reached its room-tone copy"

        room_b = ShareService(ws).create_record_room()
        _consent_room(ws, room_b)
        hash_b = _ingest_bed(room_b["session_id"], 960)
        land_b = RecordLandingService(ws)
        land_b.land(align=lambda _p: None)
    finally:
        resume_event.set()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert "out" in result_a

    status_a = uploader.room_tone_status(session_id=room_a["session_id"])
    status_b = uploader.room_tone_status(session_id=room_b["session_id"])
    assert status_a[0]["landed"] is True
    assert status_a[0]["land_failed"] is False
    assert status_b[0]["landed"] is True
    assert status_b[0]["land_failed"] is False

    raw_room_tone = Path(ws.project.workspace_dir) / "raw" / "room-tone"
    bed_a = raw_room_tone / room_a["session_id"] / f"{HOST_PARTICIPANT_ID}.wav"
    bed_b = raw_room_tone / room_b["session_id"] / f"{HOST_PARTICIPANT_ID}.wav"
    assert sha256_file(bed_a) == hash_a
    assert sha256_file(bed_b) == hash_b
    assert list(raw_room_tone.rglob("*.tmp")) == []

    track_id = slug_track_id(HOST_PARTICIPANT_ID)
    track = ws.project.track_by_id(track_id)
    assert track is not None and track.room_tone is not None
    assert track.room_tone.path == f"raw/room-tone/{room_a['session_id']}/{HOST_PARTICIPANT_ID}.wav"
    src = next(s for s in ws.project.sources if s.id == room_tone_source_id(track_id))
    assert src.path == track.room_tone.path


def test_later_session_room_tone_does_not_rewrite_landed_bed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A later session's room-tone landing must not touch an earlier session's
    already-landed bed on disk, only the track/source that owns the last commit."""
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.util.hashing import sha256_file

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    uploader = RecordUploadService(ws.project)

    def _ingest_bed(session_id: str, nbytes: int) -> str:
        pcm, digest, file_hash = _pcm(nbytes)
        uploader.ingest_part(
            session_id=session_id,
            take_index=0,
            participant_id=HOST_PARTICIPANT_ID,
            segment_index=0,
            part_seq=0,
            data=pcm,
            digest=digest,
            file_sha256=file_hash,
            final=True,
            kind="room_tone",
        )
        return file_hash

    room_a = ShareService(ws).create_record_room()
    _consent_room(ws, room_a)
    hash_a = _ingest_bed(room_a["session_id"], 480)
    RecordLandingService(ws).land(align=lambda _p: None)

    room_b = ShareService(ws).create_record_room()
    _consent_room(ws, room_b)
    _ingest_bed(room_b["session_id"], 960)
    RecordLandingService(ws).land(align=lambda _p: None)

    track = ws.project.track_by_id(slug_track_id(HOST_PARTICIPANT_ID))
    assert track is not None and track.room_tone is not None
    assert track.room_tone.path == f"raw/room-tone/{room_b['session_id']}/{HOST_PARTICIPANT_ID}.wav"

    status_a = uploader.room_tone_status(session_id=room_a["session_id"])
    assert status_a[0]["landed"] is True
    assert status_a[0]["land_failed"] is False

    bed_a = (
        Path(ws.project.workspace_dir)
        / "raw"
        / "room-tone"
        / room_a["session_id"]
        / f"{HOST_PARTICIPANT_ID}.wav"
    )
    assert sha256_file(bed_a) == hash_a


def test_segment_reack_during_project_commit_rolls_back_stale_clip(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.landing import record_source_id

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)

    replacement_hash = "f" * 64
    source_id = record_source_id(room["session_id"], 0, guest, 0)
    track_id = slug_track_id(guest)

    def race():
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=0,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(src.id == source_id for src in project.sources),
        race=race,
    )

    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []

    assert not any(src.id == source_id for src in ws.project.sources)
    assert not any(clip.source_id == source_id for clip in ws.project.clips)
    assert ws.project.track_by_id(track_id) is None

    on_disk = load_project(minimal_project)
    assert not any(src.id == source_id for src in on_disk.sources)
    assert not any(clip.source_id == source_id for clip in on_disk.clips)
    assert on_disk.track_by_id(track_id) is None

    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["file_sha256"] == replacement_hash
    assert row["landed"] is False
    assert row["land_failed"] is False

    staged = uploader.acked_wav(room["session_id"], 0, guest, 0)
    assert staged.is_file()


def test_segment_reack_during_commit_keeps_sibling_segment(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.landing import record_source_id

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=1,
        join_offset_ms=500,
    )

    replacement_hash = "f" * 64
    stale_source_id = record_source_id(room["session_id"], 0, guest, 0)
    kept_source_id = record_source_id(room["session_id"], 0, guest, 1)
    track_id = slug_track_id(guest)

    def race():
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=0,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(src.id == kept_source_id for src in project.sources),
        race=race,
    )

    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert len(result["clips"]) == 1
    assert result["clips"][0]["source_id"] == kept_source_id

    assert not any(src.id == stale_source_id for src in ws.project.sources)
    assert not any(clip.source_id == stale_source_id for clip in ws.project.clips)
    track = ws.project.track_by_id(track_id)
    assert track is not None
    assert track.media is not None
    kept_rel = next(s.path for s in ws.project.sources if s.id == kept_source_id)
    assert track.media.path == kept_rel

    kept_row = uploader.status(session_id=room["session_id"])["segments"][1]
    assert kept_row["landed"] is True
    stale_row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert stale_row["landed"] is False


def test_rollback_failure_keeps_confirmed_land(minimal_project, sample_wav, monkeypatch, caplog):
    import logging

    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.landing import record_source_id

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=2_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)
    _ack(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=1,
        join_offset_ms=500,
    )

    replacement_hash = "f" * 64
    kept_source_id = record_source_id(room["session_id"], 0, guest, 1)
    track_id = slug_track_id(guest)

    def race():
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=0,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(src.id == kept_source_id for src in project.sources),
        race=race,
    )

    def boom(self, stale):
        raise RuntimeError("rollback write failed")

    monkeypatch.setattr(RecordLandingService, "_rollback_stale", boom)

    with caplog.at_level(logging.ERROR, logger="podcast_mcp.services.record.landing"):
        result = RecordLandingService(ws).land(align=lambda _p: None)

    assert len(result["clips"]) == 1
    assert result["clips"][0]["source_id"] == kept_source_id
    track = ws.project.track_by_id(track_id)
    assert track is not None

    segments = uploader.status(session_id=room["session_id"])["segments"]
    assert segments[1]["landed"] is True
    assert segments[0]["landed"] is False
    assert "stale ACK rollback failed" in caplog.text


@pytest.mark.parametrize("mode", ["reack", "revoke"])
def test_room_tone_race_during_project_commit_rolls_back_stale_bed(
    minimal_project, sample_wav, monkeypatch, mode
):
    from podcast_mcp.edits.timeline_ops import room_tone_source_id
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    track_id = slug_track_id(guest)
    source_id = room_tone_source_id(track_id)
    replacement_hash = "f" * 64

    def race():
        if mode == "reack":
            uploader._store.mark_file(
                session_id=room["session_id"],
                take_index=ROOM_TONE_TAKE_INDEX,
                participant_id=guest,
                segment_index=0,
                file_sha256=replacement_hash,
                byte_length=480,
            )
        else:
            uploader.revoke_room_tone(room["session_id"], guest)

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(src.id == source_id for src in project.sources),
        race=race,
    )

    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []

    assert not any(src.id == source_id for src in ws.project.sources)
    track = ws.project.track_by_id(track_id)
    assert track is None or track.room_tone is None

    beds = uploader.room_tone_status(session_id=room["session_id"])
    if mode == "reack":
        assert beds and beds[0]["file_sha256"] == replacement_hash
        assert beds[0]["landed"] is False
    else:
        assert beds == []


def test_room_tone_rerecord_stale_during_commit_clears_overwritten_bed(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.edits.timeline_ops import room_tone_source_id
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    track_id = slug_track_id(guest)
    source_id = room_tone_source_id(track_id)

    pcm_a, digest_a, hash_a = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm_a,
        digest=digest_a,
        file_sha256=hash_a,
        final=True,
        kind="room_tone",
    )
    landed_a = RecordLandingService(ws).land(align=lambda _p: None)
    assert landed_a["clips"] == []
    track = ws.project.track_by_id(track_id)
    assert track is not None and track.room_tone is not None
    assert track.room_tone.path == f"raw/room-tone/{room['session_id']}/{guest}.wav"

    pcm_b, digest_b, hash_b = _pcm(96)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm_b,
        digest=digest_b,
        file_sha256=hash_b,
        final=True,
        kind="room_tone",
    )

    _pcm_c, _digest_c, hash_c = _pcm(160)

    def race():
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id=guest,
            segment_index=0,
            file_sha256=hash_c,
            byte_length=160,
        )

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(
            s.id == source_id and s.path == f"raw/room-tone/{room['session_id']}/{guest}.wav"
            for s in project.sources
        ),
        race=race,
    )

    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []

    track = ws.project.track_by_id(track_id)
    assert track is not None
    assert track.room_tone is None
    assert not any(src.id == source_id for src in ws.project.sources)

    beds = uploader.room_tone_status(session_id=room["session_id"])
    assert beds and beds[0]["file_sha256"] == hash_c
    assert beds[0]["landed"] is False


def test_room_tone_newer_bed_on_disk_before_rollback_is_kept(
    minimal_project, sample_wav, monkeypatch
):
    from podcast_mcp.edits.timeline_ops import room_tone_source_id
    from podcast_mcp.edits.track_ids import slug_track_id
    from podcast_mcp.services.record.upload import ROOM_TONE_TAKE_INDEX

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    _svc, guest = _consent_room(ws, room)
    uploader = RecordUploadService(ws.project)
    pcm, digest, file_hash = _pcm(480)
    uploader.ingest_part(
        session_id=room["session_id"],
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=digest,
        file_sha256=file_hash,
        final=True,
        kind="room_tone",
    )
    track_id = slug_track_id(guest)
    source_id = room_tone_source_id(track_id)
    replacement_hash = "f" * 64

    def race():
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=ROOM_TONE_TAKE_INDEX,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )
        (
            Path(ws.project.workspace_dir)
            / "raw"
            / "room-tone"
            / room["session_id"]
            / f"{guest}.wav"
        ).write_bytes(b"newer-generation-bed")

    _race_on_commit(
        monkeypatch,
        when=lambda project: any(src.id == source_id for src in project.sources),
        race=race,
    )

    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []

    assert any(src.id == source_id for src in ws.project.sources)
    track = ws.project.track_by_id(track_id)
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == f"raw/room-tone/{room['session_id']}/{guest}.wav"

    beds = uploader.room_tone_status(session_id=room["session_id"])
    assert beds[0]["file_sha256"] == replacement_hash
    assert beds[0]["landed"] is False


def test_ack_replaced_before_registration_skips_project_media(
    minimal_project, sample_wav, monkeypatch
):
    import podcast_mcp.services.record.landing as landing_module
    from podcast_mcp.services.record.landing import record_source_id

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=1_000)
    uploader = RecordUploadService(ws.project)
    _ack(uploader, session_id=room["session_id"], take=0, pid=guest, segment=0, join_offset_ms=0)

    replacement_hash = "f" * 64
    original_copy = landing_module._copy_into_raw

    def race_after_copy(*args, **kwargs):
        dest, rel = original_copy(*args, **kwargs)
        uploader._store.mark_file(
            session_id=room["session_id"],
            take_index=0,
            participant_id=guest,
            segment_index=0,
            file_sha256=replacement_hash,
            byte_length=480,
        )
        return dest, rel

    monkeypatch.setattr(landing_module, "_copy_into_raw", race_after_copy)

    def fail_rollback(self, stale):
        pytest.fail(f"unexpected stale rollback for {stale}")

    monkeypatch.setattr(RecordLandingService, "_rollback_stale", fail_rollback)

    source_id = record_source_id(room["session_id"], 0, guest, 0)
    result = RecordLandingService(ws).land(align=lambda _p: None)
    assert result["clips"] == []
    assert not any(src.id == source_id for src in ws.project.sources)
    assert not any(clip.source_id == source_id for clip in ws.project.clips)

    row = uploader.status(session_id=room["session_id"])["segments"][0]
    assert row["file_sha256"] == replacement_hash
    assert row["landed"] is False


def _two_second_pcm() -> tuple[bytes, str, str]:
    pcm = bytes(48_000 * 2 * 2)
    wav = pcm_wav_header(len(pcm)) + pcm
    return pcm, sha256_hex(pcm), sha256_hex(wav)


def test_http_final_part_lands_clipping_regions_on_source_and_list_clips(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.edits.timeline_ops import list_clips

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app())
    token = room["guest"]["token"]
    svc, pid, lease = _consent_guest(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    pcm, digest, file_hash = _two_second_pcm()
    res = client.post(
        f"/api/rec/{token}/upload",
        params={
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
            "sha256": digest,
            "file_sha256": file_hash,
            "final": "true",
            "expected_parts": 1,
            "join_offset_ms": 0,
            "clipping": "100-250,1500-1600",
        },
        headers={"X-Record-Participant": pid, "X-Record-Lease": lease},
        content=pcm,
    )
    assert res.status_code == 200, res.text
    assert res.json().get("landed") is True
    reloaded = load_project(minimal_project)
    source = next(s for s in reloaded.sources if s.id.startswith("rec-"))
    assert [(r.start_s, r.end_s) for r in source.clipping_regions] == [
        (pytest.approx(0.1), pytest.approx(0.25)),
        (pytest.approx(1.5), pytest.approx(1.6)),
    ]
    rows = [row for track in list_clips(reloaded)["tracks"].values() for row in track]
    landed = next(r for r in rows if r["source_id"] == source.id)
    assert [(c["start_s"], c["end_s"]) for c in landed["clipping_regions"]] == [
        (pytest.approx(0.1), pytest.approx(0.25)),
        (pytest.approx(1.5), pytest.approx(1.6)),
    ]


def test_landing_clamps_or_drops_out_of_range_clipping(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    uploader = RecordUploadService(ws.project)
    pcm, _digest, _file_hash = _two_second_pcm()
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=pcm,
        clipping="1900-5000,6000-7000",
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    source = next(s for s in ws.project.sources if s.id.startswith("rec-"))
    assert [(r.start_s, r.end_s) for r in source.clipping_regions] == [
        (pytest.approx(1.9), pytest.approx(2.0))
    ]


def test_landing_carries_clipping_truncated_to_the_source(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    uploader = RecordUploadService(ws.project)
    pcm, _digest, _file_hash = _two_second_pcm()
    _ack_pcm(
        uploader,
        session_id=room["session_id"],
        take=0,
        pid=guest,
        segment=0,
        join_offset_ms=0,
        pcm=pcm,
        clipping="100-250",
        clipping_truncated=True,
    )
    RecordLandingService(ws).land(align=lambda _p: None)
    source = next(s for s in ws.project.sources if s.id.startswith("rec-"))
    assert source.clipping_truncated is True


def test_reack_before_landing_replaces_clipping_regions(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=3_000)
    uploader = RecordUploadService(ws.project)
    pcm, _digest, _file_hash = _two_second_pcm()
    for spans in ("100-250", "400-500"):
        _ack_pcm(
            uploader,
            session_id=room["session_id"],
            take=0,
            pid=guest,
            segment=0,
            join_offset_ms=0,
            pcm=pcm,
            clipping=spans,
        )
    RecordLandingService(ws).land(align=lambda _p: None)
    source = next(s for s in ws.project.sources if s.id.startswith("rec-"))
    assert [(r.start_s, r.end_s) for r in source.clipping_regions] == [
        (pytest.approx(0.4), pytest.approx(0.5))
    ]


def test_upsert_source_keeps_clipping_on_none_and_clears_on_empty(minimal_project):
    project = load_project(minimal_project)
    fields: dict[str, Any] = {
        "source_id": "rec-x-0-p_aa-0",
        "rel": "raw/rec-x.wav",
        "speaker": "p_aa",
        "duration_s": 2.0,
        "sample_rate": 48000,
        "channels": 1,
    }
    src = _upsert_source(
        project,
        clipping_regions=[SourceClippingRegion(start_s=0.1, end_s=0.2)],
        clipping_truncated=True,
        **fields,
    )
    # None means "unknown" (recovered or older segment): keep what we had.
    _upsert_source(project, clipping_regions=None, **fields)
    assert [(r.start_s, r.end_s) for r in src.clipping_regions] == [(0.1, 0.2)]
    assert src.clipping_truncated is True
    # [] means "checked, no clipping": clear.
    _upsert_source(project, clipping_regions=[], **fields)
    assert src.clipping_regions == []
    assert src.clipping_truncated is False


def test_land_hashes_each_keeper_once_outside_the_project_locks(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Landing hashes each keeper before any project lock; the locked part only stats (#365)."""
    import time

    from podcast_mcp.services.record import landing as landing_mod
    from podcast_mcp.util.file_locks import shared_file_lock
    from podcast_mcp.util.project_state import (
        project_commit_lock_path,
        project_state_lock,
        snapshot_project,
    )

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    svc, guest = _consent_room(ws, room)
    svc.submit(_cmd("Start"), now_wall_ms=0)
    svc.submit(_cmd("Stop"), now_wall_ms=400_000)
    uploader = RecordUploadService(ws.project)
    for segment, join_ms in enumerate((0, 100_000, 200_000)):
        _ack(
            uploader,
            session_id=room["session_id"],
            take=0,
            pid=guest,
            segment=segment,
            join_offset_ms=join_ms,
            nbytes=480 + 8 * segment,
        )
    state_lock = project_state_lock(ws.project)
    file_lock = shared_file_lock(project_commit_lock_path(ws.project), timeout=30)
    real_hash = landing_mod.sha256_file
    observed: list[tuple[bool, bool]] = []

    def spy(path):
        got: list[bool] = []

        def probe() -> None:
            acquired = state_lock.acquire(blocking=False)
            got.append(acquired)
            if acquired:
                state_lock.release()

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join()
        observed.append((got[0], file_lock.is_locked))
        time.sleep(0.5)
        return real_hash(path)

    monkeypatch.setattr(landing_mod, "sha256_file", spy)
    done = threading.Event()
    waits: list[float] = []

    def snapshots() -> None:
        while not done.is_set():
            started = time.monotonic()
            snapshot_project(ws.project)
            waits.append(time.monotonic() - started)
            time.sleep(0.02)

    prober = threading.Thread(target=snapshots)
    prober.start()
    try:
        result = RecordLandingService(ws).land(align=lambda _p: None)
    finally:
        done.set()
        prober.join()
    assert len(result["clips"]) == 3
    assert len(observed) == 3
    assert all(state_free for state_free, _ in observed)
    assert not any(file_held for _, file_held in observed)
    assert waits
    assert max(waits) < 0.5
