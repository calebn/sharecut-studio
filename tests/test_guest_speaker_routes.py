"""The guest speaker twins: an Editor splits a recording by speaker and moves a lane range."""

from __future__ import annotations

import json
import logging
import threading
import wave
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.speaker_id import MockSpeakerBackend, _speaker_model_missing
from podcast_mcp.engines.speaker_split import RATE, SpeakerAttribution, SpeakerTurn
from podcast_mcp.gui.schemas import (
    GuestRequest,
    GuestSpeakerMoveLaneSpanRequest,
    GuestSpeakerSplitRequest,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_project_ops import GUEST_MOVE_LANE_SPAN_KEYS
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_review_source,
)
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.jobs import (
    GUEST_EXPORT_KINDS,
    GUEST_PIPELINE_KINDS,
    GUEST_SPEAKER_KINDS,
    Job,
)
from podcast_mcp.services.jobs.job import GUEST_JOB_VIEW
from podcast_mcp.util.coded_error import guest_message_for_code
from podcast_mcp.util.proxy_paths import is_allowed_local_gui_path

OPS_LOGGER = "podcast_mcp.services.collaboration.guest_project_ops"
CODE = "x-sharecut-error-code"
RELAYED = {"x-sharecut-relayed": "1"}
NOT_FOUND = {"detail": "Job not found"}
PREFIX = "/api/review/{token}/daw/speaker"
PROJECTION = {"id", "status", "current", "total", "message", "error"}
PLANTED = "/opt/host/models/ecapa.onnx"
MOVE = {"from_lane": "room", "to_lane": "room_ben", "timeline_start": 0.5, "timeline_end": 1.5}
SPLIT = {"track_id": "room", "speaker_count": 2, "names": ["Ana", "Ben"]}
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
def world(minimal_project, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: _StubBackend(),
    )
    gate, started = threading.Event(), threading.Event()
    gate.set()
    attributed: list[dict] = []

    def attribute(*_args, **kwargs):
        attributed.append(kwargs)
        started.set()
        assert gate.wait(5)
        return SCRIPTED

    monkeypatch.setattr("podcast_mcp.services.media.speaker.attribute_speakers", attribute)
    ws = ProjectWorkspace.open(minimal_project)
    wav = ws.project.raw_dir() / "room.wav"
    noise = 0.1 * np.random.default_rng(0).standard_normal(10 * RATE)
    with wave.open(str(wav), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(np.round(noise * 32767).astype("<i2").tobytes())
    ws.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
    (ws.project.artifacts_dir() / "premix.wav").write_bytes(wav.read_bytes())
    ws.project.tracks = [
        Track(
            id="room",
            label="Room",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/room.wav", duration_sec=10.0),
        )
    ]
    ws.project.clips = [
        Clip(id="clip_room", track_id="room", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    ws.save()
    version = ReviewService(ws).publish(label="Speakers")["id"]
    tokens = {
        role: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    tokens["expired"] = ShareService(ws).create(
        review_version_id=version,
        capabilities=capabilities_for_role("editor"),
        expires_at="2020-01-01T00:00:00Z",
    )["token"]
    app = create_app()
    world = SimpleNamespace(
        client=TestClient(app),
        app=app,
        ws=ws,
        tokens=tokens,
        share=ShareService(ws),
        gate=gate,
        started=started,
        attributed=attributed,
    )
    world.slot = lambda job: setattr(app.state.jobs._catalog, "_job", job)
    yield world
    gate.set()


MOVE_KEYS = set(GUEST_MOVE_LANE_SPAN_KEYS)
ROUTES = {
    "split": ("POST", "/split", SPLIT),
    "move": ("POST", "/move-lane-span", MOVE),
    "status": ("GET", "/status", None),
    "job_status": ("GET", "/jobs/split_speakers-1", None),
    "job_events": ("GET", "/jobs/split_speakers-1/events", None),
    "job_cancel": ("POST", "/jobs/split_speakers-1/cancel", None),
}


def _lanes(world) -> list[str]:
    return [t.id for t in ProjectWorkspace.open(world.ws.path).project.tracks]


def _head(world) -> str:
    return ProjectWorkspace.open(world.ws.path).project.history.head_id()


def _settle(world, job_id: str) -> None:
    world.app.state.jobs.wait(world.app.state.jobs.get_job(job_id), timeout=5)


def _job(world, kind: str = "split_speakers") -> Job:
    job = Job(id=f"{kind}-1", kind=kind, status="running", project_path=str(world.ws.path))
    world.slot(job)
    return job


def _request(world, which: str, link: str = "editor", **body):
    method, suffix, default = ROUTES[which]
    url = (PREFIX + suffix).format(token=world.tokens[link])
    payload = {**default, **body} if default is not None else None
    return world.client.request(method, url, json=payload)


def _split(world, link: str = "editor", **body):
    return _request(world, "split", link, **body)


def _move(world, link: str = "editor", **body):
    return _request(world, "move", link, **body)


def _raw(world, which: str, content: str):
    _method, suffix, _default = ROUTES[which]
    return world.client.post(
        (PREFIX + suffix).format(token=world.tokens["editor"]),
        content=content,
        headers={"content-type": "application/json"},
    )


def _finished_split(world) -> str:
    res = _split(world)
    assert res.status_code == 202
    job_id = res.json()["job"]["id"]
    _settle(world, job_id)
    return job_id


def _urls(world, job_id: str) -> dict[str, tuple[str, str]]:
    base = PREFIX.format(token=world.tokens["editor"]) + f"/jobs/{job_id}"
    return {
        "status": ("GET", base),
        "events": ("GET", base + "/events"),
        "cancel": ("POST", base + "/cancel"),
    }


def _owner_split(world, **body):
    return world.client.post(
        "/api/speaker/split", json={"path": str(world.ws.path), **SPLIT, **body}
    )


def _owner_move(world, **body):
    return world.client.post(
        "/api/speaker/move-lane-span", json={"path": str(world.ws.path), **MOVE, **body}
    )


def _raising(monkeypatch, target: str, error: Exception) -> None:
    def refuse(*_a, **_k):
        raise error

    monkeypatch.setattr(target, refuse)


def _assert_fixed_copy(res, status: int, code: str) -> None:
    assert (res.status_code, res.headers[CODE]) == (status, code)
    assert res.json() == {"detail": guest_message_for_code(code)}


def _assert_same_refusal(guest, owner) -> None:
    assert (guest.status_code, guest.headers[CODE]) == (owner.status_code, owner.headers[CODE])
    assert guest.json() == {"detail": guest_message_for_code(guest.headers[CODE])}


def test_the_rows_are_editor_twins_with_the_flag_only_on_the_start() -> None:
    rows = {n: r for n, r in GUEST_OWNER_ROUTES.items() if n.startswith("speaker_")}

    assert set(rows) == {
        "speaker_split",
        "speaker_status",
        "speaker_job_status",
        "speaker_job_events",
        "speaker_job_cancel",
        "speaker_move_lane_span",
    }
    assert {n for n, r in rows.items() if r.needs_guest_render} == {"speaker_split"}
    assert {n for n, r in rows.items() if r.rate_kind == "mutate"} == {
        "speaker_split",
        "speaker_job_cancel",
        "speaker_move_lane_span",
    }
    assert not any("doctor" in r.path for r in GUEST_OWNER_ROUTES.values())


def _nothing_happened(world, job: Job) -> None:
    assert world.attributed == []
    assert _lanes(world) == ["room"]
    assert not job.cancel_requested


@pytest.mark.parametrize("which", ROUTES)
@pytest.mark.parametrize("link", ["viewer", "commenter"])
def test_a_lesser_role_is_refused_by_every_speaker_twin(world, which, link) -> None:
    job = _job(world)

    res = _request(world, which, link)

    assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")
    _nothing_happened(world, job)


@pytest.mark.parametrize("which", ROUTES)
@pytest.mark.parametrize("link", ["revoked", "expired"])
def test_a_revoked_or_expired_link_is_404_on_every_speaker_twin(world, which, link) -> None:
    job = _job(world)
    if link == "revoked":
        world.share.revoke(world.tokens["editor"])

    res = _request(world, which, "editor" if link == "revoked" else link)

    assert (res.status_code, res.headers[CODE]) == (404, "share_not_found")
    _nothing_happened(world, job)


def test_the_split_needs_the_host_opt_in_and_the_move_does_not(world, monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    _finished_split(world)
    monkeypatch.delenv("PODCAST_GUEST_RENDER")
    attempts = len(world.attributed)

    refused = _split(world, track_id="room")

    assert (refused.status_code, refused.headers[CODE]) == (403, "share_capability_required")
    assert len(world.attributed) == attempts
    assert _move(world).status_code == 200


def test_the_editor_splits_the_track_and_gets_only_the_projection(world, caplog) -> None:
    with caplog.at_level(logging.INFO, logger=OPS_LOGGER):
        res = _split(world)

    assert res.status_code == 202
    assert set(res.json()) == {"job"}
    job = res.json()["job"]
    assert set(job) == PROJECTION
    assert job["message"] == "Splitting speakers"
    for hidden in ("project_path", "config", "track_id", "Ana", "lanes", "room"):
        assert hidden not in res.text
    assert str(world.ws.path.parent) not in res.text
    _settle(world, job["id"])
    assert _lanes(world) == ["room", "room_ben"]
    assert world.app.state.jobs.get_job(job["id"]).kind == "split_speakers"
    _assert_logs_the_share_and_no_token(world, caplog, "guest speaker split")


def _assert_logs_the_share_and_no_token(world, caplog, what: str) -> None:
    row = lookup_share(world.tokens["editor"])
    line = next(r.getMessage() for r in caplog.records if what in r.getMessage())
    assert share_review_source(row).startswith("share:")
    assert share_review_source(row) in line
    assert world.tokens["editor"][:8] not in caplog.text


def test_the_finished_job_shows_done_and_nothing_of_the_result(world) -> None:
    job_id = _finished_split(world)

    res = world.client.get(_urls(world, job_id)["status"][1])

    job = res.json()["job"]
    assert set(job) == PROJECTION
    assert (job["id"], job["status"], job["message"], job["error"]) == (job_id, "ok", None, None)
    for hidden in ("lanes", "history_head_id", "crosstalk", "result", "Ana", "Ben"):
        assert hidden not in res.text


def test_a_result_that_carries_host_text_is_not_projected(world, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.SpeakerService.split_speakers",
        lambda self, *a, **k: {"lanes": [], "path": PLANTED, "saved_to": PLANTED},
    )
    urls = _urls(world, _finished_split(world))

    status = world.client.get(urls["status"][1])
    events = world.client.get(urls["events"][1])
    listing = _request(world, "status")

    for res in (status, events, listing):
        assert res.status_code == 200
        assert PLANTED not in res.text
        assert "saved_to" not in res.text


def test_overlapping_voice_samples_reach_the_job_as_one_span(world) -> None:
    res = _split(world, enrollment={"Ana": [[0.5, 2.0], [1.5, 3.5], [3.5, 4.0]], "Ben": [[6, 9]]})

    assert res.status_code == 202
    _settle(world, res.json()["job"]["id"])
    (kwargs,) = world.attributed
    assert kwargs["enrollment"] == {0: [(0.5, 4.0)], 1: [(6.0, 9.0)]}


@pytest.mark.parametrize(
    ("which", "field"),
    [
        (which, field)
        for which, fields in {
            "split": [
                "path",
                "dest",
                "output_dir",
                "model",
                "model_path",
                "backend",
                "crosstalk_mode",
                "room_tone_fill",
                "dry_run",
                "source_start",
            ],
            "move": ["path", "dest", "source_start", "source_end", "fade_ms"],
        }.items()
        for field in fields
    ],
)
def test_the_bodies_refuse_what_only_the_host_may_send(world, which, field) -> None:
    res = _request(world, which, **{field: "../../etc/passwd"})

    assert res.status_code == 422
    _nothing_happened(world, _job(world))


def test_the_bodies_are_guest_requests_with_no_path() -> None:
    for model in (GuestSpeakerSplitRequest, GuestSpeakerMoveLaneSpanRequest):
        assert issubclass(model, GuestRequest)
        assert "path" not in model.model_fields
    assert set(GuestSpeakerSplitRequest.model_fields) == {
        "track_id",
        "speaker_count",
        "names",
        "enrollment",
    }


SPLIT_BOUNDS = [
    {"speaker_count": 1},
    {"speaker_count": 9},
    {"speaker_count": None},
    {"track_id": ""},
    {"track_id": "t" * 201},
    {"track_id": None},
    {"names": ["x"] * 9},
    {"names": ["Ana", "B" * 81]},
    {"names": "Ana"},
    {"names": ["Ana", ""]},
    {"names": ["Ana", "   "]},
    {"names": ["Ana", "Be\nn"]},
    {"names": ["Ana", "Be\u200bn"]},
    {"names": ["Ana", "Be\x00n"]},
    {"enrollment": {f"s{i}": [[0, 1]] for i in range(9)}},
    {"enrollment": {"N" * 81: [[0, 1]]}},
    {"enrollment": {"": [[0, 1]]}},
    {"enrollment": {" ": [[0, 1]]}},
    {"enrollment": {"A\tna": [[0, 1]]}},
    {"enrollment": {"Ana": []}},
    {"enrollment": {"Ana": [[float(i), i + 0.5] for i in range(17)]}},
    {"enrollment": {"Ana": [[3.0, 1.0]]}},
    {"enrollment": {"Ana": [[1.0, 1.0]]}},
    {"enrollment": {"Ana": [[-1.0, 1.0]]}},
    {"enrollment": {"Ana": [[0, 1, 2]]}},
    {"enrollment": {"Ana": [[0]]}},
    {"enrollment": {"Ana": "0-1"}},
    {"enrollment": {"Ana": [[0, 600.001]]}},
    {"enrollment": {"Ana": [[0, 300], [200, 800]]}},
    {"enrollment": {"Ana": [[0, 1e9]] * 16}},
    {"enrollment": {f"s{i}": [[0, 301]] for i in range(6)}},
]


@pytest.mark.parametrize("bad", SPLIT_BOUNDS)
def test_a_split_body_outside_its_bounds_is_422(world, bad) -> None:
    res = _split(world, **bad)

    assert res.status_code == 422
    _nothing_happened(world, _job(world))


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_a_span_that_is_not_a_finite_number_is_422(world, bad) -> None:
    body = {"track_id": "room", "speaker_count": 2, "enrollment": {"Ana": [[0, "@@"]]}}

    res = _raw(world, "split", json.dumps(body).replace('"@@"', bad))

    assert res.status_code == 422
    assert world.attributed == []


MOVE_BOUNDS = [
    {"from_lane": ""},
    {"to_lane": ""},
    {"from_lane": "l" * 201},
    {"to_lane": "l" * 201},
    {"timeline_start": "soon"},
    {"timeline_end": None},
    {"timeline_start": 1.5, "timeline_end": 0.5},
    {"timeline_start": 1.0, "timeline_end": 1.0},
]


@pytest.mark.parametrize("bad", MOVE_BOUNDS)
def test_a_move_body_outside_its_bounds_is_422(world, bad) -> None:
    res = _move(world, **bad)

    assert res.status_code == 422
    assert _lanes(world) == ["room"]


@pytest.mark.parametrize("field", ["timeline_start", "timeline_end"])
@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity"])
def test_a_move_time_that_is_not_finite_is_422(world, field, bad) -> None:
    res = _raw(world, "move", json.dumps({**MOVE, field: "@@"}).replace('"@@"', bad))

    assert res.status_code == 422


def _spans(seconds: float, *, names: int = 1, extra: float = 0.0) -> dict:
    return {f"s{i}": [[0.0, seconds + (extra if i == 0 else 0.0)]] for i in range(names)}


@pytest.mark.parametrize(
    ("enrollment", "fits"),
    [
        (_spans(600.0), True),
        (_spans(600.0, extra=0.001), False),
        (_spans(450.0, names=4), True),
        (_spans(450.0, names=4, extra=0.001), False),
        ({"A": [[0, 300], [300, 600]]}, True),
        ({"A": [[0, 300], [299.5, 600.5]]}, False),
        ({"A": [[0, 400], [100, 300], [0, 400]]}, True),
    ],
)
def test_the_enrolled_seconds_are_capped_after_overlaps_merge(enrollment, fits) -> None:
    body = {"track_id": "room", "speaker_count": 8, "enrollment": enrollment}

    if fits:
        assert GuestSpeakerSplitRequest(**body)
    else:
        with pytest.raises(ValueError, match="length allowed"):
            GuestSpeakerSplitRequest(**body)


DOMAIN_SPLITS = [
    ({"track_id": "nobody"}, 400, "speaker_split_no_media", False),
    ({"names": ["Ana"]}, 400, "speaker_names_count_mismatch", False),
    ({"names": ["Ana", "Ana"]}, 400, "speaker_names_invalid", False),
    ({"enrollment": {"Cy": [[0, 2]]}}, 400, "speaker_enrolled_name_unknown", False),
    (
        {"names": None, "enrollment": {"A": [[0, 1]], "B": [[2, 3]], "C": [[4, 5]]}},
        400,
        "speaker_enrolled_count_mismatch",
        False,
    ),
    ({}, 400, "speaker_split_already_split", True),
]


@pytest.mark.parametrize(("body", "status", "code", "split_first"), DOMAIN_SPLITS)
def test_a_split_refusal_matches_the_owner_with_fixed_copy(
    world, body, status, code, split_first
) -> None:
    if split_first:
        _finished_split(world)
    lanes = _lanes(world)

    owner = _owner_split(world, **body)
    guest = _split(world, **body)

    assert (guest.status_code, guest.headers[CODE]) == (owner.status_code, owner.headers[CODE])
    assert (guest.status_code, guest.headers[CODE]) == (status, code)
    _assert_fixed_copy(guest, status, code)
    assert _lanes(world) == lanes


def test_a_voice_sample_past_the_end_is_refused_before_a_job_starts(world) -> None:
    res = _split(world, enrollment={"Ana": [[10.0, 12.0]]})

    _assert_fixed_copy(res, 400, "enrollment_past_end")
    assert not world.app.state.jobs.status()["jobs"]
    assert world.attributed == []


def test_a_voice_sample_running_past_the_end_still_starts(world) -> None:
    res = _split(world, enrollment={"Ana": [[8.0, 12.0]]})

    assert res.status_code == 202
    _settle(world, res.json()["job"]["id"])


def test_an_unavailable_backend_is_the_owners_409_with_fixed_copy(world, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: MockSpeakerBackend(),
    )

    owner = _owner_split(world)
    guest = _split(world)

    assert (owner.status_code, owner.headers[CODE]) == (409, "speaker_backend_unavailable")
    _assert_fixed_copy(guest, 409, "speaker_backend_unavailable")
    assert "bootstrap" not in guest.text
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (ValueError(f"bad {PLANTED}"), 400, "speaker_split_invalid"),
        (FileNotFoundError(f"gone {PLANTED}"), 400, "speaker_split_invalid"),
        (RuntimeError(f"no engine at {PLANTED}"), 409, "speaker_split_unavailable"),
        (ImportError(f"onnxruntime missing near {PLANTED}"), 409, "speaker_split_unavailable"),
    ],
)
def test_the_owners_text_carrying_fallbacks_are_the_fixed_500_for_a_guest(
    world, monkeypatch, error, status, code
) -> None:
    _raising(
        monkeypatch, "podcast_mcp.services.jobs.manager.JobManager.start_split_speakers", error
    )

    owner = _owner_split(world)
    guest = _split(world)

    assert (owner.status_code, owner.headers[CODE]) == (status, code)
    assert owner.json() == {"detail": str(error)}
    assert (guest.status_code, guest.headers[CODE]) == (500, "internal_error")
    assert PLANTED not in guest.text


@pytest.mark.parametrize("error", [KeyError(PLANTED), OSError(PLANTED), TypeError(PLANTED)])
@pytest.mark.parametrize(
    ("target", "which"),
    [
        ("podcast_mcp.services.jobs.manager.JobManager.start_split_speakers", "split"),
        ("podcast_mcp.services.media.speaker.SpeakerService.move_lane_span", "move"),
        ("podcast_mcp.services.jobs.manager.JobManager.status", "status"),
    ],
)
def test_a_bare_error_is_the_fixed_500(world, monkeypatch, error, target, which) -> None:
    _raising(monkeypatch, target, error)

    res = _request(world, which)

    assert (res.status_code, res.headers[CODE]) == (500, "internal_error")
    assert PLANTED not in res.text


@pytest.fixture
def model_absent(world, tmp_path, monkeypatch):
    from podcast_mcp.engines import speaker_id
    from podcast_mcp.engines.models import speaker_ecapa

    monkeypatch.setattr(speaker_ecapa, "models_dir", lambda: tmp_path / "no-models")
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)
    monkeypatch.delenv(speaker_id.MOCK_BACKEND_ENV, raising=False)
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        speaker_id.resolve_speaker_backend,
    )
    downloads: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.bootstrap.run_bootstrap",
        lambda *a, **k: downloads.append((a, k)),
    )
    return downloads


