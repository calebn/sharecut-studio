"""One length limit on gate notes and waiver reasons, on every surface."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.review_gate import GATE_TEXT_MAX_CHARS
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.align_accept import AlignAcceptService
from podcast_mcp.services.media.transcript_refine import TranscriptRefineService

OVER = "x" * (GATE_TEXT_MAX_CHARS + 1)
EXACT = "x" * GATE_TEXT_MAX_CHARS
SERVICES = [TranscriptRefineService, AlignAcceptService]


def _sidecar(project: Path, name: str) -> Path:
    return project.parent / "artifacts" / name


def test_limit_is_two_thousand_characters() -> None:
    assert GATE_TEXT_MAX_CHARS == 2000


@pytest.mark.parametrize("service", SERVICES)
def test_service_refuses_over_long_notes_and_writes_nothing(minimal_project, service) -> None:
    svc = service(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ValueError, match=r"notes are too long: 2001 characters.*limit is 2000"):
        svc.mark_done(notes=OVER)
    assert svc.status()["status"] == "pending"


@pytest.mark.parametrize("service", SERVICES)
def test_service_refuses_over_long_reason(minimal_project, service) -> None:
    svc = service(ProjectWorkspace.open(minimal_project))
    with pytest.raises(ValueError, match=r"reason is too long: 2001 characters.*limit is 2000"):
        svc.waive(reason=OVER)
    assert svc.status()["status"] == "pending"


@pytest.mark.parametrize("service", SERVICES)
def test_service_accepts_text_exactly_at_the_limit(minimal_project, service) -> None:
    svc = service(ProjectWorkspace.open(minimal_project))
    assert svc.mark_done(notes=EXACT)["notes"] == EXACT
    assert svc.waive(reason=EXACT)["notes"] == EXACT


def test_over_long_notes_are_refused_on_a_repeat_check(minimal_project) -> None:
    svc = TranscriptRefineService(ProjectWorkspace.open(minimal_project))
    svc.mark_checked()
    with pytest.raises(ValueError, match="too long"):
        svc.mark_checked(notes=OVER)
    assert svc.mark_checked(notes=EXACT)["status"] == "done"


@pytest.mark.parametrize(
    ("args", "refused"),
    [
        (["transcript", "refine-done", "--notes"], True),
        (["transcript", "refine-waive", "--reason"], True),
        (["align", "done", "--notes"], True),
        (["align", "waive", "--reason"], True),
        (["transcript", "refine-done", "--notes"], False),
        (["transcript", "refine-waive", "--reason"], False),
        (["align", "done", "--notes"], False),
        (["align", "waive", "--reason"], False),
    ],
)
def test_cli_limit(minimal_project, args, refused) -> None:
    text = OVER if refused else EXACT
    result = CliRunner().invoke(
        app, [*args[:-1], "--project", str(minimal_project), args[-1], text]
    )
    if refused:
        assert result.exit_code != 0
        assert "too long" in result.output
        assert "gate_text_too_long" in result.output
    else:
        assert result.exit_code == 0, result.output
        assert json.loads(result.output)["notes"] == EXACT


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool", "field"),
    [
        ("transcript_refine_done_tool", "notes"),
        ("transcript_refine_waive_tool", "reason"),
        ("align_done_tool", "notes"),
        ("align_waive_tool", "reason"),
    ],
)
async def test_mcp_limit(minimal_project, tool, field) -> None:
    pytest.importorskip("mcp.client")
    from mcp.client import Client

    async with Client(mcp_server.mcp) as client:
        refused = await client.call_tool(tool, {"project_path": str(minimal_project), field: OVER})
        assert refused.is_error is True
        assert refused.structured_content["error_code"] == "gate_text_too_long"
        assert "too long" in refused.structured_content["error"]
        passed = await client.call_tool(tool, {"project_path": str(minimal_project), field: EXACT})
        assert passed.is_error is False
        assert json.loads(passed.content[0].text)["notes"] == EXACT


@pytest.mark.parametrize(
    ("route", "field"),
    [("/api/transcript/refine/done", "notes"), ("/api/transcript/refine/waive", "reason")],
)
def test_http_limit(minimal_project, route, field) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    refused = client.post(route, json={"path": str(minimal_project), field: OVER})
    assert refused.status_code == 400
    assert refused.headers["X-Sharecut-Error-Code"] == "gate_text_too_long"
    assert "too long: 2001 characters" in refused.json()["detail"]
    assert not _sidecar(minimal_project, "transcript_refine_status.json").exists()
    passed = client.post(route, json={"path": str(minimal_project), field: EXACT})
    assert passed.status_code == 200
