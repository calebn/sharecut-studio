"""A command that cannot write the project answers in plain words."""

from __future__ import annotations

import errno
import sqlite3

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import CodedPermissionError

BODY = {
    "client_id": "c",
    "client_seq": 1,
    "command_id": "abc",
    "role": "viewer",
    "type": "SetTrackMeta",
    "payload": {"track_id": "host", "label": "X"},
}
PATH = "/proj/secret-episode/project.json"


def _post(minimal_project, monkeypatch, exc):
    def fail(self, *args, **kwargs):
        raise exc

    monkeypatch.setattr(DocumentSyncService, "_submit", fail)
    with TestClient(create_app(served_project=minimal_project), raise_server_exceptions=False) as c:
        return c.post("/api/document/command", params={"path": str(minimal_project)}, json=BODY)


@pytest.mark.parametrize(
    ("exc", "status", "words"),
    [
        (OSError(errno.ENOSPC, "No space left on device", PATH), 507, "disk is full"),
        (OSError(errno.EDQUOT, "Disk quota exceeded", PATH), 507, "disk is full"),
        (
            PermissionError(errno.EACCES, "Permission denied", PATH),
            500,
            "could not write to the project folder",
        ),
        (
            OSError(errno.EROFS, "Read-only file system", PATH),
            500,
            "could not write to the project folder",
        ),
        (OSError(errno.EIO, "Input/output error", PATH), 500, "disk reported an error"),
    ],
)
def test_os_write_failure_names_the_cause_and_the_fix(
    minimal_project, monkeypatch, exc, status, words
):
    response = _post(minimal_project, monkeypatch, exc)
    assert response.status_code == status
    assert response.headers["x-sharecut-error-code"] == "project_write_failed"
    detail = response.json()["detail"]
    assert words in detail
    assert "try again" in detail
    assert "secret-episode" not in response.text
    assert "Errno" not in response.text


def test_sqlite_disk_full_is_a_write_failure(minimal_project, monkeypatch):
    exc = sqlite3.OperationalError("database or disk is full")
    exc.sqlite_errorcode = 13
    response = _post(minimal_project, monkeypatch, exc)
    assert response.status_code == 507
    assert response.headers["x-sharecut-error-code"] == "project_write_failed"


def test_a_permission_policy_refusal_stays_a_403(minimal_project, monkeypatch):
    exc = CodedPermissionError("not allowed", code="share_capability_required")
    response = _post(minimal_project, monkeypatch, exc)
    assert response.status_code == 403
    assert response.headers["x-sharecut-error-code"] == "share_capability_required"


def test_an_os_error_that_is_not_a_write_failure_is_left_alone(minimal_project, monkeypatch):
    response = _post(minimal_project, monkeypatch, FileNotFoundError(errno.ENOENT, "gone", PATH))
    assert response.status_code == 500
    assert "project_write_failed" not in response.headers.get("x-sharecut-error-code", "")


def test_a_bare_permission_error_without_an_errno_stays_a_403(minimal_project, monkeypatch):
    response = _post(minimal_project, monkeypatch, PermissionError("viewer cannot"))
    assert response.status_code == 403
    assert response.headers["x-sharecut-error-code"] == "document_command_not_permitted"
    assert response.json() == {"detail": "viewer cannot"}