def test_a_missing_model_is_the_fixed_409_and_nothing_downloads(
    world, model_absent, tmp_path
) -> None:
    owner = _owner_split(world)
    guest = _split(world)

    assert (owner.status_code, owner.headers[CODE]) == (409, "model_needed")
    assert owner.json()["detail"]["model"]["id"] == "speaker-ecapa"
    _assert_fixed_copy(guest, 409, "model_needed")
    for hidden in ("speaker-ecapa", "ECAPA", "bootstrap", "podcast", str(tmp_path), "MB"):
        assert hidden not in guest.text
    assert model_absent == []
    assert not (tmp_path / "no-models").exists()
    assert not world.app.state.jobs.status()["running"]
    assert _lanes(world) == ["room"]


def test_an_unusable_model_override_is_the_unavailable_409_not_a_path(
    world, model_absent, tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "gone.onnx"))

    guest = _split(world)

    _assert_fixed_copy(guest, 409, "speaker_backend_unavailable")
    assert str(tmp_path) not in guest.text
    assert "PODCAST_MCP" not in guest.text


@pytest.mark.parametrize(
    "failure",
    [
        _speaker_model_missing(),
        FileNotFoundError(f"ffmpeg not found at {PLANTED}"),
        RuntimeError(f"embedding failed in {PLANTED}"),
    ],
)
def test_a_failure_inside_the_job_shows_only_the_failed_copy(world, monkeypatch, failure) -> None:
    _raising(monkeypatch, "podcast_mcp.services.media.speaker.attribute_speakers", failure)
    res = _split(world)
    job_id = res.json()["job"]["id"]
    _settle(world, job_id)
    urls = _urls(world, job_id)

    status = world.client.get(urls["status"][1])
    events = world.client.get(urls["events"][1])

    assert res.status_code == 202
    assert status.json()["job"]["status"] == "error"
    assert status.json()["job"]["error"] == "Speaker split failed"
    for text in (status.text, events.text):
        for hidden in ("/opt/host", "ffmpeg", "speaker-ecapa", "bootstrap"):
            assert hidden not in text
    assert _lanes(world) == ["room"]


