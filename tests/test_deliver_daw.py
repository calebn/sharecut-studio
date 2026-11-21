import os
import threading
from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from tests.daw_export_fixture import create_daw_export_project

from podcast_mcp.export.daw_format import DawFormat
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.document import ExportFilesService
from podcast_mcp.services.jobs import GUEST_EXPORT_KINDS, guest_visible_job
from podcast_mcp.services.media import daw_session
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import CancelledProgress


@pytest.mark.parametrize("format", list(DawFormat))
def test_download_saved_timeline(format, tmp_path):
    ws = create_daw_export_project(tmp_path)
    saved = ws.path.read_bytes()
    app = create_app()
    client = TestClient(app)
    path = str(ws.path)
    started = client.post("/api/export/daw", json={"path": path, "format": format})
    assert started.status_code == 200, started.text
    job = app.state.jobs.wait(app.state.jobs.get_job(started.json()["job_id"]), timeout=30)
    assert job.status == "ok", job.error
    file_id = f"daw-{job.id}/session-{format}.zip"
    assert job.result == {"file_ids": [file_id]}
    assert guest_visible_job(job, ws.path, GUEST_EXPORT_KINDS) is None
    assert file_id not in [row.id for row in ExportFilesService(ws).list()]
    listed = client.get("/api/export/files", params={"path": path}).json()["files"]
    row = next(row for row in listed if row["id"] == file_id)
    url = f"/api/export/files/{file_id}"
    params = {"path": path, "ticket": row["ticket"]}
    assert client.get(url, params=params, headers={"x-sharecut-relayed": "1"}).status_code == 403
    download = client.get(url, params=params)
    assert download.headers["content-type"] == "application/zip"
    with ZipFile(BytesIO(download.content)) as archive:
        assert archive.testzip() is None
        members = {f"session.{format}"}
        if format != DawFormat.AAF:
            members |= {"media/0001.wav", "media/0002.wav"}
        assert set(archive.namelist()) == members
    assert ws.path.read_bytes() == saved


def test_format_availability_and_host_only_routes(tmp_path, monkeypatch):
    ws = create_daw_export_project(tmp_path)
    client = TestClient(create_app())
    request = {"path": str(ws.path), "format": "rpp"}
    relayed = {"x-sharecut-relayed": "1"}
    assert client.get("/api/export/daw/formats", headers=relayed).status_code == 403
    assert client.post("/api/export/daw", json=request, headers=relayed).status_code == 403
    assert client.post("/api/export/daw", json={**request, "output": "other"}).status_code == 422
    assert client.post("/api/export/daw", json={**request, "format": "wav"}).status_code == 422
    monkeypatch.setattr(daw_session, "owned_stage_supported", lambda: False)
    assert set(client.get("/api/export/daw/formats").json().values()) == {
        "This computer cannot create editable DAW packages."
    }
    assert client.post("/api/export/daw", json=request).status_code == 400


def test_cancel_and_failure_publish_no_archive(tmp_path):
    ws = create_daw_export_project(tmp_path)
    with pytest.raises(CancelledProgress):
        daw_session.export_daw_archive(ws.path, DawFormat.RPP, "a" * 12, lambda: True)
    (tmp_path / "host.wav").unlink()
    with pytest.raises((FileNotFoundError, ValueError)):
        daw_session.export_daw_archive(ws.path, DawFormat.RPP, "b" * 12, lambda: False)
    assert list(ws.project.export_dir().iterdir()) == []


def test_aaf_dependency_does_not_disable_other_formats(monkeypatch):
    def missing():
        raise CodedValueError("Unavailable", code="aaf_export_dependency_missing")

    monkeypatch.setattr(daw_session, "require_aaf_writer", missing)
    assert TestClient(create_app()).get("/api/export/daw/formats").json() == {
        "rpp": None,
        "sesx": None,
        "aaf": "This installation does not include the optional AAF writer.",
    }


def test_second_export_is_refused_and_cancellation_leaves_no_files(tmp_path, monkeypatch):
    ws = create_daw_export_project(tmp_path)
    app = create_app()
    client = TestClient(app)
    started, release = threading.Event(), threading.Event()
    spec = daw_session._SESSION_WRITERS[DawFormat.RPP]

    def waiting_writer(timeline, target):
        started.set()
        assert release.wait(10)
        spec.write(timeline, target)

    monkeypatch.setitem(
        daw_session._SESSION_WRITERS, DawFormat.RPP, replace(spec, write=waiting_writer)
    )
    args = {"path": str(ws.path), "format": "rpp"}
    try:
        response = client.post("/api/export/daw", json=args)
        assert response.status_code == 200
        job_id = response.json()["job_id"]
        assert started.wait(10)
        assert client.post("/api/export/daw", json=args).status_code == 409
        assert client.post("/api/pipeline/cancel", json={"job_id": job_id}).status_code == 200
    finally:
        release.set()
    job = app.state.jobs.wait(app.state.jobs.get_job(job_id), timeout=30)
    assert job.status == "cancelled"
    assert list(ws.project.export_dir().iterdir()) == []


def test_host_session_rows_show_newest_first_and_exclude_unlisted_files(tmp_path):
    ws = create_daw_export_project(tmp_path)
    folder = ws.project.export_dir()
    for number, stamp in [(1, 2_000_000_000), (2, 2_000_000_099), (3, 2_000_000_000)]:
        directory = folder / f"daw-{number:012x}"
        directory.mkdir(parents=True)
        package = directory / "session-rpp.zip"
        package.write_bytes(b"ZIP")
        os.utime(package, ns=(stamp, stamp))
        (directory / "private.zip").write_bytes(b"unlisted")
    rows = ExportFilesService(ws, host_files=True).list()
    assert [(row.id, row.label) for row in rows] == [
        ("daw-000000000002/session-rpp.zip", "Exported 1970-01-01 00:00:02.000 UTC"),
        ("daw-000000000001/session-rpp.zip", "Exported 1970-01-01 00:00:02.000 UTC"),
        ("daw-000000000003/session-rpp.zip", "Exported 1970-01-01 00:00:02.000 UTC"),
    ]
