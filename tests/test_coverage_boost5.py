"""Coverage push: document WS, strip_silence helpers, comment/review edges."""

from __future__ import annotations

import threading
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.comments import (
    add_action_item,
    add_comment,
    add_reply,
    comments_for_view,
    list_comments,
    resolve_comment,
    set_action_item_done,
    update_comment,
)
from podcast_mcp.edits.edit_log import archive_timeline_op, list_applied_edits
from podcast_mcp.edits.strip_silence import _kept_source_ranges, strip_silence
from podcast_mcp.engines.silence import SilenceInterval, detect_silence
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)

runner = CliRunner()


def _recv_until(ws, type_name: str, limit: int = 20) -> dict:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("type") == type_name:
            return msg
    raise AssertionError(f"did not receive type={type_name!r}")


def test_document_ws_snapshot_command_and_error(minimal_project):
    client = TestClient(create_app())
    url = (
        f"/api/document/ws?path={quote(str(minimal_project))}"
        "&client_id=ws-doc&role=viewer&label=Doc"
    )
    with client.websocket_connect(url) as ws:
        first = ws.receive_json()
        assert first["type"] == "Snapshot"
        assert first["plane"] == "document"
        assert "comments" in first["snapshot"]

        ws.send_json(
            {
                "type": "Command",
                "command_type": "AddComment",
                "payload": {
                    "body": "from ws",
                    "author": "ws",
                    "timeline_start": 1.25,
                },
                "client_seq": 1,
                "command_id": uuid4().hex,
            }
        )
        echo = _recv_until(ws, "Echo")
        assert echo.get("ok") is True

        # non-Command messages are ignored
        ws.send_json({"type": "Ping"})

        ws.send_json(
            {
                "type": "Command",
                "command_type": "AddReply",
                "payload": {
                    "comment_id": "missing",
                    "body": "nope",
                    "author": "ws",
                },
                "client_seq": 2,
            }
        )
        err = _recv_until(ws, "Error")
        assert "detail" in err

        ws.send_json(
            {
                "type": "Command",
                "command_type": "NotACommand",
                "payload": {},
                "client_seq": 3,
            }
        )
        err2 = _recv_until(ws, "Error")
        assert "unknown" in err2["detail"].lower() or "detail" in err2


def test_document_ws_submit_runs_off_event_loop(minimal_project, monkeypatch):
    from podcast_mcp.gui.routes import document as document_route
    from podcast_mcp.services.document_sync import DocumentSyncService

    thread_ids: dict[str, int] = {}
    original_parse = document_route.parse_document_command
    original_submit = DocumentSyncService.submit
    original_auth = document_route.authorize_client
    original_snapshot = DocumentSyncService.document_snapshot

    def authorize_on_loop(*args, **kwargs):
        thread_ids["loop"] = threading.get_ident()
        return original_auth(*args, **kwargs)

    def parse_in_worker(*args, **kwargs):
        thread_ids["parse"] = threading.get_ident()
        return original_parse(*args, **kwargs)

    def snapshot_in_worker(self, *args, **kwargs):
        thread_ids.setdefault("snapshot", threading.get_ident())
        return original_snapshot(self, *args, **kwargs)

    def submit_in_worker(self, *args, **kwargs):
        thread_ids["submit"] = threading.get_ident()
        return original_submit(self, *args, **kwargs)

    monkeypatch.setattr(document_route, "authorize_client", authorize_on_loop)
    monkeypatch.setattr(document_route, "parse_document_command", parse_in_worker)
    monkeypatch.setattr(DocumentSyncService, "document_snapshot", snapshot_in_worker)
    monkeypatch.setattr(DocumentSyncService, "submit", submit_in_worker)
    client = TestClient(create_app())
    url = f"/api/document/ws?path={quote(str(minimal_project))}&client_id=ws-worker&role=viewer"
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"
        ws.send_json(
            {
                "type": "Command",
                "command_type": "AddComment",
                "payload": {"body": "worker submit", "author": "ws", "timeline_start": 1.25},
                "client_seq": 1,
            }
        )
        assert _recv_until(ws, "Echo")["ok"] is True
    assert thread_ids["submit"] != thread_ids["loop"]
    assert thread_ids["parse"] == thread_ids["submit"]
    assert thread_ids["snapshot"] != thread_ids["loop"]