def test_a_second_start_while_a_split_runs_is_409_job_running(world) -> None:
    world.gate.clear()
    first = _split(world)
    assert world.started.wait(5)
    second = _split(world)

    assert first.status_code == 202
    assert first.json()["job"]["message"] == "Splitting speakers"
    _assert_fixed_copy(second, 409, "job_running")
    assert str(world.ws.path.parent) not in second.text
    world.gate.set()
    _settle(world, first.json()["job"]["id"])


@pytest.mark.parametrize("kind", ["pipeline", "render_preview", "export", "analyze"])
def test_another_job_holding_the_slot_is_the_same_409(world, kind) -> None:
    job = _job(world, kind=kind)

    res = _split(world)

    _assert_fixed_copy(res, 409, "job_running")
    assert job.id not in res.text
    assert world.attributed == []


def test_the_move_works_while_a_job_holds_the_slot(world) -> None:
    _finished_split(world)
    _job(world, kind="pipeline")

    assert _move(world).status_code == 200


def test_the_split_start_spends_the_mutate_bucket(world, monkeypatch) -> None:
    from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests

    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_BURST", "1")
    reset_host_limiters_for_tests(clock=lambda: 0.0)
    try:
        first, second = _split(world, track_id="nobody"), _split(world, track_id="nobody")
    finally:
        reset_host_limiters_for_tests()

    assert first.status_code == 400
    assert (second.status_code, second.headers[CODE]) == (429, "rate_limited")


