"""Host routes (record, shares, comments, pipeline, speaker, review daw) carry stable error codes (#1855)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.util.coded_error import CodedValueError

CODE = "X-Sharecut-Error-Code"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    return TestClient(create_app())


def _check(res: Any, status: int, code: str) -> None:
    assert res.status_code == status, res.text
    assert res.headers[CODE] == code


def _raiser(exc: BaseException):
    def boom(*_a: object, **_k: object) -> None:
        raise exc

    return boom


# ---- record_host.py -------------------------------------------------------------------------


def test_record_routes_without_room(minimal_project: Path, client: TestClient) -> None:
    p = str(minimal_project)
    _check(client.get("/api/record/state", params={"path": p}), 404, "record_room_not_found")
    _check(
        client.post("/api/record/command", json={"path": p, "command_type": "start"}),
        404,
        "record_room_not_found",
    )
    _check(client.get("/api/record/upload", params={"path": p}), 404, "record_room_not_found")
    _check(client.delete("/api/record/upload", params={"path": p}), 404, "record_room_not_found")
    _check(client.post("/api/record/land", params={"path": p}), 404, "record_room_not_found")
    _check(
        client.post("/api/record/discard-take", json={"path": p, "take_index": 1}),
        404,
        "record_room_not_found",
    )


def test_record_delete_upload_kind_refusals(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.gui.routes import record_host

    monkeypatch.setattr(
        record_host.RecordSessionService, "active_session_id", staticmethod(lambda _p: "s1")
    )
    p = str(minimal_project)
    # The query type already rejects unknown kinds, so drive the service-level refusal directly.
    from podcast_mcp.services.record import RecordUploadError

    with monkeypatch.context() as m:
        m.setattr(record_host, "parse_upload_kind", _raiser(RecordUploadError("bad kind")))
        _check(
            client.delete("/api/record/upload", params={"path": p}),
            400,
            "record_upload_refused",  # a RecordUploadError keeps its own code
        )
    res = client.delete("/api/record/upload", params={"path": p})
    _check(res, 400, "record_upload_kind_unrevocable")
    assert res.json() == {"detail": "only room_tone can be revoked"}


def test_record_control_refusals(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.gui.routes import record_host
    from podcast_mcp.services.record import (
        RecordAuthzError,
        RecordLandingError,
        RecordStateError,
    )

    class FakeControl:
        exc: BaseException

        def __init__(self, _ws: object) -> None:
            pass

        def submit_host(self, *_a: object) -> None:
            raise self.exc

        def land(self) -> None:
            raise self.exc

        def discard_take(self, _i: int) -> None:
            raise self.exc

    monkeypatch.setattr(record_host, "RecordControlService", FakeControl)
    p = str(minimal_project)
    cmd = {"path": p, "command_type": "start"}

    FakeControl.exc = RecordAuthzError("nope")
    _check(client.post("/api/record/command", json=cmd), 403, "record_command_not_allowed")
    FakeControl.exc = ValueError("bad")
    _check(client.post("/api/record/command", json=cmd), 400, "record_command_refused")
    # A coded exception keeps its own code.
    FakeControl.exc = RecordStateError("busy", code="record_join_required")
    _check(client.post("/api/record/command", json=cmd), 400, "record_join_required")
    FakeControl.exc = RecordLandingError("no takes", code="landing_registration_unreadable")
    _check(
        client.post("/api/record/land", params={"path": p}), 400, "landing_registration_unreadable"
    )
    FakeControl.exc = RecordLandingError("no takes", code="record_landing_refused")
    _check(
        client.post("/api/record/discard-take", json={"path": p, "take_index": 1}),
        400,
        "record_landing_refused",
    )


# ---- shares.py ------------------------------------------------------------------------------


def test_share_routes_refusals(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.gui.routes import shares
    from podcast_mcp.services.record import RecordStateError

    class FakeShares:
        exc: BaseException

        def __init__(self, _ws: object) -> None:
            pass

        def create_for_host(self, **_k: object) -> None:
            raise self.exc

        def revoke(self, _t: str) -> None:
            raise self.exc

        def create_record_room(self, **_k: object) -> None:
            raise self.exc

        def replace_closed_record_invite(self, *_a: object, **_k: object) -> None:
            raise self.exc

        def revoke_room(self, _s: str) -> None:
            raise self.exc

    monkeypatch.setattr(shares, "ShareService", FakeShares)
    p = str(minimal_project)
    body = {"path": p}

    FakeShares.exc = ValueError("bad role")
    _check(client.post("/api/shares", json=body), 400, "share_create_invalid")
    FakeShares.exc = KeyError("version")
    _check(client.post("/api/shares", json=body), 400, "share_create_target_unknown")
    FakeShares.exc = FileNotFoundError("mix")
    _check(client.post("/api/shares", json=body), 400, "share_create_media_missing")
    FakeShares.exc = KeyError("tok")
    _check(client.post("/api/shares/tok/revoke", json=body), 404, "share_not_found")
    FakeShares.exc = RecordStateError("live")
    _check(
        client.post("/api/shares/record", json=body), 409, "record_state_refused"
    )  # RecordStateError's own code
    FakeShares.exc = ValueError("expires")
    _check(client.post("/api/shares/record", json=body), 400, "record_room_request_invalid")
    FakeShares.exc = KeyError("tok")
    _check(client.post("/api/shares/record/tok/replace", json=body), 404, "share_not_found")
    FakeShares.exc = RecordStateError("open")
    _check(
        client.post("/api/shares/record/tok/replace", json=body),
        409,
        "record_state_refused",
    )
    FakeShares.exc = KeyError("room")
    _check(client.post("/api/shares/rooms/r1/revoke", json=body), 404, "record_room_not_found")


# ---- speaker.py -----------------------------------------------------------------------------


def test_speaker_split_refusals(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = type(client.app.state.jobs)  # type: ignore[attr-defined]
    body = {"path": str(minimal_project), "track_id": "host", "speaker_count": 2}

    monkeypatch.setattr(
        jobs, "start_split_speakers", _raiser(CodedValueError("x", code="speaker_names_invalid"))
    )
    _check(client.post("/api/speaker/split", json=body), 400, "speaker_names_invalid")
    monkeypatch.setattr(
        jobs,
        "start_split_speakers",
        _raiser(CodedValueError("x", code="speaker_backend_unavailable")),
    )
    _check(client.post("/api/speaker/split", json=body), 409, "speaker_backend_unavailable")
    monkeypatch.setattr(jobs, "start_split_speakers", _raiser(RuntimeError("busy")))
    _check(client.post("/api/speaker/split", json=body), 409, "speaker_split_unavailable")
    monkeypatch.setattr(jobs, "start_split_speakers", _raiser(FileNotFoundError("gone")))
    _check(client.post("/api/speaker/split", json=body), 400, "speaker_split_invalid")


# ---- comments.py ----------------------------------------------------------------------------


def test_comment_refusals(minimal_project: Path, client: TestClient) -> None:
    p = str(minimal_project)
    _check(
        client.patch("/api/comments/missing", json={"path": p, "resolved": True}),
        400,
        "comment_resolver_required",
    )
    _check(
        client.patch("/api/comments/missing", json={"path": p, "resolved": True, "by": "me"}),
        404,
        "comment_not_found",
    )
    _check(
        client.post(
            "/api/comments/missing/actions/a1/done", json={"path": p, "done": True, "by": "me"}
        ),
        404,
        "comment_not_found",
    )
    _check(
        client.post(
            "/api/comments/missing/replies", json={"path": p, "body": "hi", "author": "me"}
        ),
        404,
        "comment_not_found",
    )
    _check(client.delete("/api/comments/missing", params={"path": p}), 404, "comment_not_found")
    _check(
        client.post(
            "/api/comments",
            json={"path": p, "body": "   ", "author": "me", "timeline_start": 0.0},
        ),
        400,
        "empty_text",
    )


# ---- pipeline.py ----------------------------------------------------------------------------


def test_pipeline_refusals(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = str(minimal_project)
    _check(
        client.post("/api/pipeline/run", json={"path": p, "from_step": "nope"}),
        400,
        "pipeline_from_step_unknown",
    )
    _check(
        client.post("/api/pipeline/run", json={"path": p, "only_step": "nope"}),
        400,
        "pipeline_only_step_unknown",
    )
    _check(
        client.post("/api/pipeline/run", json={"path": p, "skip_steps": ["nope"]}),
        400,
        "pipeline_skip_steps_unknown",
    )
    from podcast_mcp.gui.routes import pipeline

    class FakeStore:
        put = staticmethod(_raiser(ValueError("bad value")))

    with monkeypatch.context() as m:
        m.setattr(pipeline, "config_store", lambda: FakeStore)
        _check(client.put("/api/pipeline/config", json={"path": p}), 400, "invalid_request")
    _check(client.post("/api/pipeline/cancel", json={"job_id": "nope"}), 404, "job_not_found")
    _check(client.get("/api/pipeline/events", params={"job_id": "nope"}), 404, "job_not_found")

    monkeypatch.setattr(pipeline, "ensure_whisper_cached_for_run", lambda **_k: None)
    jobs = type(client.app.state.jobs)  # type: ignore[attr-defined]
    for name, url, body in (
        ("start_analyze", "/api/pipeline/analyze", {"path": p}),
        ("start_render_preview", "/api/pipeline/render-preview", {"path": p}),
        ("start", "/api/pipeline/run", {"path": p, "use_working_set": False}),
    ):
        monkeypatch.setattr(jobs, name, _raiser(RuntimeError("a job is running")))
        _check(client.post(url, json=body), 409, "pipeline_busy")


def test_pipeline_model_needed(
    minimal_project: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.models.registry import require_model
    from podcast_mcp.gui.routes import pipeline

    monkeypatch.setattr(
        pipeline, "ensure_whisper_cached_for_run", lambda **_k: require_model("rnnoise")
    )
    _check(
        client.post("/api/pipeline/run", json={"path": str(minimal_project)}),
        409,
        "model_needed",
    )


# ---- review_share.py ------------------------------------------------------------------------


def test_review_daw_refusals(minimal_project: Path, sample_wav: Path) -> None:
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.collaboration.share import ShareService

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    token = ShareService(ws).create_for_host(role="editor")["token"]

    client = TestClient(create_app(served_project=Path(minimal_project)))
    _check(
        client.get(f"/api/review/{token}/daw/audio", params={"rerender": "true"}),
        403,
        "rerender_not_allowed",
    )