def test_document_ws_guest_denied(minimal_project):
    client = TestClient(create_app())
    url = f"/api/document/ws?path={quote(str(minimal_project))}&client_id=g1&role=guest"
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(url):
        pass


def test_document_http_guest_forbidden(minimal_project):
    client = TestClient(create_app())
    r = client.get(
        "/api/document/comments",
        params={
            "path": str(minimal_project),
            "client_id": "g1",
            "role": "guest",
        },
    )
    assert r.status_code == 403


def test_document_command_not_found(minimal_project):
    client = TestClient(create_app())
    r = client.post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "AddReply",
            "payload": {
                "comment_id": "nope",
                "body": "x",
                "author": "a",
            },
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
            "command_id": uuid4().hex,
        },
    )
    assert r.status_code == 409
    body = r.json()
    assert body["detail"]["conflict"] is True


def test_kept_source_ranges_edges():
    assert _kept_source_ranges(10.0, [], 0.05) == [(0.0, 10.0)]

    # Positive padding removes silence interiors; speech islands keep pad air.
    kept_pos = _kept_source_ranges(
        10.0,
        [
            SilenceInterval(start=2.0, end=4.0),
            SilenceInterval(start=7.0, end=8.0),
        ],
        0.1,
    )
    assert kept_pos == [(0.0, 2.1), (3.9, 7.1), (7.9, 10.0)]

    # Negative padding expands the remove into adjacent speech.
    kept_neg = _kept_source_ranges(10.0, [SilenceInterval(start=2.0, end=4.0)], -0.05)
    assert kept_neg == [(0.0, 1.95), (4.05, 10.0)]

    kept_start = _kept_source_ranges(5.0, [SilenceInterval(start=0.0, end=1.0)], 0.0)
    assert kept_start == [(1.0, 5.0)]


def test_strip_silence_no_media_and_relative_path(tmp_path, sample_wav):
    p = EpisodeProject.create("strip2", str(tmp_path))
    with pytest.raises(ValueError, match="not found"):
        strip_silence(p, "missing")

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "podcast_mcp.edits.strip_silence.detect_silence",
            lambda *a, **k: [
                SilenceInterval(start=0.5, end=1.0),
                SilenceInterval(start=1.5, end=1.8),
            ],
        )
        result = strip_silence(
            p, "host", threshold_db=-50, min_duration_sec=0.05, use_inaudible_opt=False
        )
    assert result["clips_created"] >= 1
    assert result["silence_intervals"] == 2


def test_silence_interval_duration_and_orphan_end(tmp_path, sample_wav, monkeypatch):
    assert SilenceInterval(start=1.0, end=0.5).duration == 0.0
    assert SilenceInterval(start=1.0, end=3.0).duration == 2.0

    def fake_run(cmd, capture_output=True, text=True):
        class R:
            stdout = ""
            stderr = (
                "silence_end: 1.0\n"
                "silence_start: 2.0\n"
                "silence_end: 1.5\n"  # end < start → skipped
                "silence_start: 3.0\n"
                "silence_end: 4.0\n"
            )

        return R()

    monkeypatch.setattr("podcast_mcp.engines.silence.run", fake_run)
    monkeypatch.setattr("podcast_mcp.engines.silence.resolve_ffmpeg", lambda: "ffmpeg")
    ivs = detect_silence(sample_wav)
    assert len(ivs) == 1
    assert ivs[0].start == 3.0