@pytest.mark.parametrize("start", [_split, _owner_split], ids=["guest", "host"])
def test_the_editor_sees_and_cancels_a_started_split(world, start) -> None:
    world.gate.clear()
    job_id = start(world).json()["job"]["id"]
    assert world.started.wait(5)
    urls = _urls(world, job_id)

    status = world.client.get(urls["status"][1])
    listing = _request(world, "status")
    cancel = world.client.post(urls["cancel"][1])
    world.gate.set()
    _settle(world, job_id)

    assert status.status_code == cancel.status_code == 200
    assert set(status.json()["job"]) == set(cancel.json()["job"]) == PROJECTION
    assert [j["id"] for j in listing.json()["jobs"]] == [job_id]
    assert listing.json()["running"] is True
    assert str(world.ws.path.parent) not in status.text + cancel.text
    assert world.app.state.jobs.get_job(job_id).status == "cancelled"
    assert _lanes(world) == ["room"]


def test_the_events_stream_the_fixed_projection(world) -> None:
    job_id = _finished_split(world)

    res = world.client.get(_urls(world, job_id)["events"][1])

    frames = [line[len("data:") :] for line in res.text.splitlines() if line.startswith("data:")]
    assert res.status_code == 200
    assert frames
    for frame in frames:
        payload = json.loads(frame)
        assert set(payload.get("job", payload)) <= PROJECTION | {"type"}
    assert "project_path" not in res.text
    assert "lanes" not in res.text


