"""Studio's Split speakers: a pipeline-slot job and a thin route over SpeakerService (#1095)."""

from __future__ import annotations

import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import numpy as np
import pytest

from podcast_mcp.engines.speaker_split import RATE, SpeakerAttribution, SpeakerTurn
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.jobs.reporter import JobProgressReporter
from podcast_mcp.util.coded_error import CodedValueError

SCRIPTED = SpeakerAttribution(
    speaker_count=2,
    duration=10.0,
    turns=(
        SpeakerTurn(0.0, 4.0, (0,), 0.9),
        SpeakerTurn(4.0, 6.0, (0, 1), 0.2),
        SpeakerTurn(6.0, 10.0, (1,), 0.9),
    ),
    backend="stub",
    method="cluster",
)


class _StubBackend:
    def name(self) -> str:
        return "stub"


@pytest.fixture
def room(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: _StubBackend(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.attribute_speakers",
        lambda *_args, **_kwargs: SCRIPTED,
    )
    ws = ProjectWorkspace.create(tmp_path / "ep")
    wav = ws.project.workspace_path() / "raw" / "room.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    noise = 0.1 * np.random.default_rng(0).standard_normal(10 * RATE)
    with wave.open(str(wav), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(np.round(noise * 32767).astype("<i2").tobytes())
    ws.project.tracks.append(
        Track(
            id="room",
            label="Room",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/room.wav", duration_sec=10.0),
        )
    )
    ws.project.clips.append(
        Clip(id="clip_room", track_id="room", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    ws.save()
    return ws.path


def test_the_job_splits_the_track_and_hands_back_the_service_result(room: Path) -> None:
    manager = JobManager()
    job = manager.start_split_speakers(room, track_id="room", speaker_count=2, names=["Ana", "Ben"])
    manager.wait(job, timeout=5)
    snap = job.snapshot()
    assert (snap["kind"], snap["label"], snap["status"]) == (
        "split_speakers",
        "Split speakers",
        "ok",
    )
    result = snap["result"]
    assert [lane["track_id"] for lane in result["lanes"]] == ["room", "room_ben"]
    assert result["crosstalk_sec"] == 2.0
    assert result["low_confidence_sec"] == 2.0
    ws = ProjectWorkspace.open(room)
    assert result["history_head_id"] == ws.project.history.head_id()
    assert [t.label for t in ws.project.tracks] == ["Ana", "Ben"]
    HistoryService(ws).undo()
    assert [t.id for t in ProjectWorkspace.open(room).project.tracks] == ["room"]


def test_the_project_view_marks_the_lanes_of_a_split(room: Path) -> None:
    from podcast_mcp.gui.assembler import build_project_view

    assert [t.speaker_split_id for t in build_project_view(room).tracks] == [None]
    manager = JobManager()
    job = manager.start_split_speakers(room, track_id="room", speaker_count=2)
    manager.wait(job, timeout=5)
    lanes = build_project_view(room).tracks
    split_id = ProjectWorkspace.open(room).project.editorial.speaker_splits[0].id
    assert [(t.id, t.speaker_split_id) for t in lanes] == [
        ("room", split_id),
        ("room_speaker_2", split_id),
    ]


def test_a_split_that_cannot_run_is_refused_before_a_job_starts(room: Path) -> None:
    mgr = JobManager()
    with pytest.raises(ValueError, match="no media to split"):
        mgr.start_split_speakers(room, track_id="nobody", speaker_count=2)
    with pytest.raises(ValueError, match="expected 2 speaker names"):
        mgr.start_split_speakers(room, track_id="room", speaker_count=2, names=["Ana"])
    assert mgr.status()["jobs"] == []


def test_an_unusable_enrollment_span_is_refused_before_a_job_starts(room: Path) -> None:
    mgr = JobManager()
    with pytest.raises(CodedValueError) as raised:
        mgr.start_split_speakers(
            room,
            track_id="room",
            speaker_count=2,
            names=["Ana", "Ben"],
            enrollment={"Ana": [(5.0, 2.0)]},
        )
    assert raised.value.code == "enrollment_span_invalid"
    assert mgr.status()["jobs"] == []


def test_a_cancel_request_during_attribution_leaves_the_project_alone(
    room: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.util.progress import raise_if_cancel_requested

    def attributing(*_args, cancel_check, **_kwargs):
        while True:
            raise_if_cancel_requested(cancel_check)
            time.sleep(0.01)

    monkeypatch.setattr("podcast_mcp.services.media.speaker.attribute_speakers", attributing)
    mgr = JobManager()
    job = mgr.start_split_speakers(room, track_id="room", speaker_count=2)
    mgr.cancel(job.id)
    mgr.wait(job, timeout=5)
    assert (job.status, job.message) == ("cancelled", "Split speakers cancelled")
    assert [t.id for t in ProjectWorkspace.open(room).project.tracks] == ["room"]


@pytest.mark.parametrize(
    ("field", "value", "initial_duration"),
    [
        ("path", "raw/replaced.wav", 10.0),
        ("duration_sec", 11.0, 10.0),
        ("duration_sec", 11.0, None),
    ],
)
def test_refuses_attribution_when_primary_media_changes_before_the_locked_split(
    room: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str | float,
    initial_duration: float | None,
) -> None:
    from podcast_mcp.services.media.speaker import SpeakerService
    from podcast_mcp.util.coded_error import CodedValueError

    attributed = Event()
    release = Event()

    if initial_duration is None:
        ws = ProjectWorkspace.open(room)
        ws.mutate(
            "remove declared duration",
            "remove declared duration",
            lambda project: setattr(project.track_by_id("room").media, "duration_sec", None),
        )

    def hold_attribution(*_args, **_kwargs):
        attributed.set()
        if not release.wait(timeout=5):
            raise TimeoutError("test did not release attribution")
        return SCRIPTED

    monkeypatch.setattr("podcast_mcp.services.media.speaker.attribute_speakers", hold_attribution)
    service = SpeakerService(ProjectWorkspace.open(room))
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            service.split_speakers,
            "room",
            speaker_count=2,
            names=["Ana", "Ben"],
            dry_run=False,
        )
        try:
            assert attributed.wait(timeout=5)
            concurrent = ProjectWorkspace.open(room)

            def change_media(project) -> None:
                media = project.track_by_id("room").media
                assert media is not None
                setattr(media, field, value)

            concurrent.mutate(
                "before concurrent media edit",
                "after concurrent media edit",
                change_media,
            )
            concurrent_head = ProjectWorkspace.open(room).project.history.head_id()
        finally:
            release.set()

        with pytest.raises(CodedValueError) as caught:
            future.result(timeout=5)

    assert caught.value.code == "speaker_split_media_changed"
    saved = ProjectWorkspace.open(room).project
    assert saved.history.head_id() == concurrent_head
    assert [track.id for track in saved.tracks] == ["room"]
    assert saved.editorial.speaker_splits == []
    saved_media = saved.track_by_id("room").media
    assert saved_media is not None
    assert getattr(saved_media, field) == value


def test_service_accepts_an_unchanged_nullable_declared_duration(
    room: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.services.media.speaker import SpeakerService

    ws = ProjectWorkspace.open(room)
    ws.mutate(
        "remove declared duration",
        "remove declared duration",
        lambda project: setattr(project.track_by_id("room").media, "duration_sec", None),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.attribute_speakers",
        lambda *_args, **_kwargs: SCRIPTED,
    )

    result = SpeakerService(ProjectWorkspace.open(room)).split_speakers(
        "room", speaker_count=2, names=["Ana", "Ben"], dry_run=False
    )

    assert result["lanes"]
    assert [track.id for track in ProjectWorkspace.open(room).project.tracks] == [
        "room",
        "room_ben",
    ]


def test_cancel_after_split_commit_keeps_the_job_result_and_history_head(
    room: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.media.speaker import SpeakerService

    returned = Event()
    release = Event()
    real_split = SpeakerService.split_speakers

    def split_then_hold(self, *args, **kwargs):
        result = real_split(self, *args, **kwargs)
        returned.set()
        if not release.wait(timeout=5):
            raise TimeoutError("test did not release the committed split")
        return result

    monkeypatch.setattr(SpeakerService, "split_speakers", split_then_hold)
    manager = JobManager()
    job = manager.start_split_speakers(room, track_id="room", speaker_count=2, names=["Ana", "Ben"])
    try:
        assert returned.wait(timeout=5)
        assert [track.id for track in ProjectWorkspace.open(room).project.tracks] == [
            "room",
            "room_ben",
        ]
        manager.cancel(job.id)
    finally:
        release.set()
    manager.wait(job, timeout=5)

    snap = job.snapshot()
    assert snap["status"] == "cancelled"
    assert snap["result"]["lanes"]
    assert (
        snap["result"]["history_head_id"] == ProjectWorkspace.open(room).project.history.head_id()
    )


def test_the_determinate_bar_follows_the_attribution_task(room: Path) -> None:
    job = Job(
        id="s1",
        project_path=str(room),
        from_step=None,
        only_step=None,
        kind="split_speakers",
        status="running",
    )
    reporter = JobProgressReporter(job)
    try:
        reporter.start("speaker-split", "Speaker split", total=3)
        reporter.update("speaker-split", 2)
    finally:
        reporter.close()
    assert (job.current, job.total) == (2, 3)


def _client():
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    return TestClient(create_app())


def test_the_route_starts_a_split_job(room: Path) -> None:
    client = _client()
    res = client.post(
        "/api/speaker/split",
        json={"path": str(room), "track_id": "room", "speaker_count": 2, "names": ["Ana", "Ben"]},
    )
    assert res.status_code == 200
    job_id = res.json()["job"]["id"]
    assert res.json()["job"]["kind"] == "split_speakers"
    started = client.app.state.jobs.get_job(job_id)
    assert started is not None
    client.app.state.jobs.wait(started, timeout=5)
    job = client.get("/api/pipeline/status").json().get("job")
    assert job is not None
    assert job["id"] == job_id
    assert job["status"] == "ok"
    assert [lane["name"] for lane in job["result"]["lanes"]] == ["Ana", "Ben"]


def test_the_route_hands_the_enrollment_to_the_service_unchanged(
    room: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict = {}
    from podcast_mcp.services.media.speaker import SpeakerService

    real = SpeakerService.split_speakers

    def spy(self, *args, **kwargs):
        seen.update(kwargs)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(SpeakerService, "split_speakers", spy)
    started: list[Job] = []
    start = JobManager.start_split_speakers

    def capture(self, *args, **kwargs):
        started.append(start(self, *args, **kwargs))
        return started[-1]

    monkeypatch.setattr(JobManager, "start_split_speakers", capture)
    client = _client()
    res = client.post(
        "/api/speaker/split",
        json={
            "path": str(room),
            "track_id": "room",
            "speaker_count": 2,
            "names": ["Ana", "Ben"],
            "enrollment": {"Ana": [[0.5, 3.5]], "Ben": [[6.0, 9.0]]},
        },
    )
    assert res.status_code == 200
    client.app.state.jobs.wait(started[0], timeout=5)
    job = started[0].snapshot()
    assert job["status"] == "ok"
    assert seen["enrollment"] == {"Ana": [(0.5, 3.5)], "Ben": [(6.0, 9.0)]}


def test_a_relayed_guest_cannot_start_a_split(room: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    before = room.read_bytes()
    client = _client()
    res = client.post(
        "/api/speaker/split",
        json={"path": str(room), "track_id": "room", "speaker_count": 2, "names": ["Ana", "Ben"]},
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert client.get("/api/pipeline/status").json().get("job") is None
    assert room.read_bytes() == before
    assert [t.id for t in ProjectWorkspace.open(room).project.tracks] == ["room"]


@pytest.mark.parametrize(
    ("body", "status", "detail"),
    [
        ({"track_id": "nobody", "speaker_count": 2}, 400, "no media to split"),
        ({"track_id": "room", "speaker_count": 1}, 422, None),
        ({"track_id": "room", "speaker_count": 9}, 422, None),
        ({"track_id": "room", "speaker_count": 2, "names": ["Ana"]}, 400, "expected 2"),
        ({"track_id": "room", "speaker_count": 2, "names": ["Ana", "B" * 81]}, 422, None),
        ({"track_id": "room", "speaker_count": 8, "names": ["x"] * 9}, 422, None),
        ({"track_id": "room", "speaker_count": 2, "enrollment": {"Ana": [[3.0, 1.0]]}}, 422, None),
        ({"track_id": "room", "speaker_count": 2, "enrollment": {"Ana": []}}, 422, None),
        (
            {
                "track_id": "room",
                "speaker_count": 2,
                "names": ["Ana", "Ben"],
                "enrollment": {"Cy": [[0, 2]]},
            },
            400,
            "not one of the names",
        ),
    ],
)
def test_the_route_refuses_what_the_service_would(
    room: Path, body: dict, status: int, detail: str | None
) -> None:
    res = _client().post("/api/speaker/split", json={"path": str(room), **body})
    assert res.status_code == status
    if detail:
        assert detail in res.json()["detail"]


def test_the_route_returns_a_plain_coded_refusal_when_speaker_recognition_is_unavailable(
    room: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.speaker_id import MockSpeakerBackend

    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: MockSpeakerBackend(),
    )
    res = _client().post(
        "/api/speaker/split", json={"path": str(room), "track_id": "room", "speaker_count": 2}
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "speaker_backend_unavailable"
    assert res.json()["detail"] == (
        "Speaker recognition isn't available on this computer. "
        "In the Split speakers dialog, choose Download speaker model "
        "(or run podcast bootstrap --component speaker-ecapa)."
    )
    assert "extra" not in res.json()["detail"]


def test_the_route_maps_an_unavailable_backend_to_409(
    room: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.speaker_id import SpeakerBackendUnavailable

    def _raise(name=None):
        raise SpeakerBackendUnavailable()

    monkeypatch.setattr("podcast_mcp.services.media.speaker.resolve_speaker_backend", _raise)
    res = _client().post(
        "/api/speaker/split", json={"path": str(room), "track_id": "room", "speaker_count": 2}
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "speaker_backend_unavailable"


@pytest.fixture
def model_absent(room: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.engines import speaker_id
    from podcast_mcp.engines.models import speaker_ecapa

    monkeypatch.setattr(speaker_ecapa, "models_dir", lambda: tmp_path / "no-models")
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)
    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        speaker_id.resolve_speaker_backend,
    )


def test_the_route_asks_for_the_model_when_it_is_not_downloaded(
    room: Path, model_absent: None, tmp_path: Path
) -> None:
    res = _client().post(
        "/api/speaker/split", json={"path": str(room), "track_id": "room", "speaker_count": 2}
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "model_needed"
    assert res.headers["Cache-Control"] == "no-store"
    detail = res.json()["detail"]
    assert detail["model"]["id"] == "speaker-ecapa"
    assert detail["model"]["state"] == "missing"
    assert "podcast bootstrap --component speaker-ecapa" in detail["detail"]
    assert str(tmp_path) not in res.text


def test_the_route_does_not_offer_a_download_for_an_override_that_is_missing(
    room: Path, model_absent: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "gone.onnx"))
    res = _client().post(
        "/api/speaker/split", json={"path": str(room), "track_id": "room", "speaker_count": 2}
    )
    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "speaker_backend_unavailable"
    assert str(tmp_path) not in res.text


def test_the_speaker_doctor_route_is_host_only_and_uses_the_service_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.media.speaker import SpeakerService
    from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    report = {"available_backends": ["mock"], "recommended": "mock"}
    monkeypatch.setattr(SpeakerService, "doctor_static", staticmethod(lambda: report))
    client = TestClient(create_app())

    res = client.get("/api/speaker/doctor")
    assert res.status_code == 200
    assert res.json() == report

    guest = client.get("/api/speaker/doctor", headers={"X-Sharecut-Relayed": "1"})
    assert guest.status_code == 403
    assert guest.json() == {"detail": HOST_ROLE_RELAYED_REASON}


def test_move_lane_span_route_moves_timeline_range_on_split_lanes(room: Path) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
    from test_speaker_split import SCRIPTED, _split_track

    ws = ProjectWorkspace.open(room)
    ws.project.transcripts.append(
        Transcript(
            track_id="room",
            words=[TranscriptWord(text="hello", start=1.0, end=1.4)],
        )
    )
    _split_track(ws.project, "room", SCRIPTED, names=["Ana", "Ben"])
    ws.save()
    client = TestClient(create_app())
    guest = client.post(
        "/api/speaker/move-lane-span",
        json={
            "path": str(room),
            "from_lane": "room",
            "to_lane": "room_ben",
            "timeline_start": 1.0,
            "timeline_end": 1.4,
        },
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert guest.status_code == 403
    assert guest.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    res = client.post(
        "/api/speaker/move-lane-span",
        json={
            "path": str(room),
            "from_lane": "room",
            "to_lane": "room_ben",
            "timeline_start": 1.0,
            "timeline_end": 1.4,
        },
    )
    assert res.status_code == 200
    assert res.json()["words_moved"] == 1
    bad = client.post(
        "/api/speaker/move-lane-span",
        json={
            "path": str(room),
            "from_lane": "room",
            "to_lane": "room",
            "timeline_start": 1.0,
            "timeline_end": 1.4,
        },
    )
    assert bad.status_code == 400
    assert bad.headers["X-Sharecut-Error-Code"] == "speaker_move_lane_span_same_lane"


def test_the_route_conflicts_while_another_slot_job_runs(room: Path) -> None:
    from podcast_mcp.gui.server import create_app

    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    app = create_app()
    app.state.jobs._job = Job(
        id="pipe", project_path=str(room), from_step=None, only_step=None, status="running"
    )
    res = TestClient(app).post(
        "/api/speaker/split", json={"path": str(room), "track_id": "room", "speaker_count": 2}
    )
    assert res.status_code == 409
