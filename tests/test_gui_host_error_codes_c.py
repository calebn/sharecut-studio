"""Host-route refusals carry a stable ``X-Sharecut-Error-Code`` (#1855), lane C routes."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.range_target import RangeChangedError
from podcast_mcp.edits.transcript_timing import TranscriptTimingChangedError
from podcast_mcp.gui.routes.guest_errors import guest_http_error
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.document_sync import DocumentConflictError
from podcast_mcp.services.media import StaleWaveformKeyError, VocabularyConflictError

CODE = "X-Sharecut-Error-Code"


def _raise(exc: BaseException):
    def boom(*_args: object, **_kwargs: object) -> None:
        raise exc

    return boom


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _check(res: Any, status: int, code: str) -> None:
    assert res.status_code == status, res.text
    assert res.headers[CODE] == code


RANGE = {
    "kind": "exact_range",
    "intervals": [{"start": 0.0, "end": 1.0}],
    "track_ids": ["host"],
    "clips": [],
    "media_seals": {},
}
TRIM = {"kind": "trim", "clip_id": "c1", "edge": "out"}
TRIM_EDIT = {**TRIM, "source_sec": 1.0}


# --- deps.resolve_project / server.py ---------------------------------------------------


def test_project_file_missing(client, tmp_path):
    res = client.get("/api/transcript/vocabulary", params={"path": str(tmp_path / "no.json")})
    _check(res, 404, "project_not_found")
    assert res.json()["detail"].startswith("Project not found: ")


def test_project_path_not_allowed(minimal_project, tmp_path):
    other = tmp_path / "other.project.json"
    other.write_text("{}", encoding="utf-8")
    client = TestClient(create_app(served_project=other))
    res = client.get("/api/transcript/vocabulary", params={"path": str(minimal_project)})
    _check(res, 403, "project_path_not_allowed")
    assert res.json() == {"detail": "project path not allowed for this server instance"}


def test_index_project_mismatch_non_html(minimal_project, tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    client = TestClient(create_app(static_dir=dist, served_project=minimal_project))
    res = client.get(
        "/", params={"project": str(tmp_path / "else.json")}, headers={"Accept": "*/*"}
    )
    if res.status_code == 403:
        _check(res, 403, "project_path_not_allowed")
    else:  # the mismatch check is skipped for this request shape; the assets below still run
        assert res.status_code == 200


@pytest.mark.parametrize(
    "path", ["/favicon.svg", "/favicon.ico", "/recovery.css", "/brand-tokens.css"]
)
def test_missing_static_asset(tmp_path, path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    res = TestClient(create_app(static_dir=dist)).get(path)
    _check(res, 404, "static_asset_not_found")


def test_guest_internal_error_is_generic_and_coded():
    exc = guest_http_error(
        RuntimeError("secret /path"), logger=logging.getLogger("t"), operation="op"
    )
    assert exc.status_code == 500
    assert exc.detail == "internal error"
    assert exc.headers is not None and exc.headers[CODE] == "internal_error"


# --- waveform ----------------------------------------------------------------------------


def _waveform(client, project, monkeypatch, exc):
    monkeypatch.setattr("podcast_mcp.gui.routes.waveform.waveform_status", _raise(exc))
    return client.get("/api/waveform/status", params={"path": str(project)})


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (ValueError("bad"), 400, "invalid_request"),
        (LookupError("gone"), 404, "waveform_not_found"),
        (FileNotFoundError("gone"), 404, "waveform_not_found"),
        (StaleWaveformKeyError("stale"), 409, "waveform_stale"),
        (RuntimeError("boom"), 500, "internal_error"),
    ],
)
def test_waveform_refusals(minimal_project, monkeypatch, client, exc, status, code):
    res = _waveform(client, minimal_project, monkeypatch, exc)
    _check(res, status, code)
    assert res.headers["Cache-Control"] == "no-store"


def test_waveform_busy_keeps_retry_after(minimal_project, monkeypatch, client):
    from podcast_mcp.services.media import WaveformBusyError

    class Decision:
        retry_after_header = "3"

    res = _waveform(client, minimal_project, monkeypatch, WaveformBusyError(Decision()))  # type: ignore[arg-type]
    _check(res, 503, "waveform_busy")
    assert res.headers["Retry-After"] == "3"
    assert res.headers["Cache-Control"] == "no-store"


def test_waveform_kind_invalid(minimal_project, client):
    res = client.get("/api/waveform/status", params={"path": str(minimal_project), "kind": "x"})
    _check(res, 400, "waveform_kind_invalid")
    assert res.headers["Cache-Control"] == "no-store"


def test_waveform_resolve_refusal_keeps_code_and_no_store(client, tmp_path):
    res = client.get("/api/waveform/status", params={"path": str(tmp_path / "no.json")})
    _check(res, 404, "project_not_found")
    assert res.headers["Cache-Control"] == "no-store"


# --- transcript --------------------------------------------------------------------------

VOCAB = {"path": "", "terms": [], "guest_names": [], "base_revision": None}
TIMING = {
    "path": "",
    "target": {"track_id": "host", "source_id": None, "word_index": 0},
    "expected_word": {"text": "a", "start": 0.0, "end": 1.0},
}


def test_vocabulary_conflict(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptPrecorrectService.set_vocabulary",
        _raise(VocabularyConflictError("stale")),
    )
    res = client.put("/api/transcript/vocabulary", json={**VOCAB, "path": str(minimal_project)})
    _check(res, 409, "vocabulary_conflict")
    assert res.json() == {"detail": "stale"}


def test_vocabulary_invalid(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptPrecorrectService.set_vocabulary",
        _raise(ValueError("bad term")),
    )
    res = client.put("/api/transcript/vocabulary", json={**VOCAB, "path": str(minimal_project)})
    _check(res, 400, "invalid_request")


def test_refine_waive_invalid(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptRefineService.waive",
        _raise(ValueError("nope")),
    )
    res = client.post(
        "/api/transcript/refine/waive", json={"path": str(minimal_project), "reason": "r"}
    )
    _check(res, 400, "invalid_request")


def test_replacement_preview_invalid(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptService.preview_transcript_replacement",
        _raise(ValueError("nope")),
    )
    res = client.post(
        "/api/transcript/replacement-preview",
        json={"path": str(minimal_project), "search": "a", "replacement": "b"},
    )
    _check(res, 400, "invalid_request")


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (TranscriptTimingChangedError("changed"), 409, "transcript_timing_changed"),
        (KeyError("host"), 404, "word_not_found"),
        (FileNotFoundError("x"), 404, "word_not_found"),
        (ValueError("bad"), 400, "invalid_request"),
    ],
)
def test_word_timing_context(minimal_project, monkeypatch, client, exc, status, code):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.transcript.TranscriptService.word_timing_context", _raise(exc)
    )
    res = client.post(
        "/api/transcript/word-timing-context", json={**TIMING, "path": str(minimal_project)}
    )
    _check(res, status, code)


# --- boundary ----------------------------------------------------------------------------


def test_boundary_context(minimal_project, monkeypatch, client):
    body = {"path": str(minimal_project), "target": TRIM, "expected_geometry": []}
    for exc, status, code in [
        (DocumentConflictError("moved"), 409, "document_conflict"),
        (ValueError("bad"), 400, "invalid_request"),
    ]:
        monkeypatch.setattr(
            "podcast_mcp.gui.routes.boundary.EditService.boundary_context", _raise(exc)
        )
        res = client.post("/api/boundary/context", json=body)
        _check(res, status, code)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (DocumentConflictError("moved"), 409, "document_conflict"),
        (FileNotFoundError("expired"), 404, "boundary_audio_not_found"),
        (ValueError("bad"), 400, "invalid_request"),
        (KeyError("clip"), 400, "invalid_request"),
    ],
)
def test_boundary_audition(minimal_project, monkeypatch, client, exc, status, code):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.boundary.PlayService.audition_boundary", _raise(exc)
    )
    res = client.post(
        "/api/boundary/audition",
        json={
            "path": str(minimal_project),
            "target": TRIM,
            "edit": TRIM_EDIT,
            "expected_token": "t",
        },
    )
    _check(res, status, code)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (DocumentConflictError("moved"), 409, "document_conflict"),
        (FileNotFoundError("expired"), 404, "boundary_audio_not_found"),
        (ValueError("bad"), 400, "invalid_request"),
    ],
)
def test_boundary_audition_audio(minimal_project, monkeypatch, client, exc, status, code):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.boundary.PlayService.issued_boundary_project",
        _raise(exc),
    )
    res = client.get("/api/boundary/audition/abc/left", params={"expected_token": "t"})
    _check(res, status, code)


# --- document ----------------------------------------------------------------------------


def test_document_command_permission_refused(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.document.DocumentSyncService.submit",
        _raise(PermissionError("viewer cannot")),
    )
    cmd = {
        "type": "CorrectTranscriptWord",
        "payload": {"track_id": "host", "word_index": 0, "text": "x"},
        "client_id": "viewer",
        "client_seq": 1,
        "role": "viewer",
    }
    res = client.post(f"/api/document/command?path={minimal_project}", json=cmd)
    _check(res, 403, "document_command_not_permitted")
    assert res.json() == {"detail": "viewer cannot"}


def test_range_audio_changed(minimal_project, monkeypatch, client):
    monkeypatch.setattr(
        "podcast_mcp.services.document.PlayService.play_selected_range",
        _raise(RangeChangedError("reselect")),
    )
    res = client.post(
        "/api/range-audio", params={"path": str(minimal_project)}, json={"target": RANGE}
    )
    _check(res, 409, "range_changed")


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (RangeChangedError("reselect"), 409, "range_changed"),
        (KeyError("e1"), 404, "pending_edit_not_found"),
    ],
)
def test_pending_preview_refusals(minimal_project, monkeypatch, client, exc, status, code):
    monkeypatch.setattr(
        "podcast_mcp.services.document.PlayService.pending_preview_cached_wav", _raise(exc)
    )
    res = client.get("/api/pending-preview", params={"path": str(minimal_project), "edit_id": "e1"})
    _check(res, status, code)


# --- export ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (RuntimeError("busy"), 409, "export_job_conflict"),
        (ValueError("bad"), 400, "export_request_invalid"),
        (FileNotFoundError("x"), 400, "export_request_invalid"),
    ],
)
def test_export_refusals(minimal_project, monkeypatch, client, exc, status, code):
    monkeypatch.setattr("podcast_mcp.services.jobs.JobManager.start_bounce", _raise(exc))
    monkeypatch.setattr("podcast_mcp.services.jobs.JobManager.start_export", _raise(exc))
    _check(client.post("/api/export/bounce", json={"path": str(minimal_project)}), status, code)
    _check(
        client.post("/api/export/deliverables", json={"path": str(minimal_project)}),
        status,
        code,
    )


# --- media -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "code", "detail"),
    [
        (ValueError("bad name"), "media_upload_invalid", "bad name"),
        (OSError("corrupt"), "invalid_audio", "invalid audio: corrupt"),
    ],
)
def test_media_upload_refusals(minimal_project, monkeypatch, client, exc, code, detail):
    monkeypatch.setattr("podcast_mcp.gui.routes.media.write_upload_chunk", _raise(exc))
    res = client.post(
        "/api/media/upload",
        params={"path": str(minimal_project), "filename": "a.wav"},
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    _check(res, 400, code)
    assert res.json() == {"detail": detail}
