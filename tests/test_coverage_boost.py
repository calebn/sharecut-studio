"""Extra unit tests to lift coverage on history/summary, gui serve, shares."""

from __future__ import annotations

from datetime import UTC
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_capabilities import (
    guest_mode,
    has_capability,
    normalize_capabilities,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.history.summary import (
    _fmt_sec,
    _human_op,
    _track_list,
    format_history_group_title,
    summarize_diff,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import (
    ShareService,
    lookup_share,
    open_share_workspace,
    share_add_comment,
    share_add_reply,
    share_allows_mcp,
)


def test_fmt_sec_and_human_op_and_tracks():
    assert _fmt_sec(None) == "?"
    assert _fmt_sec(-1) == "0:00.0"
    assert "1:01:00" in _fmt_sec(3660) or _fmt_sec(3660).startswith("1:")
    assert _human_op(None, None) == "snapshot"
    assert _human_op(None, "before cut") == "cut"
    assert _track_list(None) is None
    assert _track_list([None]) is None
    assert _track_list(["a", "b", "c", "d"]) == "a, b, c +1"


def test_format_history_title_branches():
    assert "fade" in format_history_group_title(
        kind="mutation",
        operation="fade",
        params={"fade_ms": 12, "gain_db": -1.5, "query": "hello", "track_id": "h"},
    )
    assert "@" in format_history_group_title(
        kind="mutation", operation="seek", params={"start": 3.0}
    )
    # bad range types ignored
    t = format_history_group_title(
        kind="mutation",
        operation="x",
        params={"timeline_start": "a", "timeline_end": "b"},
    )
    assert "x" in t


def test_summarize_diff_more_branches():
    lines = summarize_diff(
        {
            "edit_log": {
                "added": [
                    "skip",
                    {
                        "operation": "cut",
                        "timeline_start": "bad",
                        "timeline_end": "bad",
                        "track_ids": ["a"] * 5,
                    },
                ]
            },
            "clips": {
                "added": [{}],
                "removed": [{}, {}],
                "changed": [{}],
            },
            "edit_decisions": {"added": [{}], "removed": [{}]},
            "tracks": {
                "changed": [
                    "skip",
                    {
                        "track_id": "host",
                        "fields": [
                            {"field": "gain"},
                            {"field": "eq"},
                            {"field": "gate"},
                            {"field": "comp"},
                            {"field": "extra"},
                            "nope",
                        ],
                    },
                ]
            },
            "timeline_duration_sec": {"old": "x", "new": "y"},
            "mix_changed": True,
            "meta_changed": True,
        }
    )
    assert any("clip" in line for line in lines)
    assert any("pending edit" in line for line in lines)
    assert any("track settings" in line for line in lines)
    assert any("mix" in line for line in lines)
    assert any("meta" in line for line in lines)

    empty = summarize_diff(
        {
            "clips": {},
            "edit_decisions": {},
            "edit_log": {},
            "tracks": {},
            "mix_changed": False,
            "meta_changed": False,
            "timeline_duration_sec": {},
        },
        label=None,
        operation=None,
    )
    assert empty


def test_normalize_capabilities_variants():
    assert normalize_capabilities(None) == [
        "play",
        "comment",
        "reply",
        "action",
    ]
    assert "edit" in normalize_capabilities("play,edit,unknown")
    assert "play" in normalize_capabilities(["view"])
    assert normalize_capabilities(["nope"]) == [
        "play",
        "comment",
        "reply",
        "action",
    ]
    assert guest_mode(["edit"]) == "edit"
    assert guest_mode(["suggest"]) == "suggest"
    assert guest_mode(["play"]) == "view"
    assert guest_mode([]) == "none"
    assert has_capability(["view"], "play")
    assert has_capability(["comment"], "reply")


def test_gui_serve_main_and_missing_uvicorn():
    from podcast_mcp.gui import serve

    with patch("podcast_mcp.gui.bind.run_gui_server") as run:
        serve.main(["--host", "0.0.0.0", "--port", "9001", "--log-level", "info"])
        run.assert_called_once()
        assert run.call_args.kwargs["host"] == "0.0.0.0"
        assert run.call_args.kwargs["port"] == 9001
        assert run.call_args.kwargs["log_level"] == "info"

    with patch("podcast_mcp.gui.bind.gui_server_deps_available", return_value=False):
        with pytest.raises(SystemExit, match="GUI dependencies"):
            serve.main([])


def _seed_share(minimal_project, sample_wav, tmp_workspace, monkeypatch, caps=None):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="cov")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=caps,
        public_base_url="http://example.test",
    )
    return ws, ver, share


