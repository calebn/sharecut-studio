"""HTTP projection of busy locks and auth guards, pinned per route class (#1810)."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from filelock import Timeout

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.media.transcript_precorrect import TranscriptContextBusyError
from podcast_mcp.util.project_state import (
    LOCK_BUSY_MESSAGE,
    PROJECT_BUSY_MESSAGE,
    TRANSCRIPT_CONTEXT_BUSY_MESSAGE,
    ProjectBusyError,
)

CODE = "X-Sharecut-Error-Code"
LOCK_PATH = "/secret/ws/artifacts/episode.sharecut.lock"


def _raise(exc: BaseException):
    def boom(*_args: object, **_kwargs: object) -> None:
        raise exc

    return boom


def _assert_busy(res, message: str) -> None:
    assert res.status_code == 503
    assert res.headers[CODE] == "project_busy"
    assert res.json() == {"detail": message}
    assert "/secret" not in res.text


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_busy_audio_route(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.resolve_viewer_transport", _raise(Timeout(LOCK_PATH))
    )
    res = client.get("/api/audio", params={"path": str(minimal_project), "rerender": "true"})
    _assert_busy(res, LOCK_BUSY_MESSAGE)


def test_busy_waveform_route_is_never_cached_and_not_logged(
    minimal_project, monkeypatch, client, caplog
):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.waveform.waveform_status", _raise(Timeout(LOCK_PATH))
    )
    with caplog.at_level(logging.ERROR):
        res = client.get("/api/waveform/status", params={"path": str(minimal_project)})
    _assert_busy(res, LOCK_BUSY_MESSAGE)
    assert res.headers["Cache-Control"] == "no-store"
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


def test_busy_media_upload_route(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.media.write_upload_chunk", _raise(Timeout(LOCK_PATH))
    )
    res = client.post(
        f"/api/media/upload?path={minimal_project}&filename=a.wav",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    _assert_busy(res, LOCK_BUSY_MESSAGE)


def test_busy_transcript_context_route(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptPrecorrectService.set_vocabulary",
        _raise(TranscriptContextBusyError(TRANSCRIPT_CONTEXT_BUSY_MESSAGE)),
    )
    res = client.put(
        "/api/transcript/vocabulary",
        json={
            "path": str(minimal_project),
            "terms": ["Kaczynski"],
            "guest_names": [],
            "base_revision": None,
        },
    )
    _assert_busy(res, TRANSCRIPT_CONTEXT_BUSY_MESSAGE)


_COMMAND = {
    "type": "CorrectTranscriptWord",
    "payload": {"track_id": "host", "word_index": 0, "text": "corrected"},
    "client_id": "viewer",
    "client_seq": 1,
    "role": "viewer",
}


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (Timeout(LOCK_PATH), LOCK_BUSY_MESSAGE),
        (ProjectBusyError(LOCK_PATH), PROJECT_BUSY_MESSAGE),
        (sqlite3.OperationalError("database is locked"), PROJECT_BUSY_MESSAGE),
    ],
    ids=["raw-timeout", "project-busy", "sqlite-busy"],
)
def test_busy_document_command_route(minimal_project, monkeypatch, client, exc, message):
    monkeypatch.setattr("podcast_mcp.gui.routes.document.DocumentSyncService.submit", _raise(exc))
    res = client.post(f"/api/document/command?path={minimal_project}", json=_COMMAND)
    _assert_busy(res, message)


def test_document_command_sqlite_error_that_is_not_busy_stays_a_crash(minimal_project, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.document.DocumentSyncService.submit",
        _raise(sqlite3.OperationalError("no such table: x")),
    )
    crashing = TestClient(create_app(), raise_server_exceptions=False)
    res = crashing.post(f"/api/document/command?path={minimal_project}", json=_COMMAND)
    assert res.status_code == 500
    assert CODE not in res.headers


def test_busy_pending_preview_warm_route(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.services.document.PlayService.warm_pending_preview",
        _raise(Timeout(LOCK_PATH)),
    )
    res = client.post("/api/pending-preview/warm", params={"path": str(minimal_project)})
    _assert_busy(res, LOCK_BUSY_MESSAGE)


def test_busy_pending_preview_audio_route(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.services.document.PlayService.pending_preview_cached_wav",
        _raise(Timeout(LOCK_PATH)),
    )
    res = client.get("/api/pending-preview", params={"path": str(minimal_project), "edit_id": "e1"})
    _assert_busy(res, LOCK_BUSY_MESSAGE)


def test_busy_on_a_route_without_a_local_mapping(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.comments.CommentService.add", _raise(Timeout(LOCK_PATH))
    )
    res = client.post(
        "/api/comments",
        json={
            "path": str(minimal_project),
            "body": "note",
            "author": "host",
            "timeline_start": 1.0,
        },
    )
    _assert_busy(res, LOCK_BUSY_MESSAGE)


# --- auth guards -----------------------------------------------------------------------


@pytest.fixture
def strict_remote(monkeypatch):
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "session-token")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    return TestClient(create_app(bind_host="0.0.0.0"))


def test_require_host_denial_is_403_with_a_string_detail(minimal_project, strict_remote):
    res = strict_remote.get("/api/project/meta", params={"path": str(minimal_project)})
    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    assert res.headers[CODE] == "authz_denied"


def test_require_authz_denial_is_403_with_a_string_detail(minimal_project, strict_remote):
    res = strict_remote.get("/api/document/state", params={"path": str(minimal_project)})
    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    assert res.headers[CODE] == "authz_denied"


def test_session_route_denial_is_403_with_a_string_detail(minimal_project, strict_remote):
    res = strict_remote.get("/api/session/state", params={"path": str(minimal_project)})
    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    assert res.headers[CODE] == "authz_denied"


def test_relayed_host_request_is_403(minimal_project, client):
    res = client.get(
        "/api/project/meta",
        params={"path": str(minimal_project)},
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert res.status_code == 403
    assert res.headers[CODE] == "authz_denied"


def test_waveform_route_keeps_no_store_on_a_denied_host(minimal_project, strict_remote):
    res = strict_remote.get("/api/waveform/status", params={"path": str(minimal_project)})
    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    assert res.headers["Cache-Control"] == "no-store"
    assert res.headers[CODE] == "authz_denied"


def test_unknown_share_token_is_404(client):
    res = client.get("/api/review/definitely-missing/project")
    assert res.status_code == 404
    assert res.json() == {"detail": "invalid or revoked share token"}
    assert res.headers[CODE] == "share_not_found"


def test_waveform_route_keeps_no_store_on_an_unknown_share(client):
    res = client.get("/api/review/definitely-missing/daw/waveform/status")
    assert res.status_code == 404
    assert res.json() == {"detail": "invalid or revoked share token"}
    assert res.headers["Cache-Control"] == "no-store"
    assert res.headers[CODE] == "share_not_found"


def _published_share(minimal_project, sample_wav, **share_kwargs):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="guard")
    return ShareService(ws).create(review_version_id=ver["id"], **share_kwargs)["token"]


def test_share_without_mcp_capability_is_403(minimal_project, sample_wav, tmp_workspace, client):
    token = _published_share(minimal_project, sample_wav, capabilities=["play", "view"])
    res = client.get(f"/mcp/{token}")
    assert res.status_code == 403
    assert res.json() == {"detail": "share does not allow mcp"}
    assert res.headers[CODE] == "share_capability_required"


def test_unknown_share_on_the_mcp_route_is_404(client):
    res = client.get("/mcp/definitely-missing")
    assert res.status_code == 404
    assert res.json() == {"detail": "share not found"}
    assert res.headers[CODE] == "share_not_found"


def test_restricted_share_sign_in_and_acl_denials(
    minimal_project, sample_wav, tmp_workspace, tmp_path, monkeypatch
):
    from podcast_mcp.services.share_auth.store import (
        get_identity_store,
        reset_identity_store_for_tests,
    )

    monkeypatch.setenv("PODCAST_SHARE_IDENTITY", str(tmp_path / "identity.sqlite"))
    monkeypatch.setenv("PODCAST_SHARE_ACCOUNTS", "1")
    reset_identity_store_for_tests()
    try:
        token = _published_share(
            minimal_project,
            sample_wav,
            public_base_url="http://example.test",
            capabilities=["play", "comment"],
            general_access="restricted",
        )
        store = get_identity_store()
        store.invite_to_share(token, email="guest@example.com", role="commenter")
        anonymous = TestClient(create_app()).get(f"/api/review/{token}/project")
        assert anonymous.status_code == 401
        assert anonymous.json() == {
            "detail": {
                "error": "authentication_required",
                "message": "This share requires sign-in",
                "login_path": "/auth/login",
            }
        }
        assert anonymous.headers[CODE] == "authentication_required"

        user = store.create_or_get_email_user("other@example.com", email_verified=True)
        session = store.create_session(user["id"])
        other = TestClient(create_app())
        other.cookies.set("podcast_share_session", session)
        denied = other.get(f"/api/review/{token}/project")
        assert denied.status_code == 403
        assert denied.json() == {"detail": "authenticated user is not on this share ACL"}
        assert denied.headers[CODE] == "share_acl_denied"
    finally:
        reset_identity_store_for_tests()


# --- contract: every guest 4xx names its refusal ----------------------------------------


def _api_routes(routes):
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            yield from _api_routes(inner.routes)
        elif isinstance(route, APIRoute):
            yield route


def _guest_routes(app) -> list[tuple[str, str]]:
    return sorted(
        (method, route.path)
        for route in _api_routes(app.routes)
        if "{token}" in route.path
        for method in route.methods - {"OPTIONS", "HEAD"}
    )


def _guest_requests(app, token: str):
    for method, template in _guest_routes(app):
        path = template.replace(":path", "").format_map(_Fill(token))
        yield method, path


class _Fill(dict):
    def __init__(self, token: str) -> None:
        super().__init__(token=token)

    def __missing__(self, key: str) -> str:
        return "x"


def _assert_every_4xx_is_coded(client, requests) -> int:
    seen = 0
    for method, path in requests:
        for body in (None, {}):
            res = client.request(method, path, json=body)
            if 400 <= res.status_code < 500:
                seen += 1
                assert res.headers.get(CODE), (method, path, body, res.status_code, res.text)
    return seen


def test_guest_routes_are_enumerated_from_the_app():
    routes = _guest_routes(create_app())
    assert ("GET", "/api/review/{token}/project") in routes
    assert ("POST", "/api/rec/{token}/upload") in routes
    assert ("POST", "/mcp/{token}/mcp") in routes
    assert len(routes) > 30


def test_every_guest_4xx_for_an_unknown_token_carries_an_error_code(monkeypatch):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    app = create_app()
    seen = _assert_every_4xx_is_coded(TestClient(app), _guest_requests(app, "definitely-missing"))
    assert seen >= len(_guest_routes(app))


def test_every_guest_4xx_for_a_view_only_token_carries_an_error_code(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    app = create_app()
    token = _published_share(minimal_project, sample_wav, capabilities=["play", "view"])
    seen = _assert_every_4xx_is_coded(TestClient(app), _guest_requests(app, token))
    assert seen > 0


def test_every_guest_4xx_for_a_record_room_token_carries_an_error_code(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    app = create_app()
    ws = ProjectWorkspace.open(minimal_project)
    token = ShareService(ws).create_record_room()["guest"]["token"]
    seen = _assert_every_4xx_is_coded(TestClient(app), _guest_requests(app, token))
    assert seen > 0


def test_guest_rate_limit_carries_an_error_code(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.util.rate_limit import RateLimitDecision

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    token = _published_share(minimal_project, sample_wav, capabilities=["play", "view", "mcp"])
    denied = RateLimitDecision(allowed=False, bucket="host_read", retry_after_sec=1.5)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.share_common.check_host_bucket", lambda *_a, **_k: denied
    )
    client = TestClient(create_app())
    res = client.get(f"/api/review/{token}/project")
    assert res.status_code == 429
    assert res.headers[CODE] == "rate_limited"
    assert res.headers["Retry-After"] == "2"


def test_request_validation_failure_carries_an_error_code(client):
    res = client.get("/api/waveform/status")
    assert res.status_code == 422
    assert res.headers[CODE] == "invalid_request"


def test_oversized_guest_upload_carries_an_error_code(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "16")
    token = _published_share(
        minimal_project, sample_wav, capabilities=capabilities_for_role("editor", with_mcp=True)
    )
    res = TestClient(create_app()).post(
        f"/api/review/{token}/daw/media/upload?filename=a.wav&total_chunks=2",
        content=b"x" * 32,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 413
    assert res.headers[CODE] == "payload_too_large"
