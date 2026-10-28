"""A guest who joins after the room-tone countdown delivers the same room tone as one who was there."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.room_tone import BedUnavailable, room_tone_bed, room_tone_source_id
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.models import load_project, record_artifacts_dir, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.upload import (
    KEEPER_SAMPLE_RATE,
    ROOM_TONE_SEGMENT_INDEX,
    ROOM_TONE_TAKE_INDEX,
    RecordUploadService,
    sha256_hex,
)
from podcast_mcp.util.wav import pcm_wav_header

CAPS = ["join", "monitor", "comment"]
BED_SEC = 3
PER_GUEST_KEYS = {"participant_id", "acked_ns", "landed_ns", "land_failed_ns"}


@pytest.fixture
def sample_wav(tmp_path: Path) -> Path:
    out = tmp_path / "tone.wav"
    t = np.arange(KEEPER_SAMPLE_RATE * 2) / KEEPER_SAMPLE_RATE
    pcm = (np.sin(2 * np.pi * 440 * t) * 0.3 * 32767).astype("<i2").tobytes()
    out.write_bytes(pcm_wav_header(len(pcm)) + pcm)
    return out


def _seed(minimal_project, sample_wav):
    reset_record_runtime_for_tests()
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _cmd(ctype: str, *, pid: str = "p_host", role: str = "host", payload: dict | None = None):
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id=f"c-{pid}",
        role=role,  # type: ignore[arg-type]
        participant_id=pid,
        client_seq=next_record_client_seq(),
    )


def _join(svc: RecordSessionService, room, name: str, client: str, seq: int) -> str:
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name=name,
        client_id=client,
        connection_id=f"conn-{client}",
        capabilities=CAPS,
        client_seq=seq,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": seq + 1,
        },
        client_id=client,
        role="guest",
        participant_id=echo["participant_id"],
        seq=seq + 1,
        capabilities=CAPS,
        connection_id=f"conn-{client}",
    )
    return str(echo["participant_id"])


def _bed_pcm() -> bytes:
    rng = np.random.default_rng(2490)
    noise = rng.normal(0.0, 0.002, KEEPER_SAMPLE_RATE * BED_SEC)
    return (np.clip(noise, -1, 1) * 32767).astype("<i2").tobytes()


def _upload_bed(ws, session_id: str, guest: str, pcm: bytes) -> None:
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=session_id,
        take_index=ROOM_TONE_TAKE_INDEX,
        participant_id=guest,
        segment_index=ROOM_TONE_SEGMENT_INDEX,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        kind="room_tone",
    )


def _upload_take(ws, session_id: str, guest: str) -> None:
    pcm = bytes(KEEPER_SAMPLE_RATE * 2)
    wav = pcm_wav_header(len(pcm)) + pcm
    RecordUploadService(ws.project).ingest_part(
        session_id=session_id,
        take_index=0,
        participant_id=guest,
        segment_index=0,
        part_seq=0,
        data=pcm,
        digest=sha256_hex(pcm),
        file_sha256=sha256_hex(wav),
        final=True,
        expected_parts=1,
        join_offset_ms=0,
    )


def _wav_facts(path: Path) -> tuple[int, int, int, int]:
    with wave.open(str(path)) as wav:
        return wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()


def _without_guest(row: dict, guest: str) -> str:
    kept = {k: v for k, v in row.items() if k not in PER_GUEST_KEYS}
    return json.dumps(kept, sort_keys=True).replace(guest, "<guest>")


def test_a_late_guests_room_tone_is_delivered_exactly_like_an_on_time_guests(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    sid = room["session_id"]
    svc = RecordSessionService(ws.project, session_id=sid)
    on_time = _join(svc, room, "Ava", "rec-on-time", 1)
    svc.submit(_cmd("Join", payload={"display_name": "Host"}), now_wall_ms=0)
    svc.submit(_cmd("RoomToneCountdown"), now_wall_ms=1_000)
    late = _join(svc, room, "Bo", "rec-late", 10)
    named = svc.snapshot()["room_tone"]["participant_ids"]
    assert on_time in named and late not in named
    assert svc.upload_consented(on_time, take_index=None)
    assert svc.upload_consented(late, take_index=None)

    pcm = _bed_pcm()
    _upload_bed(ws, sid, on_time, pcm)
    _upload_bed(ws, sid, late, pcm)

    svc.submit(_cmd("Start"), now_wall_ms=10_000)
    svc.submit(_cmd("Stop"), now_wall_ms=13_000)
    _upload_take(ws, sid, on_time)
    _upload_take(ws, sid, late)
    RecordLandingService(ws).land(align=lambda _p: None)
    ws.reload()

    rows = {
        row["participant_id"]: row
        for row in RecordUploadService(ws.project).room_tone_status(session_id=sid)
    }
    assert set(rows) == {on_time, late}
    for row in rows.values():
        assert row["file_ack"] is True and row["landed"] is True
    assert _without_guest(rows[on_time], on_time) == _without_guest(rows[late], late)

    root = Path(ws.project.workspace_dir)
    raw = {guest: root / f"raw/room-tone/{sid}/{guest}.wav" for guest in (on_time, late)}
    assert raw[on_time].read_bytes() == raw[late].read_bytes()
    assert _wav_facts(raw[on_time]) == (1, 2, KEEPER_SAMPLE_RATE, KEEPER_SAMPLE_RATE * BED_SEC)
    assert _wav_facts(raw[late]) == _wav_facts(raw[on_time])
    acked = [
        p
        for p in (
            record_artifacts_dir(ws.project.workspace_dir) / "acked" / sid / "room_tone"
        ).glob("*.wav")
        if p.is_file()
    ]
    assert sorted(p.name for p in acked) == sorted(f"{g}.wav" for g in (on_time, late))
    assert len({p.read_bytes() for p in acked}) == 1

    beds = {}
    for guest in (on_time, late):
        track = ws.project.track_by_id(slug_track_id(guest))
        assert track is not None and track.room_tone is not None
        source = ws.project.source_by_id(room_tone_source_id(track.id))
        assert source is not None
        assert track.room_tone.path == source.path == f"raw/room-tone/{sid}/{guest}.wav"
        beds[guest] = (track, source, room_tone_bed(ws.project, track.id))
    for field in ("duration_sec", "sample_rate", "channels"):
        assert getattr(beds[on_time][0].room_tone, field, None) == getattr(
            beds[late][0].room_tone, field, None
        )
    assert beds[on_time][0].room_tone.duration_sec == pytest.approx(BED_SEC)
    assert beds[on_time][1].speaker == "Ava" and beds[late][1].speaker == "Bo"
    assert _without_guest(
        {**beds[on_time][1].model_dump(), "id": "", "speaker": ""}, on_time
    ) == _without_guest({**beds[late][1].model_dump(), "id": "", "speaker": ""}, late)
    assert _without_guest(beds[on_time][0].room_tone.model_dump(), on_time) == _without_guest(
        beds[late][0].room_tone.model_dump(), late
    )

    early_bed, late_bed = beds[on_time][2], beds[late][2]
    assert not isinstance(early_bed, BedUnavailable)
    assert not isinstance(late_bed, BedUnavailable)
    assert (early_bed.start, early_bed.end) == (late_bed.start, late_bed.end)
    samples = [
        load_mono_window(
            bed.path, start_sec=0.0, duration_sec=BED_SEC, sample_rate=KEEPER_SAMPLE_RATE
        )
        for bed in (early_bed, late_bed)
    ]
    assert np.array_equal(samples[0], samples[1])
    assert samples[0].size == KEEPER_SAMPLE_RATE * BED_SEC
