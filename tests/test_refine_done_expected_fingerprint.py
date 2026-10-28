"""refine-done refuses when the transcript changed after the caller reviewed it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.transcript_refine import (
    TranscriptChangedSinceReviewError,
    TranscriptRefineService,
)

MESSAGE = "The transcript changed after you reviewed it. Review it again, then mark it checked."


@pytest.fixture
def project(minimal_project: Path) -> Path:
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2),
                TranscriptWord(text="world", start=0.3, end=0.5),
            ],
        )
    ]
    save_project(proj, minimal_project)
    return minimal_project


def _fingerprint(path: Path) -> str:
    return TranscriptRefineService(ProjectWorkspace.open(path)).status()["fingerprint"]


def _edit_transcript(path: Path) -> None:
    proj = load_project(path)
    proj.transcripts[0].words[1].text = "there"
    save_project(proj, path)


def _sidecar(path: Path) -> Path:
    return path.parent / "artifacts" / "transcript_refine_status.json"


def test_mark_done_with_the_current_fingerprint_writes_done(project) -> None:
    fingerprint = _fingerprint(project)
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    record = svc.mark_done(expected_fingerprint=fingerprint)
    assert record["status"] == "done"
    assert record["transcript_fingerprint"] == fingerprint


def test_mark_done_refuses_a_transcript_edited_after_review(project) -> None:
    reviewed = _fingerprint(project)
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    _edit_transcript(project)
    with pytest.raises(TranscriptChangedSinceReviewError, match=MESSAGE) as caught:
        svc.mark_done(expected_fingerprint=reviewed)
    assert caught.value.code == "transcript_changed"
    assert not _sidecar(project).exists()


def test_mark_done_without_a_fingerprint_is_unchanged(project) -> None:
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    _edit_transcript(project)
    assert svc.mark_done()["status"] == "done"


def test_mark_checked_refuses_and_keeps_the_existing_record(project) -> None:
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    svc.mark_checked()
    recorded = _sidecar(project).read_text(encoding="utf-8")
    with pytest.raises(TranscriptChangedSinceReviewError, match=MESSAGE):
        svc.mark_checked(expected_fingerprint="stale")
    assert _sidecar(project).read_text(encoding="utf-8") == recorded


def test_mark_checked_refuses_a_stale_fingerprint_on_a_fresh_gate(project) -> None:
    reviewed = _fingerprint(project)
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    _edit_transcript(project)
    with pytest.raises(TranscriptChangedSinceReviewError):
        svc.mark_checked(expected_fingerprint=reviewed)
    assert not _sidecar(project).exists()


def test_the_fingerprint_is_compared_with_the_saved_project_not_a_stale_workspace(
    project,
) -> None:
    svc = TranscriptRefineService(ProjectWorkspace.open(project))
    reviewed = svc.status()["fingerprint"]
    _edit_transcript(project)
    with pytest.raises(TranscriptChangedSinceReviewError):
        svc.mark_done(expected_fingerprint=reviewed)


def test_cli_refuses_a_changed_transcript(project) -> None:
    reviewed = _fingerprint(project)
    _edit_transcript(project)
    runner = CliRunner()
    args = ["transcript", "refine-done", "--project", str(project)]
    refused = runner.invoke(app, [*args, "--expected-fingerprint", reviewed])
    assert refused.exit_code != 0
    assert MESSAGE in refused.output
    assert "transcript_changed" in refused.output
    assert not _sidecar(project).exists()
    passed = runner.invoke(app, [*args, "--expected-fingerprint", _fingerprint(project)])
    assert passed.exit_code == 0, passed.output
    assert json.loads(passed.output)["status"] == "done"


@pytest.mark.asyncio
async def test_mcp_refuses_a_changed_transcript(project) -> None:
    pytest.importorskip("mcp.client")
    from mcp.client import Client

    reviewed = _fingerprint(project)
    _edit_transcript(project)
    async with Client(mcp_server.mcp) as client:
        refused = await client.call_tool(
            "transcript_refine_done_tool",
            {"project_path": str(project), "expected_fingerprint": reviewed},
        )
        assert refused.is_error is True
        assert refused.structured_content["error_code"] == "transcript_changed"
        assert refused.structured_content["error"] == MESSAGE
        assert not _sidecar(project).exists()
        passed = await client.call_tool(
            "transcript_refine_done_tool",
            {"project_path": str(project), "expected_fingerprint": _fingerprint(project)},
        )
        assert passed.is_error is False


def test_http_answers_409_for_a_changed_transcript(project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    body = {"path": str(project)}
    reviewed = client.get("/api/transcript/refine/status", params=body).json()["fingerprint"]
    _edit_transcript(project)
    refused = client.post(
        "/api/transcript/refine/done", json={**body, "expected_fingerprint": reviewed}
    )
    assert refused.status_code == 409
    assert refused.headers["X-Sharecut-Error-Code"] == "transcript_changed"
    assert refused.json()["detail"] == MESSAGE
    assert not _sidecar(project).exists()
    current = client.get("/api/transcript/refine/status", params=body).json()["fingerprint"]
    assert current != reviewed
    passed = client.post(
        "/api/transcript/refine/done", json={**body, "expected_fingerprint": current}
    )
    assert passed.status_code == 200
    assert passed.json()["status"] == "done"
    omitted = client.post("/api/transcript/refine/done", json=body)
    assert omitted.status_code == 200
