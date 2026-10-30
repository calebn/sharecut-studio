from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.edits.bleed_restore_targets import BleedRestoreChangedError
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, ClipOffSpeakerMuteRegion, MediaAsset, Track
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document.bleed_inspection import inspect_clip_bleed
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import authorize_document_command
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.projection_types import ViewProjection
from podcast_mcp.services.document_sync.projections import projection_for_command
from podcast_mcp.services.document_sync.service import STALE_TARGET_ERRORS
from sqlite_helpers import FailingConnection


@pytest.fixture
def restore_project(minimal_project: Path) -> Path:
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            transcript_gate=False,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    ws.project.clips = [
        Clip(
            id="selected",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=1, end_s=2)],
        )
    ]
    ws.save()
    return minimal_project


def _target(path: Path) -> dict:
    inspection = inspect_clip_bleed(ProjectWorkspace.open(path), "selected", track_id="host")
    assert inspection.regions[0].target is not None
    return inspection.regions[0].target.model_dump(mode="json")


def test_typed_restore_requires_complete_opening_target(restore_project):
    target = _target(restore_project)
    assert validate_payload("RestoreClipBleed", {"target": target}) == {"target": target}
    for changed in ({**target, "expected_head_id": None}, {**target, "kind": "ordinary"}):
        with pytest.raises(ValidationError):
            validate_payload("RestoreClipBleed", {"target": changed})
    with pytest.raises(ValidationError):
        validate_payload("RestoreClipBleed", {"target": target, "rerender": True})
    assert BleedRestoreChangedError in STALE_TARGET_ERRORS
    assert projection_for_command("RestoreClipBleed") is ViewProjection.CLIPS