def test_comments_validation_edges(minimal_project):
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="body"):
        add_comment(proj, body="  ", author="a", timeline_start=0)
    with pytest.raises(ValueError, match="author"):
        add_comment(proj, body="x", author="", timeline_start=0)
    with pytest.raises(ValueError, match="timeline_start"):
        add_comment(proj, body="x", author="a", timeline_start=-1)
    with pytest.raises(ValueError, match="timeline_end"):
        add_comment(proj, body="x", author="a", timeline_start=2, timeline_end=1)
    with pytest.raises(ValueError, match="unknown track"):
        add_comment(proj, body="x", author="a", timeline_start=0, track_ids=["nope"])

    c = add_comment(
        proj,
        body="ok",
        author="a",
        timeline_start=1.0,
        timeline_end=3.0,
        action_texts=["", "  ", "do"],
    )
    assert len(c.action_items) == 1

    with pytest.raises(ValueError, match="body"):
        update_comment(proj, c.id, body="  ")
    with pytest.raises(ValueError, match="timeline_start"):
        update_comment(proj, c.id, timeline_start=-1)
    update_comment(proj, c.id, timeline_start=2.0, timeline_end=4.0)
    update_comment(proj, c.id, timeline_end=2.0)  # equal → None

    with pytest.raises(ValueError, match="resolved_by"):
        resolve_comment(proj, c.id, by="  ")
    resolve_comment(proj, c.id, by="a", resolved=True)
    resolve_comment(proj, c.id, by="a", resolved=False)
    assert c.resolved is False

    with pytest.raises(ValueError, match="completed_by"):
        set_action_item_done(proj, c.id, c.action_items[0].id, done=True, by="")
    set_action_item_done(proj, c.id, c.action_items[0].id, done=True, by="a")
    set_action_item_done(proj, c.id, c.action_items[0].id, done=False, by="a")
    with pytest.raises(KeyError, match="action item"):
        set_action_item_done(proj, c.id, "missing", done=True, by="a")

    with pytest.raises(ValueError, match="action item text"):
        add_action_item(proj, c.id, "  ")
    add_action_item(proj, c.id, "more")

    with pytest.raises(ValueError, match="reply body"):
        add_reply(proj, c.id, body="", author="b")
    with pytest.raises(ValueError, match="author"):
        add_reply(proj, c.id, body="hi", author="")
    add_reply(proj, c.id, body="hi", author="b")

    assert list_comments(proj, open_actions_only=True)
    assert comments_for_view(proj)


def test_edit_log_list_filters(minimal_project):
    proj = load_project(minimal_project)
    archive_timeline_op(
        proj,
        operation="cut",
        track_ids=["host"],
        timeline_start=1.0,
        timeline_end=2.0,
    )
    archive_timeline_op(
        proj,
        operation="cut2",
        track_ids=["guest"],
        timeline_start=None,
        timeline_end=None,
    )
    archive_timeline_op(
        proj,
        operation="cut3",
        track_ids=["host"],
        timeline_start=10.0,
        timeline_end=12.0,
    )
    assert list_applied_edits(proj, track_id="host")
    filtered = list_applied_edits(proj, track_id="host", timeline_start=0.0, timeline_end=3.0)
    assert len(filtered) == 1
    assert filtered[0].operation == "cut"
    # no overlap
    assert list_applied_edits(proj, track_id="host", timeline_start=5.0, timeline_end=6.0) == []
    # missing timeline on record skipped when window given
    assert list_applied_edits(proj, track_id="guest", timeline_start=0.0, timeline_end=1.0) == []


