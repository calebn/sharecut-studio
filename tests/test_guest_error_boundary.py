"""Guest transports disclose refusals, never exception text from crashes."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.routes import review_share


@pytest.mark.parametrize(
    "error",
    [
        ValueError("broken host state /private/host/project.json"),
        PermissionError(13, "permission denied", "/private/host/project.json"),
    ],
)
def test_guest_http_crash_hides_exception_text(monkeypatch, error):
    def crash(*_args, **_kwargs):
        raise error

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(review_share, "_check_token", lambda _token: {})
    monkeypatch.setattr(review_share, "_rate_limit", lambda *_args: None)
    monkeypatch.setattr(review_share, "share_daw_project_view", crash)
    app = FastAPI()
    app.include_router(review_share.router)
    response = TestClient(app).get("/api/review/token/daw/project")
    assert response.status_code == 500
    assert response.json() == {"detail": "internal error"}


def test_guest_websocket_os_error_hides_exception_text(monkeypatch):
    async def admit(_websocket, _token):
        return False

    def crash(*_args, **_kwargs):
        raise PermissionError(13, "permission denied", "/private/host/project.json")

    monkeypatch.setattr(review_share, "_admit_review_ws", admit)
    monkeypatch.setattr(review_share, "require_share_cap", crash)
    app = FastAPI()
    app.include_router(review_share.router)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/review/token/daw/ws") as socket:
                socket.receive_json()
    assert failure.value.code == 1011
    assert failure.value.reason == "internal error"


@pytest.fixture
def guest_client(monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(review_share, "_check_token", lambda _token: {})
    monkeypatch.setattr(review_share, "_rate_limit", lambda *_args: None)
    app = FastAPI()
    app.include_router(review_share.router)
    return TestClient(app)


@pytest.mark.parametrize("error_type", [ValueError, PermissionError, RuntimeError, KeyError])
@pytest.mark.parametrize(
    ("service", "method", "url", "body"),
    [
        ("share_project_view", "get", "/project", None),
        ("share_daw_project_view", "get", "/daw/project", None),
        ("share_daw_meta", "get", "/daw/meta", None),
        ("share_audio_path", "get", "/audio", None),
        ("share_daw_audio_path", "get", "/daw/audio", None),
        ("share_daw_waveform_status", "get", "/daw/waveform/status", None),
        (
            "share_daw_waveform_tiles",
            "get",
            "/daw/waveform/tiles/key?ref=track:x&level=0&start=0",
            None,
        ),
        ("share_daw_waveform_snap", "get", "/daw/waveform-snap?track_id=x&start=0&end=1", None),
        ("share_pending_cut_suggestion", "get", "/daw/pending-edits/x/cut-suggestion", None),
        ("share_proxy_manifest", "get", "/daw/proxy/manifest", None),
        ("share_proxy_chunk_path", "get", "/daw/proxy/x/hash/0", None),
        ("share_upload_media", "post", "/daw/media/upload?filename=x.wav", None),
        ("require_share_edit", "post", "/daw/render-preview", None),
        ("require_share_edit", "get", "/daw/render-preview/job", None),
        ("require_share_cap", "get", "/daw/document/state", None),
        (
            "require_share_cap",
            "post",
            "/daw/document/command",
            {
                "type": "SetTrackMute",
                "payload": {"track_id": "x", "muted": True},
                "client_id": "guest",
                "client_seq": 1,
            },
        ),
        (
            "share_add_comment",
            "post",
            "/comments",
            {"body": "x", "author": "A", "timeline_start": 0},
        ),
        ("share_add_reply", "post", "/comments/x/replies", {"body": "x", "author": "A"}),
    ],
)
def test_review_operations_hide_crashes_and_log_diagnostics(
    guest_client, monkeypatch, caplog, service, method, url, body, error_type
):
    diagnostic = "private secret phrase /private/host/project.json"

    def crash(*_args, **_kwargs):
        raise error_type(diagnostic)

    monkeypatch.setattr(review_share, service, crash)
    monkeypatch.setattr(review_share, "resolve_share_audio_redirect", lambda *_args: None)
    monkeypatch.setattr(review_share, "_audio_slot", lambda *_args: None)
    response = guest_client.request(method, "/api/review/token" + url, json=body)
    assert response.status_code == 500, response.text
    assert response.json() == {"detail": "internal error"}
    assert diagnostic not in response.text
    assert diagnostic not in str(response.headers)
    failures = [record for record in caplog.records if record.exc_info]
    assert failures and diagnostic in str(failures[-1].exc_info[1])
    if "/waveform/" in url:
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("wrapped", [False, True])
@pytest.mark.parametrize(
    "kind", ["permission", "input", "missing", "conflict", "busy", "sqlite", "nonbusy"]
)
def test_guest_refusal_contract(guest_client, monkeypatch, caplog, wrapped, kind):
    import sqlite3

    from filelock import Timeout

    from podcast_mcp.services.document_sync import DocumentConflictError
    from podcast_mcp.util.coded_error import CodedKeyError, CodedPermissionError, CodedValueError

    cases = {
        "permission": (
            CodedPermissionError(
                "denied /private/host/project.json", code="share_capability_required"
            ),
            403,
            "share_capability_required",
            "denied [path]",
        ),
        "input": (
            CodedValueError("bad input /private/host/project.json", code="invalid_input"),
            400,
            "invalid_input",
            "bad input [path]",
        ),
        "missing": (
            CodedKeyError("missing /private/host/project.json", code="target_not_found"),
            404,
            "target_not_found",
            "missing [path]",
        ),
        "conflict": (
            DocumentConflictError("changed /private/host/project.json", code="history_stale"),
            409,
            "history_stale",
            {"detail": "changed [path]", "conflict": True},
        ),
        "busy": (
            Timeout("/private/host/project.json.lock"),
            503,
            "project_busy",
            "This project is busy; try again",
        ),
        "sqlite": (
            sqlite3.OperationalError("database is locked"),
            503,
            "project_busy",
            "Project is busy in another process; try again",
        ),
        "nonbusy": (
            sqlite3.OperationalError("private secret phrase /private/host/project.json"),
            500,
            None,
            "internal error",
        ),
    }
    error, status, code, detail = cases[kind]
    if wrapped:
        outer = RuntimeError("private secret phrase /private/host/wrapper")
        outer.__cause__ = error
        error = outer

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(review_share, "share_daw_project_view", fail)
    response = guest_client.get("/api/review/token/daw/project")
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert response.headers.get("x-sharecut-error-code") == code
    assert "private secret phrase" not in response.text
    assert "/private/host" not in response.text
    assert bool([r for r in caplog.records if r.exc_info]) == (status == 500)


@pytest.mark.parametrize("kind", ["sqlite", "timeout"])
def test_busy_cause_beats_coded_wrapper(guest_client, monkeypatch, kind):
    import sqlite3

    from filelock import Timeout

    from podcast_mcp.services.document_sync import DocumentConflictError

    error = DocumentConflictError("outer conflict")
    error.__cause__ = (
        sqlite3.OperationalError("database is busy")
        if kind == "sqlite"
        else Timeout("private.lock")
    )

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(review_share, "share_daw_project_view", fail)
    response = guest_client.get("/api/review/token/daw/project")
    assert response.status_code == 503
    assert response.headers["x-sharecut-error-code"] == "project_busy"
    assert "outer conflict" not in response.text


@pytest.mark.parametrize("stage", ["bootstrap", "context", "ingest", "status", "delete"])
def test_record_http_crashes_are_private(monkeypatch, caplog, stage):
    from types import SimpleNamespace

    from podcast_mcp.gui.routes import record_share

    diagnostic = "private secret phrase /private/host/upload.sqlite"

    def fail(*_args, **_kwargs):
        raise ValueError(diagnostic)

    monkeypatch.setattr(record_share, "check_share_token", lambda *_a, **_kw: {})
    monkeypatch.setattr(record_share, "rate_limit_share", lambda *_a: None)
    session = SimpleNamespace(
        verify_lease=lambda *_a, **_kw: True, upload_consented=lambda *_a, **_kw: True
    )
    uploader = SimpleNamespace(status=fail, revoke_room_tone=fail)
    monkeypatch.setattr(
        record_share,
        "_guest_upload_ctx",
        fail if stage == "context" else lambda *_a: (uploader, session, "room", None),
    )
    monkeypatch.setattr(record_share, "record_bootstrap", fail)

    async def ingest(*_args, **_kwargs):
        fail()

    monkeypatch.setattr(record_share, "ingest_record_upload_request", ingest)
    app = FastAPI()
    app.include_router(record_share.router)
    client = TestClient(app)
    headers = {"X-Record-Participant": "p_123456789abc", "X-Record-Lease": "lease"}
    if stage == "bootstrap":
        response = client.get("/api/rec/token/bootstrap")
    elif stage in {"context", "ingest"}:
        response = client.post(
            "/api/rec/token/upload?take_index=0&segment_index=0&part_seq=0",
            headers=headers,
            content=b"audio",
        )
    elif stage == "delete":
        response = client.delete("/api/rec/token/upload?kind=room_tone", headers=headers)
    else:
        response = client.get("/api/rec/token/upload", headers=headers)
    assert response.status_code == 500, response.text
    assert response.json() == {"detail": "internal error"}
    assert diagnostic in str([r.exc_info[1] for r in caplog.records if r.exc_info])


@pytest.mark.parametrize("kind", ["key", "crash"])
def test_remote_mcp_preflight_never_discloses_exception(monkeypatch, caplog, kind):
    from podcast_mcp.gui.routes import remote_mcp

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    diagnostic = "private secret phrase /private/host/registry.sqlite"

    def fail(*_args, **_kwargs):
        raise KeyError(diagnostic) if kind == "key" else RuntimeError(diagnostic)

    monkeypatch.setattr(remote_mcp, "share_allows_mcp", fail)
    app = FastAPI()
    app.include_router(remote_mcp.router)
    response = TestClient(app).post(
        "/mcp/token/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}
    )
    assert response.status_code == (404 if kind == "key" else 500)
    assert response.json() == {"detail": "share not found" if kind == "key" else "internal error"}
    assert diagnostic not in response.text
    assert bool([r for r in caplog.records if r.exc_info]) == (kind == "crash")


@pytest.mark.parametrize("kind", ["permission", "busy", "stale", "input"])
def test_guest_waveform_refusal_preserves_cache_retry_and_releases_slot(
    guest_client, monkeypatch, caplog, kind
):
    from podcast_mcp.services.media import StaleWaveformKeyError, WaveformBusyError
    from podcast_mcp.util.coded_error import CodedPermissionError, CodedValueError
    from podcast_mcp.util.rate_limit import RateLimitDecision

    cases = {
        "permission": (
            CodedPermissionError(
                "denied /private/host/media.wav", code="share_capability_required"
            ),
            403,
            "denied [path]",
            "share_capability_required",
        ),
        "busy": (
            WaveformBusyError(
                RateLimitDecision(allowed=False, bucket="pcm_decode", retry_after_sec=1.0)
            ),
            503,
            "waveform decoder busy",
            "waveform_busy",
        ),
        "stale": (
            StaleWaveformKeyError("waveform key is stale"),
            409,
            "waveform key is stale",
            "waveform_stale",
        ),
        "input": (
            CodedValueError("level out of range", code="invalid_waveform_request"),
            400,
            "level out of range",
            "invalid_waveform_request",
        ),
    }
    error, status, detail, code = cases[kind]
    released = []
    monkeypatch.setattr(review_share, "_audio_slot", lambda *_a: lambda: released.append(True))

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(review_share, "share_daw_waveform_tiles", fail)
    response = guest_client.get(
        "/api/review/token/daw/waveform/tiles/key?ref=track:x&level=0&start=0"
    )
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-sharecut-error-code"] == code
    if kind == "busy":
        assert response.headers["retry-after"] == "1"
    assert released == [True]
    assert not [r for r in caplog.records if r.exc_info]


@pytest.mark.parametrize("wrapped", [False, True])
def test_guest_ws_coded_permission_reason_is_redacted_and_byte_bounded(monkeypatch, wrapped):
    from podcast_mcp.util.coded_error import CodedPermissionError

    async def admit(_websocket, _token):
        return False

    error = CodedPermissionError(
        "denied /private/host/project.json " + "é" * 100, code="share_capability_required"
    )
    if wrapped:
        outer = RuntimeError("private secret phrase")
        outer.__cause__ = error
        error = outer

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(review_share, "_admit_review_ws", admit)
    monkeypatch.setattr(review_share, "require_share_cap", fail)
    app = FastAPI()
    app.include_router(review_share.router)
    with pytest.raises(WebSocketDisconnect) as failure:
        with TestClient(app).websocket_connect("/api/review/token/daw/ws") as socket:
            socket.receive_json()
    assert failure.value.code == 4403
    assert failure.value.reason.startswith("denied [path] ")
    assert len(failure.value.reason.encode("utf-8")) <= 120
    assert "/private/host" not in failure.value.reason
    assert "private secret phrase" not in failure.value.reason


@pytest.mark.parametrize("cached", ["pending", "image", "context", "context-image"])
def test_guest_preview_rate_refusal_keeps_shell_response(guest_client, monkeypatch, cached):
    from fastapi import HTTPException

    def refuse(*_args):
        raise HTTPException(status_code=429, detail="rate limited", headers={"Retry-After": "2"})

    monkeypatch.setattr(review_share, "_rate_limit", refuse)
    monkeypatch.setattr(review_share, "share_pending_preview_wav_cached", lambda *_a, **_kw: None)
    monkeypatch.setattr(review_share, "share_pending_preview_image_cached", lambda *_a, **_kw: None)
    monkeypatch.setattr(review_share, "share_audition_context_cached", lambda *_a, **_kw: False)
    monkeypatch.setattr(
        review_share, "share_audition_context_image_cached", lambda *_a, **_kw: None
    )
    urls = {
        "pending": "/daw/pending-preview?edit_id=x",
        "image": "/daw/pending-preview-image?edit_id=x",
        "context": "/daw/audition-context?start=0&end=1",
        "context-image": "/daw/audition-context-image?start=0&end=1&track_id=x",
    }
    response = guest_client.get("/api/review/token" + urls[cached])
    assert response.status_code == 429
    assert response.json() == {"detail": "rate limited"}
    assert response.headers["retry-after"] == "2"


def test_guest_audio_pin_crash_is_private(guest_client, monkeypatch, caplog):
    from pathlib import Path

    diagnostic = "private secret phrase /private/host/media.wav"

    def fail(*_args, **_kwargs):
        raise PermissionError(diagnostic)

    monkeypatch.setattr(review_share, "share_daw_audio_path", lambda *_a, **_kw: Path("media.wav"))
    monkeypatch.setattr(review_share, "_audio_slot", lambda *_a: None)
    monkeypatch.setattr(review_share, "pinned_audio_response", fail)
    response = guest_client.get("/api/review/token/daw/audio")
    assert response.status_code == 500
    assert response.json() == {"detail": "internal error"}
    assert diagnostic in str([r.exc_info[1] for r in caplog.records if r.exc_info])


@pytest.mark.parametrize("route", ["/api/review/token/daw/project", "/api/rec/token/bootstrap"])
@pytest.mark.parametrize("kind", ["sqlite", "timeout", "crash"])
def test_http_token_lookup_uses_guest_boundary(monkeypatch, caplog, route, kind):
    import sqlite3

    from filelock import Timeout

    from podcast_mcp.gui.routes import record_share, share_common

    diagnostic = "private secret phrase /private/host/registry.sqlite"
    error = {
        "sqlite": sqlite3.OperationalError("database is locked"),
        "timeout": Timeout("/private/host/registry.lock"),
        "crash": RuntimeError(diagnostic),
    }[kind]

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(share_common, "lookup_share", fail)
    app = FastAPI()
    app.include_router(review_share.router)
    app.include_router(record_share.router)
    response = TestClient(app, raise_server_exceptions=False).get(route)
    assert response.status_code == (500 if kind == "crash" else 503)
    expected = {
        "sqlite": "Project is busy in another process; try again",
        "timeout": "This project is busy; try again",
        "crash": "internal error",
    }[kind]
    assert response.json() == {"detail": expected}
    assert response.headers.get("x-sharecut-error-code") == (
        None if kind == "crash" else "project_busy"
    )
    assert bool([r for r in caplog.records if r.exc_info]) == (kind == "crash")
    if kind == "crash":
        assert diagnostic in str([r.exc_info[1] for r in caplog.records if r.exc_info])
