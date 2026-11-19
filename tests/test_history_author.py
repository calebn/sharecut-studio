"""Every history step records who wrote it (#3984): host, agent, system, or a share guest."""

from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import load_project, save_project
from podcast_mcp.models.history import HistoryEntry
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.app.workspace import MERGED_HISTORY_LABEL
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import (
    ShareService,
    lookup_share,
    open_share_workspace,
)
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_author,
)
from podcast_mcp.services.document import CommentService, TimelineService
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def entries(project: Path) -> list[HistoryEntry]:
    return load_project(project).history.entries


def last(project: Path) -> HistoryEntry:
    return entries(project)[-1]


def shared_project(minimal_project: Path, sample_wav: Path) -> ProjectWorkspace:
    project = load_project(minimal_project)
    artifacts = Path(project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def editor_share(ws: ProjectWorkspace, *, mcp: bool = False) -> tuple[str, str]:
    version = ReviewService(ws).publish(label="author")
    share = ShareService(ws).create(
        review_version_id=version["id"],
        capabilities=capabilities_for_role("editor", with_mcp=mcp),
    )
    token = share["token"]
    return token, share_author(lookup_share(token))


def add_chapter(client: TestClient, url: str, title: str, seq: int, role: str):
    return client.post(
        url,
        json={
            "client_id": f"author-{seq}",
            "client_seq": seq,
            "role": role,
            "type": "AddChapter",
            "payload": {"title": title, "time": float(seq)},
        },
    )


def mcp_call(token: str, name: str, arguments: dict) -> dict:
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )


def test_a_host_document_command_is_written_by_the_host(minimal_project):
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    reply = add_chapter(
        client, f"/api/document/command?path={quote(str(minimal_project))}", "Intro", 1, "viewer"
    )
    assert reply.status_code == 200, reply.text
    assert (last(minimal_project).label, last(minimal_project).author) == (
        "after add chapter",
        "host",
    )


def test_a_guest_document_command_is_written_by_that_guest(minimal_project, sample_wav):
    ws = shared_project(minimal_project, sample_wav)
    token, author = editor_share(ws)
    client = TestClient(create_app())
    reply = add_chapter(client, f"/api/review/{token}/daw/document/command", "Guest", 1, "guest")
    assert reply.status_code == 200, reply.text
    assert author.startswith("share:")
    assert [(e.label, e.author) for e in entries(minimal_project)[-1:]] == [
        ("after add chapter", author)
    ]


def test_guest_comment_reply_and_action_done_are_written_by_that_guest(minimal_project, sample_wav):
    ws = shared_project(minimal_project, sample_wav)
    token, author = editor_share(ws)
    client = TestClient(create_app())
    posted = client.post(
        f"/api/review/{token}/comments",
        json={"body": "Fix", "author": "g", "timeline_start": 1.0},
    )
    assert posted.status_code == 200, posted.text
    assert last(minimal_project).author == author
    replied = client.post(
        f"/api/review/{token}/comments/{posted.json()['comment']['id']}/replies",
        json={"body": "Reply", "author": "g"},
    )
    assert replied.status_code == 200, replied.text
    assert last(minimal_project).author == author
    _row, guest_ws = open_share_workspace(token)
    comment = CommentService(guest_ws).add(
        body="Todo", author="g", timeline_start=2.0, action_texts=["Normalize"]
    )
    done = client.post(
        f"/api/review/{token}/comments/{comment.id}/actions/{comment.action_items[0].id}/done",
        json={"done": True, "by": "g"},
    )
    assert done.status_code == 200, done.text
    assert [e.author for e in entries(minimal_project)[1:]] == [author] * (
        len(entries(minimal_project)) - 1
    )
    assert len(entries(minimal_project)) >= 5


def test_guest_mcp_command_and_direct_writer_are_written_by_that_guest(minimal_project, sample_wav):
    ws = shared_project(minimal_project, sample_wav)
    token, author = editor_share(ws, mcp=True)
    command = mcp_call(
        token,
        "guest_submit_document_command",
        {"type": "AddChapter", "payload": {"title": "Via MCP", "time": 2.0}},
    )
    assert "error" not in command, command
    assert last(minimal_project).author == author
    count = len(entries(minimal_project))
    comment = mcp_call(
        token, "guest_add_comment", {"body": "MCP note", "author": "g", "timeline_start": 1.0}
    )
    assert "error" not in comment, comment
    assert len(entries(minimal_project)) > count
    assert last(minimal_project).author == author


def test_two_shares_on_one_project_each_stamp_their_own_entries(minimal_project, sample_wav):
    ws = shared_project(minimal_project, sample_wav)
    first_token, first = editor_share(ws)
    second_token, second = editor_share(ws)
    assert first != second
    client = TestClient(create_app())
    for seq, (token, author) in enumerate(((first_token, first), (second_token, second)), start=1):
        reply = add_chapter(
            client, f"/api/review/{token}/daw/document/command", f"C{seq}", seq, "guest"
        )
        assert reply.status_code == 200, reply.text
        assert last(minimal_project).author == author


def test_a_job_started_for_a_guest_records_system(minimal_project, sample_wav, monkeypatch):
    ws = shared_project(minimal_project, sample_wav)
    token, _author = editor_share(ws)
    _row, guest_ws = open_share_workspace(token)

    def changes_the_mix(project, **_kwargs):
        project.timeline.join_fade_max_ms = 40
        return {"ok": True}

    monkeypatch.setattr("podcast_mcp.services.pipeline.service.rerender_preview", changes_the_mix)
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.ProjectWorkspace.open", lambda _path: guest_ws
    )
    job = Job(
        id="author-job",
        project_path=str(guest_ws.path),
        from_step=None,
        only_step=None,
        kind="render_preview",
    )
    JobManager()._run_job(job)
    assert job.status == "ok"
    assert [(e.operation, e.author) for e in entries(minimal_project)[-1:]] == [
        ("render_preview", "system")
    ]


def test_a_merge_entry_is_system_even_when_a_guest_workspace_saved(minimal_project, sample_wav):
    ws = shared_project(minimal_project, sample_wav)
    token, author = editor_share(ws)
    _row, guest_ws = open_share_workspace(token)
    guest_ws.checkpoint()
    TimelineService(ProjectWorkspace.open(minimal_project)).add_chapter(5.0, "Other")
    guest_ws.project.timeline.join_fade_max_ms = 30
    guest_ws.save_merged("after guest run")
    labels = [(e.label, e.author) for e in entries(minimal_project)[-2:]]
    assert labels == [("after guest run", author), (MERGED_HISTORY_LABEL, "system")]


def test_an_mcp_tool_call_is_written_by_the_agent(minimal_project):
    asyncio.run(
        mcp_server.mcp.call_tool(
            "history_record", {"project_path": str(minimal_project), "label": "agent snapshot"}
        )
    )
    assert (last(minimal_project).label, last(minimal_project).author) == (
        "agent snapshot",
        "agent",
    )


def test_the_cli_is_written_by_the_host(minimal_project):
    result = CliRunner().invoke(
        cli_app, ["history", "record", "--project", str(minimal_project), "--label", "from cli"]
    )
    assert result.exit_code == 0, result.output
    assert (last(minimal_project).label, last(minimal_project).author) == ("from cli", "host")


def test_a_call_that_changes_nothing_writes_no_entry(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("first", force=True)
    count = len(entries(minimal_project))
    ws.record_snapshot("same state")
    assert len(entries(minimal_project)) == count
