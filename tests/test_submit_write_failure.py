import errno
import sqlite3

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_document_command
from podcast_mcp.util.tool_refusal import tool_refusal
from podcast_mcp.util.write_failure import ProjectWriteFailedError
from test_document_command_boundary import _edit_share, _seed_premix

PATH = "/proj/secret-episode/project.json"
COMMAND = {
    "type": "SetTrackMeta",
    "payload": {"track_id": "host", "label": "X"},
    "client_id": "c",
    "client_seq": 1,
}


def _fail_with(monkeypatch, exc):
    def fail(self, *args, **kwargs):
        raise exc

    monkeypatch.setattr(DocumentSyncService, "_submit", fail)


@pytest.mark.parametrize(
    ("exc", "status", "words"),
    [
        (OSError(errno.ENOSPC, "No space left on device", PATH), 507, "disk is full"),
        (PermissionError(errno.EACCES, "Permission denied", PATH), 500, "read-only"),
        (OSError(errno.EIO, "Input/output error", PATH), 500, "disk reported an error"),
    ],
)
def test_host_submit_raises_a_plain_words_write_failure(
    minimal_project, monkeypatch, exc, status, words
):
    _fail_with(monkeypatch, exc)
    with pytest.raises(ProjectWriteFailedError) as caught:
        submit_host_document_command(minimal_project, "SetTrackMeta", COMMAND["payload"])
    assert caught.value.status == status
    assert words in str(caught.value)
    assert "secret-episode" not in str(caught.value)
    refusal = tool_refusal(caught.value)
    assert refusal is not None
    assert refusal.code == "project_write_failed"
    assert words in refusal.message


def test_sqlite_disk_full_is_a_write_failure(minimal_project, monkeypatch):
    exc = sqlite3.OperationalError("database or disk is full")
    exc.sqlite_errorcode = sqlite3.SQLITE_FULL
    _fail_with(monkeypatch, exc)
    with pytest.raises(ProjectWriteFailedError) as caught:
        submit_host_document_command(minimal_project, "SetTrackMeta", COMMAND["payload"])
    assert caught.value.status == 507


@pytest.mark.parametrize(
    "exc",
    [
        OSError(errno.ENOENT, "No such file", PATH),
        sqlite3.OperationalError("database is locked"),
        ValueError("bad"),
    ],
)
def test_other_errors_pass_through_unchanged(minimal_project, monkeypatch, exc):
    _fail_with(monkeypatch, exc)
    with pytest.raises(type(exc)) as caught:
        submit_host_document_command(minimal_project, "SetTrackMeta", COMMAND["payload"])
    assert caught.value is exc


def test_guest_route_answers_with_guest_words_and_no_host_path(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _edit_share(ws, monkeypatch, tmp_workspace)
    _fail_with(monkeypatch, OSError(errno.ENOSPC, "No space left on device", PATH))
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        response = client.post(f"/api/review/{share['token']}/daw/document/command", json=COMMAND)
    assert response.status_code == 507
    assert response.headers["x-sharecut-error-code"] == "project_write_failed"
    detail = response.json()["detail"]
    assert "Ask the host" in detail
    assert "secret-episode" not in response.text
    assert "disk is full" not in detail


def test_guest_mcp_refusal_uses_the_guest_copy():
    failed = ProjectWriteFailedError("The disk is full", status=507)
    refusal = tool_refusal(failed, for_guest=True)
    assert refusal is not None
    assert refusal.code == "project_write_failed"
    assert refusal.message.startswith("Your change could not be saved on the host")