def test_the_speaker_job_twins_work_with_the_flag_off(world, monkeypatch) -> None:
    job = _job(world)
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    assert _request(world, "job_status").status_code == 200
    assert _request(world, "status").status_code == 200
    assert _request(world, "job_cancel").status_code == 200
    assert job.cancel_requested
    job.status = "ok"
    assert _request(world, "job_events").status_code == 200


@pytest.mark.parametrize("which", ["job_status", "job_events", "job_cancel"])
def test_every_job_the_speaker_twins_may_not_reach_answers_the_same_404(world, which) -> None:
    mine = str(world.ws.path)
    cases = {
        "unknown": None,
        "other project": Job(
            id="split_speakers-1", kind="split_speakers", project_path="/elsewhere/ep"
        ),
        "no path": Job(id="split_speakers-1", kind="split_speakers", project_path=""),
        "agent": Job(id="split_speakers-1", kind="agent"),
        "bootstrap": Job.bootstrap("split_speakers-1", ["whisper"]),
        **{
            kind: Job(id="split_speakers-1", kind=kind, project_path=mine)
            for kind in ("pipeline", "render_preview", "export", "bounce", "analyze")
        },
    }
    seen = set()
    for name, job in cases.items():
        world.slot(job)
        res = _request(world, which)
        assert res.status_code == 404, name
        seen.add((json.dumps(res.json()), res.headers[CODE]))
    assert seen == {(json.dumps(NOT_FOUND), "job_not_found")}
    assert not world.app.state.jobs.get_job("split_speakers-1").cancel_requested


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("GET", "pipeline/jobs/{id}"),
        ("GET", "pipeline/jobs/{id}/events"),
        ("POST", "pipeline/jobs/{id}/cancel"),
        ("GET", "render-preview/{id}"),
        ("GET", "export/jobs/{id}"),
        ("GET", "export/jobs/{id}/events"),
        ("POST", "export/jobs/{id}/cancel"),
    ],
)
def test_a_speaker_job_is_not_served_by_the_other_twins(world, method, suffix) -> None:
    job = _job(world)
    url = f"/api/review/{world.tokens['editor']}/daw/" + suffix.format(id=job.id)

    res = world.client.request(method, url)

    assert (res.status_code, res.json()) == (404, NOT_FOUND)
    assert not job.cancel_requested