def test_comment_cli_error_paths(minimal_project):
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "add",
                "--project",
                str(minimal_project),
                "--body",
                "",
                "--author",
                "a",
                "--start",
                "0",
            ],
        ).exit_code
        != 0
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
                "missing",
                "--body",
                "x",
            ],
        ).exit_code
        != 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "add-action",
                "--project",
                str(minimal_project),
                "--id",
                "missing",
                "--text",
                "x",
            ],
        ).exit_code
        != 0
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
                "missing",
                "--body",
                "x",
                "--author",
                "a",
            ],
        ).exit_code
        != 0
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
                "missing",
                "--by",
                "a",
            ],
        ).exit_code
        != 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "done",
                "--project",
                str(minimal_project),
                "--id",
                "missing",
                "--action-id",
                "x",
                "--by",
                "a",
            ],
        ).exit_code
        != 0
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
                "missing",
            ],
        ).exit_code
        != 0
    )


def test_review_cli_error_paths(minimal_project):
    assert (
        runner.invoke(
            cli_app,
            [
                "review",
                "publish-version",
                "--project",
                str(minimal_project),
                "--label",
                "x",
            ],
        ).exit_code
        != 0
    )
    assert (
        runner.invoke(
            cli_app,
            ["review", "set-active", "--project", str(minimal_project)],
        ).exit_code
        != 0
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
                "missing",
            ],
        ).exit_code
        != 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "review",
                "share",
                "--project",
                str(minimal_project),
                "--version",
                "missing",
            ],
        ).exit_code
        != 0
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
                "missing",
            ],
        ).exit_code
        != 0
    )


def test_cli_context_progress_reset():
    from podcast_mcp.cli import context as ctx

    ctx.reset_progress()
    assert ctx.get_progress() is not None
    ctx.configure(progress=False)
    ctx.reset_progress()
    assert ctx.get_progress() is not None


def test_comments_http_error_paths(minimal_project):
    client = TestClient(create_app())
    path = str(minimal_project)

    bad = client.post(
        "/api/comments",
        json={
            "path": path,
            "body": "",
            "author": "a",
            "timeline_start": 0.0,
        },
    )
    assert bad.status_code == 400

    missing = client.patch(
        "/api/comments/nope",
        json={"path": path, "body": "x"},
    )
    assert missing.status_code == 404

    created = client.post(
        "/api/comments",
        json={
            "path": path,
            "body": "ok",
            "author": "a",
            "timeline_start": 0.5,
            "action_texts": ["do"],
        },
    )
    assert created.status_code == 200
    cid = created.json()["comment"]["id"]

    no_by = client.patch(
        f"/api/comments/{cid}",
        json={"path": path, "resolved": True},
    )
    assert no_by.status_code == 400

    # no-op patch returns get
    noop = client.patch(
        f"/api/comments/{cid}",
        json={"path": path},
    )
    assert noop.status_code == 200

    bad_action = client.post(
        f"/api/comments/{cid}/actions/missing/done",
        json={"path": path, "done": True, "by": "a"},
    )
    assert bad_action.status_code == 404

    bad_reply = client.post(
        f"/api/comments/{cid}/replies",
        json={"path": path, "body": "", "author": "b"},
    )
    assert bad_reply.status_code == 400

    del_missing = client.delete("/api/comments/missing", params={"path": path})
    assert del_missing.status_code == 404


def test_comment_cli_add_action_and_tracks(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    save_project(proj, minimal_project)

    add = runner.invoke(
        cli_app,
        [
            "comment",
            "add",
            "--project",
            str(minimal_project),
            "--body",
            "tracked",
            "--author",
            "a",
            "--start",
            "1",
            "--tracks",
            "host",
        ],
    )
    assert add.exit_code == 0, add.output
    cid = add.output[add.output.find("{") :]
    import json

    start = add.output.find("{")
    end = add.output.rfind("}")
    cid = json.loads(add.output[start : end + 1])["id"]

    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "add-action",
                "--project",
                str(minimal_project),
                "--id",
                cid,
                "--text",
                "extra",
            ],
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            cli_app,
            [
                "comment",
                "list",
                "--project",
                str(minimal_project),
                "--open-actions",
            ],
        ).exit_code
        == 0
    )
