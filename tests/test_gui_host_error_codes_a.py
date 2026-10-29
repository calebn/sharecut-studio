"""Host-route refusals in project/auth/diagnostics/bootstrap/session carry a code (#1855)."""

from __future__ import annotations

import json
import sys

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME
from podcast_mcp.util.coded_error import AccessDeniedError, HostSetupError

CODE = "X-Sharecut-Error-Code"
LOOPBACK = ("127.0.0.1", 50000)


@pytest.fixture
def remote() -> TestClient:
    """A non-loopback peer: may not create/open/close projects."""
    return TestClient(create_app(), client=("203.0.113.9", 50000))


@pytest.fixture
def local() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK)


def _assert(res, status: int, code: str) -> None:
    assert res.status_code == status, res.text
    assert res.headers[CODE] == code


# --- project.py -----------------------------------------------------------------------------


def test_project_switch_refused_for_remote_peer(remote):
    _assert(
        remote.post("/api/project/create", json={"workspace_dir": "/x"}),
        403,
        "project_create_not_allowed",
    )
    _assert(remote.post("/api/project/pick"), 403, "project_pick_not_allowed")
    _assert(remote.post("/api/project/open", json={"path": "/x"}), 403, "project_open_not_allowed")
    _assert(remote.post("/api/project/close"), 403, "project_close_not_allowed")
    _assert(remote.get("/api/projects/recent"), 403, "project_recent_not_allowed")
    _assert(remote.delete("/api/projects/recent?path=/x"), 403, "project_recent_not_allowed")


def test_open_project_bad_paths(local, tmp_path):
    _assert(
        local.post("/api/project/open", json={"path": str(tmp_path / "nope.json")}),
        400,
        "project_path_invalid",
    )
    missing = tmp_path / "episode.sharecut"
    _assert(local.post("/api/project/open", json={"path": str(missing)}), 404, "project_not_found")
    missing.write_text("not json")
    _assert(local.post("/api/project/open", json={"path": str(missing)}), 400, "project_unreadable")


def test_open_project_refuses_the_retired_file_name(local, tmp_path):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_text("{}")
    res = local.post("/api/project/open", json={"path": str(retired)})
    _assert(res, 400, "project_old_filename")
    assert "Rename it to episode.sharecut" in res.text


