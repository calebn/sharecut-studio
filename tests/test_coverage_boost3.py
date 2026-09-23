"""CLI comment/review + document HTTP routes + review_shares edge coverage."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.review_shares import (
    register_share_globally,
    resolve_share,
)
from podcast_mcp.edits.share_registry import default_share_registry_db_path
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService

runner = CliRunner()


def _json_from_cli(output: str) -> dict:
    start = output.find("{")
    end = output.rfind("}")
    assert start >= 0 and end > start, output
    return json.loads(output[start : end + 1])


def _seed(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_comment_cli_roundtrip(minimal_project):
    r = runner.invoke(
        cli_app,
        [
            "comment",
            "add",
            "--project",
            str(minimal_project),
            "--body",
            "hello",
            "--author",
            "a",
            "--start",
            "1.5",
            "--end",
            "2.0",
            "--action",
            "fix it",
        ],
    )
    assert r.exit_code == 0, r.output
    cid = _json_from_cli(r.output)["id"]

    assert (
        runner.invoke(cli_app, ["comment", "list", "--project", str(minimal_project)]).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            ["comment", "get", "--project", str(minimal_project), "--id", cid],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "update",
                "--project",
                str(minimal_project),
                "--id",
                cid,
                "--body",
                "updated",
            ],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "reply",
                "--project",
                str(minimal_project),
                "--id",
                cid,
                "--body",
                "re",
                "--author",
                "b",
            ],
        ).exit_code
        == 0
    )

    # action done - need action id from get
    got = runner.invoke(
        cli_app,
        ["comment", "get", "--project", str(minimal_project), "--id", cid],
    )
    comment = _json_from_cli(got.output)
    actions = comment.get("action_items") or []
    if actions:
        aid = actions[0]["id"]
        assert (
            runner.invoke(
                cli_app,
                [
                    "comment",
                    "done",
                    "--project",
                    str(minimal_project),
                    "--id",
                    cid,
                    "--action-id",
                    aid,
                    "--by",
                    "a",
                ],
            ).exit_code
            == 0
        )

    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "resolve",
                "--project",
                str(minimal_project),
                "--id",
                cid,
                "--by",
                "a",
            ],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "delete",
                "--project",
                str(minimal_project),
                "--id",
                cid,
            ],
        ).exit_code
        == 0
    )


def test_comment_cli_errors(minimal_project):
    bad = runner.invoke(
        cli_app,
        [
            "comment",
            "get",
            "--project",
            str(minimal_project),
            "--id",
            "missing",
        ],
    )
    assert bad.exit_code != 0


def test_review_cli_versions_and_shares(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _seed(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    pub = runner.invoke(
        cli_app,
        [
            "review",
            "publish-version",
            "--project",
            str(minimal_project),
            "--label",
            "v1",
        ],
    )
    assert pub.exit_code == 0, pub.output
    vid = _json_from_cli(pub.output)["id"]

    assert (
        runner.invoke(
            cli_app,
            ["review", "list-versions", "--project", str(minimal_project)],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "review",
                "set-active",
                "--project",
                str(minimal_project),
                "--id",
                vid,
            ],
        ).exit_code
        == 0
    )
    share = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            vid,
            "--base-url",
            "http://r.test",
            "--capabilities",
            "play,comment,mcp",
        ],
    )
    assert share.exit_code == 0, share.output
    token = _json_from_cli(share.output)["token"]

    assert (
        runner.invoke(
            cli_app,
            ["review", "list-shares", "--project", str(minimal_project)],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "review",
                "revoke-share",
                "--project",
                str(minimal_project),
                "--token",
                token,
            ],
        ).exit_code
        == 0
    )
    # clear active
    assert (
        runner.invoke(
            cli_app,
            [
                "review",
                "set-active",
                "--project",
                str(minimal_project),
                "--clear",
            ],
        ).exit_code
        == 0
    )


def test_document_http_routes(minimal_project):
    client = TestClient(create_app())
    path = str(minimal_project)

    snap = client.get(
        "/api/document/comments",
        params={"path": path, "client_id": "v1", "role": "viewer"},
    )
    assert snap.status_code == 200
    assert "comments" in snap.json()
    assert "project" not in snap.json()

    add = client.post(
        "/api/document/command",
        params={"path": path},
        json={
            "type": "AddComment",
            "payload": {
                "body": "via http",
                "author": "v",
                "timeline_start": 3.0,
            },
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
            "command_id": uuid4().hex,
        },
    )
    assert add.status_code == 200, add.text
    assert add.json()["ok"] is True

    # bad command type
    bad = client.post(
        "/api/document/command",
        params={"path": path},
        json={
            "type": "NotAThing",
            "payload": {},
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 2,
        },
    )
    assert bad.status_code in (400, 422)


def test_review_shares_find_and_resolve(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    ver = ReviewService(ws).publish(label="find")
    share = ShareService(ws).create(review_version_id=ver["id"])
    token = share["token"]

    found = resolve_share(token)
    assert found is not None
    assert found["token"] == token

    # corrupt registry entry path (registry_path defaults to the process registry)
    register_share_globally(
        {
            **share,
            "project_workspace": str(ws.project.workspace_dir),
            "revoked": False,
        },
    )
    assert resolve_share(token, registry_path=default_share_registry_db_path()) is not None

    # bad registry file (non-sqlite content) at an explicit path is used verbatim
    bad_reg = tmp_workspace / "bad.json"
    bad_reg.write_text("not-json", encoding="utf-8")
    assert resolve_share("x", registry_path=bad_reg) is None


def test_play_cli_dry_run(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    r = runner.invoke(
        cli_app,
        [
            "play",
            "--project",
            str(minimal_project),
            "--source",
            "premix",
            "--start",
            "0",
            "--end",
            "0.5",
            "--dry-run",
        ],
    )
    assert r.exit_code == 0, r.output
    assert "wav" in r.output.lower() or ".wav" in r.output


def test_transcript_precorrect_service(minimal_project):
    from podcast_mcp.services.transcript_precorrect import (
        TranscriptPrecorrectService,
    )
    from podcast_mcp.transcript_context import TranscriptContext

    ws = ProjectWorkspace.open(minimal_project)
    svc = TranscriptPrecorrectService(ws)
    ctx = svc.load_context()
    assert isinstance(ctx, TranscriptContext)
    assert isinstance(svc.get_context(), dict)
    path = svc.set_context(ctx)
    assert path
    # dry_run path
    out = svc.precorrect(dry_run=True)
    assert isinstance(out, dict)