def test_the_status_listings_are_per_kind(world) -> None:
    _job(world)
    base = f"/api/review/{world.tokens['editor']}/daw"

    pipeline = world.client.get(f"{base}/pipeline/status").json()
    export = world.client.get(f"{base}/export/status").json()
    speaker = _request(world, "status").json()

    assert pipeline == export == {"running": False, "job": None, "jobs": []}
    assert speaker["running"] is True
    assert [j["id"] for j in speaker["jobs"]] == ["split_speakers-1"]
    assert set(speaker["job"]) == PROJECTION
    assert "project_path" not in json.dumps(speaker)


def test_the_kind_sets_are_disjoint_and_the_view_is_fixed_copy() -> None:
    assert not GUEST_SPEAKER_KINDS & (GUEST_PIPELINE_KINDS | GUEST_EXPORT_KINDS)
    assert {"split_speakers"} == GUEST_SPEAKER_KINDS
    view = GUEST_JOB_VIEW["split_speakers"]
    assert (view.running, view.failed) == ("Splitting speakers", "Speaker split failed")


def test_the_guest_mcp_job_tool_does_not_read_a_speaker_job(world, monkeypatch) -> None:
    from podcast_mcp.services.remote_mcp import tools as rt
    from podcast_mcp.util.coded_error import CodedKeyError

    jobs = world.app.state.jobs
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(rt, "get_remote_mcp_context", lambda: SimpleNamespace(workspace=world.ws))
    monkeypatch.setattr("podcast_mcp.services.jobs.shared_job_manager", lambda: jobs)
    job = _job(world)

    with pytest.raises(CodedKeyError) as raised:
        rt.guest_render_preview_job(job.id)
    assert raised.value.code == "job_not_found"