def test_open_project_refuses_a_folder_holding_only_the_retired_file(local, tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_text("{}")
    res = local.post("/api/project/open", json={"path": str(tmp_path)})
    _assert(res, 400, "project_old_filename")
    assert "Rename it to episode.sharecut" in res.text


@pytest.mark.skipif(sys.platform != "linux", reason="needs a non-UTF-8 directory name")
def test_open_project_lone_surrogate_dir_matches_clean_twin(tmp_path):
    client = TestClient(create_app(), client=LOOPBACK, raise_server_exceptions=False)

    def post(directory: str):
        raw = json.dumps({"path": directory + "/episode.sharecut"}, ensure_ascii=True).encode()
        return client.post(
            "/api/project/open", content=raw, headers={"content-type": "application/json"}
        )

    twin = post(str(tmp_path / "cafe"))
    res = post(str(tmp_path / "caf\udce9"))
    assert (res.status_code, res.headers.get(CODE)) == (twin.status_code, twin.headers.get(CODE))
    assert res.status_code in (400, 404)
    assert "\\udce9" in res.text


def test_create_project_failure(local, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    _assert(
        local.post("/api/project/create", json={"workspace_dir": str(blocker / "sub")}),
        400,
        "project_create_failed",
    )


def test_pick_dialog_busy_and_no_path(local, monkeypatch):
    from podcast_mcp.gui.routes import project as mod

    class _Result:
        unavailable = False
        cancelled = False
        path = ""
        detail = ""

    monkeypatch.setattr(mod, "pick_episode_project_path", lambda: _Result())
    _assert(local.post("/api/project/pick"), 400, "project_path_required")
    assert mod._PICK_LOCK.acquire(blocking=False)
    try:
        _assert(local.post("/api/project/pick"), 409, "file_dialog_open")
    finally:
        mod._PICK_LOCK.release()


def test_health_invalid_boot_token(local, monkeypatch):
    monkeypatch.setenv("PODCAST_SIDECAR_BOOT_TOKEN", "secret")
    _assert(local.get("/api/health"), 401, "invalid_boot_token")


def test_get_project_unknown_phase(local, minimal_project):
    res = local.get("/api/project", params={"path": str(minimal_project), "phase": "bogus"})
    assert res.status_code == 400
    assert res.headers[CODE] == "projection_unknown"


def test_pending_cut_suggestion_unknown_edit(local, minimal_project):
    res = local.get("/api/pending-edits/nope/cut-suggestion", params={"path": str(minimal_project)})
    _assert(res, 404, "pending_edit_not_found")


def test_waveform_snap_invalid(local, minimal_project):
    res = local.get(
        "/api/waveform-snap",
        params={"path": str(minimal_project), "track_id": "nope", "start": 0, "end": 1},
    )
    assert res.status_code == 400
    assert res.headers[CODE] == "track_not_found"


def test_audio_unknown_source(local, minimal_project):
    res = local.get("/api/audio", params={"path": str(minimal_project), "kind": "bogus"})
    assert res.status_code == 400
    assert res.headers[CODE] == "transport_kind_unknown"


def test_audio_missing_file_and_merge_conflict(local, minimal_project, monkeypatch):
    from podcast_mcp.gui.routes import project as mod
    from podcast_mcp.project.merge import ProjectMergeConflict

    def raiser(exc):
        def boom(*_a, **_k):
            raise exc

        return boom

    params = {"path": str(minimal_project)}
    monkeypatch.setattr(mod, "resolve_viewer_transport", raiser(KeyError("src")))
    _assert(local.get("/api/audio", params=params), 404, "audio_source_unknown")
    monkeypatch.setattr(mod, "resolve_viewer_transport", raiser(FileNotFoundError("gone")))
    _assert(local.get("/api/audio", params=params), 404, "audio_file_missing")
    monkeypatch.setattr(mod, "resolve_viewer_transport", raiser(ProjectMergeConflict("clash")))
    _assert(local.get("/api/audio", params=params), 409, "merge_conflict")


def test_history_diff_out_of_range(local, minimal_project, monkeypatch):
    from podcast_mcp.gui.routes import project as mod

    def boom(*_a, **_k):
        raise ValueError("bad index")

    monkeypatch.setattr(mod.HistoryService, "diff", boom)
    res = local.get("/api/history/diff", params={"path": str(minimal_project)})
    _assert(res, 400, "invalid_request")


# --- auth.py --------------------------------------------------------------------------------


@pytest.fixture
def auth_client(tmp_path, monkeypatch) -> TestClient:
    """The (extension-provided) auth router on a bare app with a throwaway identity store."""
    from fastapi import FastAPI

    from podcast_mcp.gui.routes import auth
    from podcast_mcp.services.share_auth import ShareIdentityStore

    store = ShareIdentityStore(tmp_path / "identity.sqlite")
    monkeypatch.setattr(auth, "get_identity_store", lambda: store)
    app = FastAPI()
    app.include_router(auth.router)
    yield TestClient(app)
    store.close()


def test_auth_refusals(auth_client):
    c = auth_client
    _assert(c.get("/auth/me"), 401, "sign_in_required")
    _assert(c.get("/auth/login/nope", follow_redirects=False), 404, "auth_provider_unknown")
    _assert(c.get("/auth/callback/google", params={"error": "denied"}), 400, "oauth_provider_error")
    _assert(c.get("/auth/callback/google"), 400, "oauth_callback_incomplete")
    _assert(
        c.get("/auth/callback/nope", params={"code": "c", "state": "s"}),
        404,
        "auth_provider_unknown",
    )
    _assert(
        c.get("/auth/callback/google", params={"code": "c", "state": "s"}),
        400,
        "oauth_state_invalid",
    )
    _assert(
        c.post("/auth/password/register", json={"email": "a@b.co", "password": "short"}),
        400,
        "password_too_short",
    )
    _assert(
        c.post("/auth/password/login", json={"email": "a@b.co", "password": "wrongwrong"}),
        401,
        "invalid_credentials",
    )
    _assert(c.get("/auth/magic-link/consume", params={"token": "x"}), 400, "magic_link_invalid")
    _assert(c.post("/auth/passkey/register/begin"), 401, "sign_in_required")
    passkey = {
        "credential_id": "a",
        "public_key_b64": "a",
        "challenge": "a",
        "attestation_object": "a",
        "client_data_json": "a",
    }
    _assert(c.post("/auth/passkey/register/finish", json=passkey), 401, "sign_in_required")
    _assert(c.post("/auth/agent-credential", json={"share_token": "t"}), 401, "sign_in_required")


def test_auth_oauth_provider_failures(auth_client, monkeypatch):
    from podcast_mcp.gui.routes import auth

    for name in ("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "PODCAST_GOOGLE_OAUTH_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    res = auth_client.get("/auth/login/google", follow_redirects=False)
    assert res.status_code == 503
    assert res.headers[CODE] == "oauth_provider_unavailable"

    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "gsec")
    monkeypatch.setenv(
        "PODCAST_GOOGLE_OAUTH_REDIRECT_URI", "http://testserver/auth/callback/google"
    )
    start = auth_client.get("/auth/login/google", follow_redirects=False)
    assert start.status_code == 302
    state = start.cookies.get("podcast_oauth_state")

    def boom(*_a, **_k):
        raise RuntimeError("nope")

    monkeypatch.setattr(auth, "exchange_code", boom)
    res = auth_client.get("/auth/callback/google", params={"code": "x", "state": state})
    _assert(res, 400, "oauth_exchange_failed")

    monkeypatch.setattr(auth, "exchange_code", lambda *_a, **_k: {"sub": "1", "email": ""})
    res = auth_client.get("/auth/callback/google", params={"code": "x", "state": state})
    _assert(res, 400, "oauth_email_missing")


def test_auth_passkey_invalid(auth_client):
    res = auth_client.post(
        "/auth/passkey/login/finish",
        json={
            "credential_id": "a",
            "challenge": "a",
            "authenticator_data": "a",
            "client_data_json": "a",
            "signature": "a",
            "sign_count": 0,
        },
    )
    assert res.status_code == 400
    assert res.headers[CODE] == "passkey_authentication_challenge_invalid"


# --- bootstrap.py ---------------------------------------------------------------------------


@pytest.fixture
def bootstrap_client() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK)


def test_bootstrap_job_missing(bootstrap_client):
    _assert(
        bootstrap_client.post("/api/bootstrap/cancel", json={"job_id": "nope"}),
        404,
        "bootstrap_job_not_found",
    )
    _assert(
        bootstrap_client.get("/api/bootstrap/events", params={"job_id": "nope"}),
        404,
        "bootstrap_job_not_found",
    )


def test_bootstrap_status_bad_model(bootstrap_client):
    res = bootstrap_client.get("/api/bootstrap/status", params={"whisper_model": "no-such/model!"})
    assert res.status_code == 400
    assert res.headers[CODE] == "invalid_request"


# --- diagnostics.py -------------------------------------------------------------------------


def test_diagnostics_bundle_download_refusals(local):
    _assert(local.get("/api/diagnostics/bundle/..evil.zip"), 400, "bundle_filename_invalid")
    _assert(
        local.get("/api/diagnostics/bundle/sharecut-diagnostics-20260101T000000Z-abcdef.zip"),
        404,
        "bundle_not_found",
    )


def test_diagnostics_submit_and_status_refusals(local):
    base = {"filename": "x.zip", "description": "", "consent": False}
    _assert(local.post("/api/diagnostics/submit", json=base), 400, "report_consent_required")
    _assert(
        local.post("/api/diagnostics/submit", json={**base, "consent": True, "filename": "../x"}),
        400,
        "bundle_filename_invalid",
    )
    _assert(
        local.get("/api/diagnostics/report-status", params={"url": "https://x.example/s"}),
        404,
        "report_not_found",
    )


# --- session.py -----------------------------------------------------------------------------


def test_session_command_refused(local, minimal_project, monkeypatch):
    from podcast_mcp.gui.routes import session as mod

    def boom(*_a, **_k):
        raise ValueError("refused")

    monkeypatch.setattr(mod.SessionSyncService, "submit", boom)
    res = local.post(
        "/api/session/command",
        params={"path": str(minimal_project)},
        json={
            "type": "SetPlayhead",
            "payload": {"playhead_sec": 1.0},
            "client_id": "agent-http",
            "role": "agent",
            "client_seq": 1,
        },
    )
    _assert(res, 400, "session_command_refused")


def test_bootstrap_run_refusals(bootstrap_client):
    from podcast_mcp.services.jobs import Job

    live = Job.bootstrap("live", ["whisper"])
    live.status = "running"
    bootstrap_client.app.state.jobs._catalog._bootstrap_job = live
    _assert(
        bootstrap_client.post("/api/bootstrap/run", json={"components": ["rnnoise"]}),
        409,
        "bootstrap_job_running",
    )
    adopted = bootstrap_client.post("/api/bootstrap/run", json={})
    assert adopted.status_code == 200
    assert adopted.json()["adopted"] is True
    assert adopted.json()["job"]["id"] == "live"


def test_diagnostics_bundle_build_failures(local, monkeypatch):
    from podcast_mcp.gui.routes import diagnostics as mod

    def fail(exc):
        def boom(*_a, **_k):
            raise exc

        return boom

    monkeypatch.setattr(mod.DiagnosticsService, "build_bundle", fail(OSError("disk")))
    _assert(local.post("/api/diagnostics/bundle", json={}), 400, "bundle_write_failed")
    monkeypatch.setattr(mod.DiagnosticsService, "build_bundle", fail(RuntimeError("broken")))
    _assert(local.post("/api/diagnostics/bundle", json={}), 500, "bundle_build_failed")


def test_diagnostics_submit_relay_failures(local, tmp_path, monkeypatch):
    import httpx

    from podcast_mcp.gui.routes import diagnostics as mod

    name = "sharecut-diagnostics-20260101T000000Z-abcdef.zip"
    bundle = tmp_path / name
    bundle.write_bytes(b"zip")
    monkeypatch.setattr(mod, "resolve_bundle_file", lambda *_a, **_k: bundle)
    local.app.state.diagnostics_bundles = {name: str(tmp_path)}
    monkeypatch.setattr(mod, "_bundle_registry", lambda _r: {name: str(tmp_path)})
    body = {"filename": name, "description": "", "consent": True}

    def fail(exc):
        def boom(*_a, **_k):
            raise exc

        return boom

    monkeypatch.setattr(mod, "submit_bundle", fail(ValueError("bad")))
    res = local.post("/api/diagnostics/submit", json=body)
    _assert(res, 400, "report_submit_invalid")
    monkeypatch.setattr(mod, "submit_bundle", fail(httpx.ConnectError("down")))
    _assert(local.post("/api/diagnostics/submit", json=body), 502, "report_relay_unavailable")

    local.app.state.diagnostics_report_statuses = {"https://x.example/s"}
    monkeypatch.setattr(mod, "get_report_status", fail(ValueError("bad")))
    res = local.get("/api/diagnostics/report-status", params={"url": "https://x.example/s"})
    _assert(res, 502, "report_status_unavailable")


@pytest.mark.skipif(sys.platform != "linux", reason="needs a lone surrogate path")
@pytest.mark.parametrize(
    ("exc", "status"),
    [
        (HostSetupError("folder caf\udce9 is not private", code="registry_not_private"), 500),
        (AccessDeniedError("no caf\udce9", code="forbidden_thing"), 403),
    ],
)
def test_app_wide_refusal_with_a_lone_surrogate_keeps_its_status(exc, status):
    app = create_app()

    @app.get("/api/_boom")
    def boom() -> None:
        raise exc

    res = TestClient(app, client=LOOPBACK, raise_server_exceptions=False).get("/api/_boom")
    assert res.status_code == status
    assert "\\udce9" in res.text
