from podcast_mcp.models import load_project
from podcast_mcp.services.record import service as service_mod
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.record.state import PauseEntry, RecordSnapshot, TakeState
from podcast_mcp.services.record.upload import RecordUploadService


def test_snapshot_origin_and_one_wall_sample(minimal_project, monkeypatch):
    project = load_project(minimal_project)
    svc = RecordSessionService(project, session_id="preview-session")
    snap = RecordSnapshot(
        session_id="preview-session",
        state="recording",
        take_index=2,
        takes=[
            TakeState(
                take_index=0,
                session_start_wall_ms=0,
                session_start_iso="first",
                stopped_wall_ms=8_000,
                pauses=[PauseEntry(seq=1, pause_wall_ms=2_000, resume_wall_ms=5_000)],
            ),
            TakeState(
                take_index=1,
                session_start_wall_ms=10_000,
                session_start_iso="second",
                stopped_wall_ms=12_000,
            ),
            TakeState(take_index=2, session_start_wall_ms=15_000, session_start_iso="current"),
        ],
    )
    monkeypatch.setattr(svc, "_model", lambda: snap)
    samples = []

    def wall():
        samples.append(True)
        return 16_000_000_000

    monkeypatch.setattr(service_mod.time, "time_ns", wall)
    out = svc.snapshot()
    assert samples == [True]
    assert out["server_time_ns"] == 16_000_000_000
    assert out["recording_ms"] == 1_000
    assert out["timeline_start_sec"] == 11  # 5 + gap + 2 + gap
    samples.clear()
    upload = RecordUploadService(project)
    upload.tombstone_take(snap.session_id, 0)
    assert svc.snapshot()["timeline_start_sec"] == 4
    snap.state = "paused"
    assert svc.snapshot()["timeline_start_sec"] == 4
    upload.tombstone_take(snap.session_id, 2)
    assert svc.snapshot()["timeline_start_sec"] is None
    snap.take_index = 99
    assert svc.snapshot()["timeline_start_sec"] is None
    for state in ("lobby", "stopped"):
        snap.state = state
        assert svc.snapshot()["timeline_start_sec"] is None
    assert "timeline_start_sec" not in snap.model_dump()