def test_share_error_paths_and_replies(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, _ver, share = _seed_share(
        minimal_project, sample_wav, tmp_workspace, monkeypatch, caps=["play"]
    )
    tok = share["token"]
    assert share["mcp_url"] is None
    assert share_allows_mcp(tok) is False

    with pytest.raises(PermissionError):
        share_add_comment(tok, body="x", author="a", timeline_start=0.0)
    with pytest.raises(PermissionError):
        share_add_reply(tok, "cid", body="x", author="a")

    # Missing project file
    row = lookup_share(tok)
    row["project_workspace"] = str(tmp_workspace / "gone")
    from podcast_mcp.edits.review_shares import register_share_globally

    register_share_globally(row)
    with pytest.raises(FileNotFoundError):
        open_share_workspace(tok)

    with pytest.raises(KeyError):
        ShareService(ws).revoke("missing-token")


def test_review_share_route_errors(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, _ver, share = _seed_share(
        minimal_project,
        sample_wav,
        tmp_workspace,
        monkeypatch,
        caps=["play", "comment", "reply", "mcp"],
    )
    tok = share["token"]
    client = TestClient(create_app())

    # Reply to missing comment
    bad = client.post(
        f"/api/review/{tok}/comments/nope/replies",
        json={"body": "r", "author": "a"},
    )
    assert bad.status_code in (400, 404)

    posted = client.post(
        f"/api/review/{tok}/comments",
        json={"body": "hi", "author": "a", "timeline_start": 0.2},
    )
    assert posted.status_code == 200
    cid = posted.json()["comment"]["id"]
    ok = client.post(
        f"/api/review/{tok}/comments/{cid}/replies",
        json={"body": "re", "author": "b"},
    )
    assert ok.status_code == 200

    # Audio ok
    assert client.get(f"/api/review/{tok}/audio").status_code == 200

    # MCP enabled JSON-RPC ping
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    assert client.get(f"/mcp/{tok}").status_code == 200
    ping = client.post(
        f"/mcp/{tok}/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
    )
    assert ping.status_code == 200
    assert ping.json()["result"] == {}

    # Revoke then 404
    ShareService(ws).revoke(tok)
    assert client.get(f"/api/review/{tok}/project").status_code == 404
    assert client.get(f"/mcp/{tok}").status_code == 404


def test_review_share_cli(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="cli")

    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        [
            "review",
            "share",
            "--project",
            str(minimal_project),
            "--version",
            ver["id"],
            "--base-url",
            "http://relay.test",
            "--capabilities",
            "play,comment,mcp",
        ],
    )
    assert result.exit_code == 0
    assert "Share URL" in result.output or "/r/" in result.output


def test_create_review_share_tool(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.mcp.tools.review import (
        create_review_share_tool,
        list_review_versions_tool,
        publish_review_version_tool,
        set_active_review_version_tool,
    )

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    pub = publish_review_version_tool(str(minimal_project), "tool-v")
    assert "id" in pub
    listed = list_review_versions_tool(str(minimal_project))
    assert "tool-v" in listed or "id" in listed
    import json

    vid = json.loads(pub)["id"]
    set_active_review_version_tool(str(minimal_project), vid)
    out = create_review_share_tool(
        str(minimal_project),
        vid,
        public_base_url="http://r.test",
        capabilities="play,view,suggest,edit",
    )
    assert "suggest" in out or "edit" in out


def test_share_object_store_warning_and_daw_meta(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from datetime import datetime, timedelta

    from podcast_mcp.edits.share_registry import share_hard_expired
    from podcast_mcp.services.share import (
        ShareService,
        share_daw_meta,
        share_daw_peaks,
    )

    ws, ver, share = _seed_share(
        minimal_project,
        sample_wav,
        tmp_workspace,
        monkeypatch,
        caps=["play", "view", "mcp"],
    )

    def _boom(*_a, **_k):
        raise RuntimeError("object_store down")

    monkeypatch.setattr("podcast_mcp.services.share.upload_review_version_to_object_store", _boom)
    again = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
        public_base_url="http://example.test",
    )
    assert again["url"].startswith("http://example.test/r/")

    meta = share_daw_meta(share["token"])
    assert "mtime_ns" in meta and "size" in meta

    with pytest.raises(KeyError, match="track"):
        share_daw_peaks(share["token"], "missing-track")

    assert share_hard_expired({}) is False
    assert share_hard_expired({"expires_at": "not-a-date"}) is False
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    assert share_hard_expired({"expires_at": past}) is True
    naive = (datetime.now(UTC) - timedelta(days=1)).replace(tzinfo=None).isoformat()
    assert share_hard_expired({"expires_at": naive}) is True