def test_the_move_moves_the_range_and_answers_the_allowlist(world, caplog) -> None:
    _finished_split(world)

    with caplog.at_level(logging.INFO, logger=OPS_LOGGER):
        res = _move(world)

    assert res.status_code == 200
    assert set(res.json()) == MOVE_KEYS
    assert res.json()["history_head_id"] == _head(world)
    assert str(world.ws.path.parent) not in res.text
    _assert_logs_the_share_and_no_token(world, caplog, "guest speaker move")


def test_the_move_is_the_owners_answer(world) -> None:
    _finished_split(world)
    guest = _move(world)
    HistoryService(ProjectWorkspace.open(world.ws.path)).undo()

    owner = _owner_move(world)

    assert guest.status_code == owner.status_code == 200
    assert {k: v for k, v in guest.json().items() if k != "history_head_id"} == {
        k: v for k, v in owner.json().items() if k != "history_head_id"
    }
    assert set(owner.json()) == MOVE_KEYS


def test_the_move_answers_only_the_allowlist(world, monkeypatch) -> None:
    planted = dict.fromkeys(MOVE_KEYS, 1) | {"path": PLANTED, "saved_to": PLANTED}
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.SpeakerService.move_lane_span",
        lambda self, *a, **k: planted,
    )

    res = _move(world)

    assert res.status_code == 200
    assert set(res.json()) == MOVE_KEYS
    assert PLANTED not in res.text