def test_generated_restore_contract_requires_inspected_opening(restore_project):
    schema_path = Path(__file__).resolve().parents[1] / "schemas/document-commands.schema.json"
    schema = json.loads(schema_path.read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    command = {
        "type": "RestoreClipBleed",
        "client_id": "contract-test",
        "client_seq": 1,
        "payload": {"target": _target(restore_project)},
    }
    validator.validate(command)
    for head in (None, "", 1):
        changed = json.loads(json.dumps(command))
        changed["payload"]["target"]["expected_head_id"] = head
        assert not validator.is_valid(changed)
    del command["payload"]["target"]["expected_head_id"]
    assert not validator.is_valid(command)


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_roles_below_editor_cannot_restore_automatic_attenuation(role):
    with pytest.raises(PermissionError):
        authorize_document_command(capabilities_for_role(role, with_mcp=True), "RestoreClipBleed")


def test_an_editor_restores_automatic_attenuation():
    authorize_document_command(capabilities_for_role("editor", with_mcp=True), "RestoreClipBleed")


def test_host_inspection_endpoint_is_read_only(restore_project):
    before = restore_project.read_bytes()
    response = TestClient(create_app()).get(
        f"/api/clips/selected/bleed?path={quote(str(restore_project))}&track_id=host"
    )
    assert response.status_code == 200, response.text
    inspection = response.json()
    assert inspection["plan_state"] == "disabled"
    assert inspection["regions"][0]["kind"] == "bleed_mute:off_speaker"
    assert inspection["regions"][0]["target"]["expected_head_id"] == "root"
    assert restore_project.read_bytes() == before


def test_inspection_rejects_relay_guest_and_other_served_project(restore_project, tmp_path):
    app = create_app()
    client = TestClient(app)
    url = f"/api/clips/selected/bleed?path={quote(str(restore_project))}&track_id=host"
    assert client.get(url, headers={"X-Sharecut-Relayed": "1"}).status_code == 403
    app.state.served_project = tmp_path / "different.project.json"
    assert client.get(url).status_code == 403


def test_inspection_missing_occurrence_returns_refresh_conflict(restore_project):
    response = TestClient(create_app()).get(
        f"/api/clips/missing/bleed?path={quote(str(restore_project))}&track_id=host"
    )
    assert response.status_code == 409
    assert response.headers["X-Sharecut-Error-Code"] == "bleed_restore_changed"


def _exercise_retry(restore_project):
    svc = DocumentSyncService.open(restore_project)
    command = DocumentCommand(
        type="RestoreClipBleed",
        payload={"target": _target(restore_project)},
        client_id="bleed-test",
        role="viewer",
        client_seq=1,
    )
    applied = svc.submit(command)
    assert applied["ok"]
    head = ProjectWorkspace.open(restore_project).project.history.head_id()
    assert applied["command"]["payload"]["result"]["history_head_id"] == head
    assert svc.submit(command)["idempotent"] is True
    with pytest.raises(DocumentConflictError) as error:
        svc.submit(replace(command, command_id="new-id", client_seq=2))
    assert error.value.code == "bleed_restore_changed"
    assert ProjectWorkspace.open(restore_project).project.history.head_id() == head
    undone = svc.submit(
        DocumentCommand(
            type="UndoHistory",
            payload={"expected_head_id": head, "rerender": False},
            client_id="bleed-test",
            role="viewer",
            client_seq=2,
        )
    )
    assert undone["ok"]
    assert ProjectWorkspace.open(restore_project).project.clips[0].bleed_restore is None


def test_document_restore_retry_and_new_id_stale_replay(restore_project):
    from podcast_mcp.services.collaboration.share_registry import get_share_registry
    from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError

    try:
        get_share_registry().recording_key_secret()
    except RegistryPrivacyError as error:
        pytest.skip(f"Disposable registry rejected by host filesystem ownership guard: {error}")
    _exercise_retry(restore_project)


def test_document_retry_journal_with_projection_stub(restore_project, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.dump_project_projection",
        lambda ws, **_kwargs: {"history": {"head_id": ws.project.history.head_id()}},
    )
    _exercise_retry(restore_project)


def test_saved_restore_recovers_journal_without_reapplying(restore_project, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.dump_project_projection",
        lambda ws, **_kwargs: {"history": {"head_id": ws.project.history.head_id()}},
    )
    svc = DocumentSyncService.open(restore_project)
    command = DocumentCommand(
        type="RestoreClipBleed",
        payload={"target": _target(restore_project)},
        client_id="restore-crash",
        role="agent",
        client_seq=None,
    )
    real_connection = svc.store._conn
    with monkeypatch.context() as patch:
        patch.setattr(
            svc.store, "_conn", FailingConnection(real_connection, "INSERT INTO commands")
        )
        with pytest.raises(sqlite3.OperationalError, match="injected failure"):
            svc.submit(command)
    saved = ProjectWorkspace.open(restore_project).project
    assert saved.clips[0].bleed_restore is not None
    assert saved.document_sync.last_command.command_id == command.command_id
    head = saved.history.head_id()
    retry = DocumentSyncService.open(restore_project).submit(command)
    assert retry["idempotent"] is True
    assert retry["command"]["payload"]["result"] is None
    assert ProjectWorkspace.open(restore_project).project.history.head_id() == head


def test_cli_and_host_mcp_inspection_return_same_opaque_target(restore_project):
    from podcast_mcp.cli.edit import edit_app
    from podcast_mcp.mcp.tools.timeline import inspect_clip_bleed_tool

    result = CliRunner().invoke(
        edit_app,
        [
            "inspect-clip-bleed",
            "--project",
            str(restore_project),
            "--clip",
            "selected",
            "--track",
            "host",
        ],
    )
    assert result.exit_code == 0, result.output
    cli = json.loads(result.output)
    mcp = json.loads(inspect_clip_bleed_tool(str(restore_project), "selected", "host"))
    assert cli == mcp
    assert cli["regions"][0]["target"] == _target(restore_project)


def test_cli_and_host_mcp_forward_target_and_retry_identity(restore_project, tmp_path, monkeypatch):
    from podcast_mcp.cli.edit import edit_app
    from podcast_mcp.mcp.tools.timeline import restore_clip_bleed_tool

    target = _target(restore_project)
    target_file = tmp_path / "target.json"
    target_file.write_text(json.dumps(target))
    calls = []

    def submit(project, command, payload, **kwargs):
        calls.append((str(project), command, payload, kwargs))
        return {"command": {"payload": {"result": {"history_head_id": "saved-head"}}}}

    monkeypatch.setattr("podcast_mcp.services.document_sync.submit_host_document_command", submit)
    monkeypatch.setattr("podcast_mcp.mcp.tools.timeline.submit_host_document_command", submit)
    result = CliRunner().invoke(
        edit_app,
        [
            "restore-clip-bleed",
            "--project",
            str(restore_project),
            "--target",
            str(target_file),
            "--command-id",
            "same-id",
        ],
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {"history_head_id": "saved-head"}
    assert json.loads(restore_clip_bleed_tool(str(restore_project), target, "same-id")) == {
        "history_head_id": "saved-head"
    }
    assert len(calls) == 2
    assert all(
        call[:3] == (str(restore_project), "RestoreClipBleed", {"target": target}) for call in calls
    )
    assert [call[3] for call in calls] == [
        {"client_id": "cli:host", "command_id": "same-id"},
        {"client_id": "mcp:host", "command_id": "same-id"},
    ]
    assert ProjectWorkspace.open(restore_project).project.clips[0].bleed_restore is None