def test_a_move_result_missing_a_key_is_the_fixed_500(world, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.SpeakerService.move_lane_span",
        lambda self, *a, **k: {"from_lane": PLANTED},
    )

    res = _move(world)

    assert (res.status_code, res.headers[CODE]) == (500, "internal_error")
    assert PLANTED not in res.text


DOMAIN_MOVES = [
    ({"to_lane": "room"}, "speaker_move_lane_span_same_lane", True),
    ({"to_lane": "nobody"}, "speaker_move_lane_span_not_sibling", True),
    ({"timeline_start": 30.0, "timeline_end": 31.0}, "speaker_move_lane_span_timeline", True),
    ({}, "speaker_move_lane_span_not_sibling", False),
]


@pytest.mark.parametrize(("body", "code", "split_first"), DOMAIN_MOVES)
def test_a_move_refusal_matches_the_owner_with_fixed_copy(world, body, code, split_first) -> None:
    if split_first:
        _finished_split(world)

    owner = _owner_move(world, **body)
    guest = _move(world, **body)

    assert (owner.status_code, owner.headers[CODE]) == (400, code)
    _assert_same_refusal(guest, owner)
    assert guest.json() != owner.json()


def test_the_move_is_one_undo_step_for_the_host(world) -> None:
    _finished_split(world)
    before = _head(world)

    res = _move(world)
    HistoryService(ProjectWorkspace.open(world.ws.path)).undo()

    assert res.status_code == 200
    assert _head(world) == before


@pytest.mark.parametrize(
    ("path", "body"),
    [("/api/speaker/split", SPLIT), ("/api/speaker/move-lane-span", MOVE)],
)
def test_a_relayed_owner_call_is_refused(world, path, body) -> None:
    res = world.client.post(path, json={"path": str(world.ws.path), **body}, headers=RELAYED)

    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")
    assert world.attributed == []
    assert _lanes(world) == ["room"]


def test_the_doctor_stays_host_only(world) -> None:
    res = world.client.get("/api/speaker/doctor", headers=RELAYED)
    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")

    guest = world.client.get((PREFIX + "/doctor").format(token=world.tokens["editor"]))

    assert guest.status_code == 404


def test_the_tunnel_allowlist_admits_the_speaker_twins_and_not_the_owner_routes() -> None:
    for path in ("/api/speaker/split", "/api/speaker/move-lane-span", "/api/speaker/doctor"):
        assert not is_allowed_local_gui_path(path, "tok")
    for row in GUEST_OWNER_ROUTES.values():
        if row.name.startswith("speaker_"):
            assert is_allowed_local_gui_path(row.path.format(token="tok", job_id="j"), "tok")
