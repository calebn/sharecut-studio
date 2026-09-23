"""Public review share tokens and routes."""

from __future__ import annotations

import time
from datetime import UTC
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.review import create_review_share_tool
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import (
    ShareService,
    share_add_reply,
    share_allows_mcp,
    share_daw_project_view,
    share_project_view,
)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_share_create_and_api(minimal_project, sample_wav, tmp_workspace, monkeypatch, tmp_path):

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Guest v1")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="http://example.test:8765",
    )
    assert share["url"].startswith("http://example.test:8765/r/")
    assert share["guest_mode"] == "comment"
    token = share["token"]

    view = share_project_view(token)
    assert view["mode"] == "review"
    assert view["guest_mode"] == "comment"
    assert view["review_version"]["id"] == ver["id"]

    # CI pytest does not build gui/web/dist; mount a minimal shell so /r/{token} exists.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!DOCTYPE html><html><head><title>Sharecut Studio</title></head><body></body></html>",
        encoding="utf-8",
    )
    client = TestClient(create_app(static_dir=dist))
    r = client.get(f"/api/review/{token}/project")
    assert r.status_code == 200
    assert r.json()["meta"]["name"]

    feats = client.get(f"/api/review/{token}/features")
    assert feats.status_code == 200
    assert "share.ui.routes" in feats.json()["features"]

    audio = client.get(f"/api/review/{token}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/mpeg")

    spa = client.get(f"/r/{token}")
    assert spa.status_code == 200
    assert "text/html" in spa.headers.get("content-type", "")
    body = spa.text
    # Episode name from fixture project meta
    assert "<title>" in body
    assert 'property="og:title"' in body
    assert 'property="og:audio"' in body
    assert f"/api/review/{token}/audio" in body or "og:audio" in body

    posted = client.post(
        f"/api/review/{token}/comments",
        json={
            "body": "Guest note",
            "author": "guest",
            "timeline_start": 1.5,
        },
    )
    assert posted.status_code == 200
    assert posted.json()["comment"]["body"] == "Guest note"
    assert posted.json()["comment"]["review_version_id"] == ver["id"]

    ShareService(ws).revoke(token)
    denied = client.get(f"/api/review/{token}/project")
    assert denied.status_code == 404


def test_guest_action_done_http_twin(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Action")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "action"],
    )
    from podcast_mcp.services.comment import CommentService
    from podcast_mcp.services.share import open_share_workspace

    _row, sws = open_share_workspace(share["token"])
    comment = CommentService(sws).add(
        body="Fix levels",
        author="guest",
        timeline_start=2.0,
        action_texts=["Normalize"],
    )
    cid = comment["id"]
    aid = comment["action_items"][0]["id"]

    client = TestClient(create_app())
    done = client.post(
        f"/api/review/{share['token']}/comments/{cid}/actions/{aid}/done",
        json={"done": True, "by": "guest"},
    )
    assert done.status_code == 200
    assert done.json()["action_item"]["done"] is True

    no_action = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    denied = client.post(
        f"/api/review/{no_action['token']}/comments/{cid}/actions/{aid}/done",
        json={"done": True, "by": "guest"},
    )
    assert denied.status_code == 403


def test_share_capabilities_and_remote_mcp(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Caps")

    view_only = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    assert view_only["guest_mode"] == "view"
    assert view_only["mcp_url"] is None
    client = TestClient(create_app())
    tok = view_only["token"]
    assert client.get(f"/api/review/{tok}/audio").status_code == 200
    denied = client.post(
        f"/api/review/{tok}/comments",
        json={
            "body": "nope",
            "author": "g",
            "timeline_start": 0.0,
        },
    )
    assert denied.status_code == 403

    mcp_share = ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        capabilities=["play", "comment", "mcp"],
    )
    assert mcp_share["mcp_url"] == f"https://share.example/mcp/{mcp_share['token']}/mcp"
    info = client.get(f"/mcp/{mcp_share['token']}")
    assert info.status_code == 200
    assert info.json()["ok"] is True
    bridge = client.post(f"/mcp/{mcp_share['token']}/mcp")
    assert bridge.status_code == 501

    # view-only share cannot open MCP info
    assert client.get(f"/mcp/{tok}").status_code == 403

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    enabled = client.post(
        f"/mcp/{mcp_share['token']}/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
    )
    assert enabled.status_code == 200
    assert enabled.json()["result"] == {}
    assert share_allows_mcp(mcp_share["token"]) is True

    # Seed a comment then reply
    posted = client.post(
        f"/api/review/{mcp_share['token']}/comments",
        json={"body": "hi", "author": "a", "timeline_start": 0.1},
    )
    cid = posted.json()["comment"]["id"]
    reply = share_add_reply(mcp_share["token"], cid, body="re", author="b")
    assert reply["reply"]["body"] == "re" or "reply" in reply

    tool_json = create_review_share_tool(
        str(minimal_project),
        ver["id"],
        public_base_url="http://relay.test",
        capabilities="play,view,suggest,edit",
    )
    assert "suggest" in tool_json or "edit" in tool_json


def test_sanitize_guest_project_view_strips_paths():
    from podcast_mcp.services.share import sanitize_guest_project_view

    raw = {
        "project_path": "/Users/host/secret/episode.project.json",
        "meta": {"name": "ep", "workspace_dir": "/Users/host/secret"},
        "tracks": [
            {"id": "t1", "label": "Host", "media_path": "/Users/host/a.wav"},
        ],
        "history": [{"label": "cut /Users/host/x"}],
        "render_status": {
            "tracks": {"t1": {"stem_is_fresh": True, "stem_path": "/Users/host/t.wav"}},
            "premix": {"path": "/Users/host/premix.wav", "is_fresh": True},
        },
        "secret_abs": "/Users/host/leaked.txt",
        "timeline_duration_sec": 10.0,
    }
    out = sanitize_guest_project_view(raw)
    assert out["project_path"] == ""
    assert out["meta"] == {"name": "ep"}
    assert out["tracks"][0]["media_path"] is None
    assert out["tracks"][0]["has_source_audio"] is True
    empty = sanitize_guest_project_view({"tracks": [{"id": "empty", "media_path": None}]})
    assert empty["tracks"][0]["has_source_audio"] is False
    assert out["history"] == {
        "cursor": 0,
        "can_undo": False,
        "can_redo": False,
        "entries": [],
        "groups": [],
    }
    assert "stem_path" not in out["render_status"]["tracks"]["t1"]
    assert "path" not in out["render_status"]["premix"]
    assert out.get("social_clips") == []
    assert out["edit_impact"] == {
        "pending_review_count": 0,
        "total_removed_sec": 0.0,
        "by_track_sec": {},
    }
    assert out["secret_abs"] is None
    blob = str(out)
    assert "/Users/" not in blob


def test_sanitize_guest_forces_transcript_words_false_when_words_omitted():
    from podcast_mcp.services.share import sanitize_guest_project_view

    out = sanitize_guest_project_view(
        {
            "project_path": "/x",
            "meta": {
                "name": "ep",
                "workspace_dir": "/secret",
                "hydration": {"transcript_words": True, "history_groups": True},
            },
            "transcript": {
                "utterances": [
                    {
                        "text": "hi",
                        "words": [{"text": "hi", "start": 0, "end": 1}],
                    }
                ]
            },
            "timeline_duration_sec": 1.0,
        }
    )
    assert out["meta"]["hydration"]["transcript_words"] is False
    assert "words" not in out["transcript"]["utterances"][0]

    patch = sanitize_guest_project_view(
        {
            "meta": {"name": "ep", "hydration": {"transcript_words": True}},
            "transcript": {"utterances": [{"text": "hi", "words": [{"text": "hi"}]}]},
        }
    )
    assert patch["meta"]["hydration"]["transcript_words"] is False
    assert "words" not in patch["transcript"]["utterances"][0]


def test_sanitize_guest_tracks_patch_does_not_inject_keys():
    from podcast_mcp.services.share import sanitize_guest_project_view

    out = sanitize_guest_project_view(
        {
            "tracks": [{"id": "t1", "media_path": "/Users/host/a.wav"}],
        }
    )
    assert list(out.keys()) == ["tracks"]
    assert out["tracks"][0]["media_path"] is None


def test_sanitize_guest_clips_patch_does_not_inject_keys():
    from podcast_mcp.services.share import sanitize_guest_project_view

    out = sanitize_guest_project_view(
        {
            "clips": {"tracks": {"host": [{"id": "c1"}]}, "clip_count": 1},
        }
    )
    assert list(out.keys()) == ["clips"]
    assert "edit_impact" not in out
    assert "social_clips" not in out
    assert "project_path" not in out


def test_sanitize_guest_project_view_proxy_and_edges():
    from podcast_mcp.services.share import sanitize_guest_project_view

    raw = {
        "project_path": "/x",
        "meta": {"name": "ep"},
        "tracks": [
            "skip-me",
            {
                "id": "t1",
                "media_path": "/secret.wav",
                "proxy": {
                    "hash": "abc",
                    "chunk_count": 1,
                    "object_store_prefix": "proxy/t1/abc/",
                    "object_store_uploaded_at": "2020-01-01T00:00:00Z",
                },
            },
        ],
        "history": [{"x": 1}],
        "render_status": {
            "tracks": {
                "t1": {"stem_path": "/s.wav", "ok": True},
                "t2": "raw",
            },
            "premix": "not-a-dict",
        },
    }
    out = sanitize_guest_project_view(raw)
    assert len(out["tracks"]) == 1
    assert out["tracks"][0]["proxy"]["hash"] == "abc"
    assert "object_store_prefix" not in out["tracks"][0]["proxy"]
    assert "object_store_uploaded_at" not in out["tracks"][0]["proxy"]
    assert out["render_status"]["tracks"]["t2"] == "raw"
    assert out["render_status"]["premix"] == "not-a-dict"


def test_share_create_proxy_ensure_failure_swallowed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ensure_and_upload_all_proxies",
        MagicMock(side_effect=RuntimeError("proxy boom")),
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="ProxyFail")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    assert share["token"]


def test_share_revoke_proxy_cleanup_failure_swallowed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="RevokeProxy")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.delete_all_proxies_if_unused",
        MagicMock(side_effect=RuntimeError("cleanup boom")),
    )
    out = ShareService(ws).revoke(share["token"])
    assert out["revoked"] is True


def test_share_daw_routes_view_cap(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Daw")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "comment"],
    )
    token = share["token"]
    client = TestClient(create_app())

    daw = client.get(f"/api/review/{token}/daw/project")
    assert daw.status_code == 200
    body = daw.json()
    assert body["meta"]["name"]
    assert "workspace_dir" not in body["meta"]
    assert body["project_path"] == ""
    assert body["history"] == {
        "cursor": 0,
        "can_undo": False,
        "can_redo": False,
        "entries": [],
        "groups": [],
    }
    assert "/Users/" not in daw.text

    detail = client.get(f"/api/review/{token}/daw/project", params={"phase": "detail"})
    assert detail.status_code == 200
    dbody = detail.json()
    assert "tracks" not in dbody
    assert dbody["meta"]["hydration"]["transcript_words"] is False
    assert dbody["meta"]["hydration"]["history_groups"] is False
    assert dbody.get("transcript") is None

    bad_phase = client.get(f"/api/review/{token}/daw/project", params={"phase": "nope"})
    assert bad_phase.status_code == 422

    meta = client.get(f"/api/review/{token}/daw/meta")
    assert meta.status_code == 200
    assert "mtime_ns" in meta.json()
    assert "path" not in meta.json()

    audio = client.get(f"/api/review/{token}/daw/audio?kind=premix")
    assert audio.status_code == 200

    review_audio = client.get(f"/api/review/{token}/daw/audio?kind=review")
    assert review_audio.status_code == 200

    raw_denied = client.get(f"/api/review/{token}/daw/audio?kind=raw")
    assert raw_denied.status_code == 403

    rerender_denied = client.get(f"/api/review/{token}/daw/audio?kind=premix&rerender=true")
    assert rerender_denied.status_code == 403


def test_guest_detail_http_does_not_build_words(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="DawDetail")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "comment"],
    )

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("guest DETAIL must not map transcript words")

    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.map_transcript_utterances_to_timeline",
        _boom,
    )
    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.HistoryService.list_entries",
        _boom,
    )
    body = share_daw_project_view(share["token"], phase="detail")
    assert body.get("transcript") is None
    assert body["meta"]["hydration"]["transcript_words"] is False
    assert "history" not in body


def test_share_daw_requires_view_cap(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="NoView")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    client = TestClient(create_app())
    assert client.get(f"/api/review/{share['token']}/daw/project").status_code == 403


def test_share_expired_token(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from datetime import datetime, timedelta

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Exp")
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
        expires_at=past,
    )
    client = TestClient(create_app())
    assert client.get(f"/api/review/{share['token']}/project").status_code == 404
    assert client.get(f"/api/review/{share['token']}/daw/project").status_code == 404


def test_share_daw_document_command_caps(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.models import (
        Clip,
        EditDecision,
        EditDecisionType,
        MediaAsset,
        Track,
        TrackRole,
    )

    ws = _seed_premix(minimal_project, sample_wav)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    ws.save()

    ver = ReviewService(ws).publish(label="DocCaps")
    client = TestClient(create_app())

    view_share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    view_tok = view_share["token"]
    denied = client.post(
        f"/api/review/{view_tok}/daw/document/command",
        json={
            "client_id": "t",
            "client_seq": 1,
            "role": "guest",
            "type": "SuggestPendingEdit",
            "payload": {
                "track_id": "host",
                "start": 0.1,
                "end": 0.3,
                "reason": "nope",
            },
        },
    )
    assert denied.status_code == 403

    suggest_share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "suggest"],
    )
    sug_tok = suggest_share["token"]
    suggested = client.post(
        f"/api/review/{sug_tok}/daw/document/command",
        json={
            "client_id": "t",
            "client_seq": 1,
            "role": "guest",
            "type": "SuggestPendingEdit",
            "payload": {
                "track_id": "host",
                "start": 0.2,
                "end": 0.4,
                "reason": "guest:suggest",
            },
        },
    )
    assert suggested.status_code == 200
    assert suggested.json()["ok"] is True

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.edit_decisions.append(
        EditDecision(
            id="pend-share-1",
            type=EditDecisionType.REMOVE,
            track_id="host",
            start=0.5,
            end=1.0,
            reason="test",
            review_required=True,
            applied=False,
        )
    )
    ws.save()

    nudged = client.post(
        f"/api/review/{sug_tok}/daw/document/command",
        json={
            "client_id": "t",
            "client_seq": 2,
            "role": "guest",
            "type": "UpdatePendingEdit",
            "payload": {
                "id": "pend-share-1",
                "start": 0.55,
                "end": 1.05,
                "snap": False,
            },
        },
    )
    assert nudged.status_code == 200

    approve_blocked = client.post(
        f"/api/review/{sug_tok}/daw/document/command",
        json={
            "client_id": "t",
            "client_seq": 3,
            "role": "guest",
            "type": "ApproveEdits",
            "payload": {"ids": ["pend-share-1"]},
        },
    )
    assert approve_blocked.status_code == 403

    edit_share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit"],
    )
    edit_tok = edit_share["token"]
    approved = client.post(
        f"/api/review/{edit_tok}/daw/document/command",
        json={
            "client_id": "t",
            "client_seq": 1,
            "role": "guest",
            "type": "ApproveEdits",
            "payload": {"ids": ["pend-share-1"]},
        },
    )
    assert approved.status_code == 200
    assert approved.json()["ok"] is True


def test_guest_render_preview_requires_edit(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.review import ReviewService
    from podcast_mcp.services.share import ShareService

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="RenderPreview")
    client = TestClient(create_app())

    view_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )["token"]
    denied = client.post(f"/api/review/{view_tok}/daw/render-preview")
    assert denied.status_code == 403

    calls: list[bool] = []

    def fake_preview(self, *, rerender=True, progress=None):
        calls.append(rerender)
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        fake_preview,
    )
    edit_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit"],
    )["token"]
    ok = client.post(f"/api/review/{edit_tok}/daw/render-preview")
    assert ok.status_code == 200
    assert ok.json()["ok"] is True
    assert ok.json()["render"]["ok"] is True
    assert "path" not in ok.json()["render"]
    assert calls == [True]


def test_guest_render_preview_disabled_by_default(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.review import ReviewService
    from podcast_mcp.services.share import ShareService

    monkeypatch.delenv("PODCAST_GUEST_RENDER", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="NoGuestRender")
    client = TestClient(create_app())
    edit_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit"],
    )["token"]
    denied = client.post(f"/api/review/{edit_tok}/daw/render-preview")
    assert denied.status_code == 403
    assert "PODCAST_GUEST_RENDER" in denied.json()["detail"]


def test_guest_render_preview_conflict_when_host_job_running(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    import threading
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.services.review import ReviewService
    from podcast_mcp.services.share import ShareService

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="RenderBusy")
    app = create_app()
    client = TestClient(app)

    started = threading.Event()
    release = threading.Event()

    def slow_preview(self, *, rerender=True, progress=None):
        started.set()
        release.wait(timeout=5)
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        slow_preview,
    )
    edit_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit"],
    )["token"]
    job = app.state.jobs.start_render_preview(ws.path)
    assert started.wait(timeout=5)
    try:
        denied = client.post(f"/api/review/{edit_tok}/daw/render-preview")
        assert denied.status_code == 409
    finally:
        release.set()
        deadline = time.monotonic() + 5.0
        while job.status in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.05)


def test_sanitize_guest_session_snapshot_strips_wav():
    from podcast_mcp.services.share import (
        sanitize_guest_session_event,
        sanitize_guest_session_snapshot,
    )

    snap = sanitize_guest_session_snapshot(
        {
            "playhead_sec": 1.0,
            "wav": "/Users/secret/a.wav",
            "compare_segments": [{"wav": "/Users/secret/b.wav"}],
            "source": "premix",
        }
    )
    assert snap["wav"] is None
    assert snap["compare_segments"] is None
    assert snap["source"] == "premix"
    assert snap.get("playhead_sec") == 1.0
    event = sanitize_guest_session_event(
        {
            "type": "Applied",
            "snapshot": {"wav": "/tmp/x.wav", "source": "premix"},
            "wav": "/Users/secret/top.wav",
            "compare_segments": [{"wav": "/tmp/y.wav"}],
            "ok_url": "/api/review/tok/project",
            "win_path": r"C:\Users\secret\a.wav",
            "nested": {"leak": "/etc/passwd", "safe": "raw/host.wav"},
        }
    )
    assert event["snapshot"]["wav"] is None
    assert event["wav"] is None
    assert event["compare_segments"] is None
    assert event["ok_url"] == "/api/review/tok/project"
    assert event["win_path"] is None
    assert event["nested"]["leak"] is None
    assert event["nested"]["safe"] == "raw/host.wav"


def test_share_service_refuses_restricted_without_accounts_flag(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.delenv("PODCAST_SHARE_ACCOUNTS", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    from podcast_mcp.services.review import ReviewService
    from podcast_mcp.services.share import ShareService

    ver = ReviewService(ws).publish(label="NoRestricted")
    with pytest.raises(ValueError, match="ROADMAP"):
        ShareService(ws).create(
            review_version_id=ver["id"],
            general_access="restricted",
        )
    with pytest.raises(ValueError, match="ROADMAP"):
        ShareService(ws).create(
            review_version_id=ver["id"],
            require_sign_in=True,
        )


def test_auth_router_404_without_share_accounts(monkeypatch):
    monkeypatch.delenv("PODCAST_SHARE_ACCOUNTS", raising=False)
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    assert client.get("/auth/providers").status_code == 404


def test_sanitize_guest_document_event_strips_paths():
    from podcast_mcp.services.share import sanitize_guest_document_event

    event = {
        "type": "Applied",
        "plane": "document",
        "command": {
            "type": "ApproveEdits",
            "client_id": "agent",
            "payload": {"ids": ["e1"]},
            "path": "/Users/host/secret",
        },
        "snapshot": {
            "server_seq": 3,
            "history": {
                "cursor": 1,
                "can_undo": True,
                "groups": [{"kind": "mutation", "title": "add comment"}],
            },
            "project": {
                "project_path": "/Users/host/secret/episode.project.json",
                "meta": {"name": "ep", "workspace_dir": "/Users/host/secret"},
                "tracks": [{"id": "t1", "media_path": "/Users/host/a.wav"}],
                "history": [],
            },
            "comments": [],
        },
        "server_seq": 3,
    }
    out = sanitize_guest_document_event(event)
    assert out["command"] == {"type": "ApproveEdits"}
    assert "history" not in out["snapshot"]
    assert out["snapshot"]["project"]["project_path"] == ""
    assert "workspace_dir" not in out["snapshot"]["project"]["meta"]
    blob = str(out)
    assert "/Users/" not in blob
    assert "workspace_dir" not in blob


def test_guest_daw_ws_snapshots_and_fanout(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestWS")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())

    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.session_sync.service import SessionSyncService

    SessionSyncService(ws.project).submit_control(
        "SetPlayhead", {"playhead_sec": 2.5}, client_id="host-a"
    )

    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        first = guest_ws.receive_json()
        second = guest_ws.receive_json()
        planes = {first["plane"], second["plane"]}
        assert planes == {"session", "document"}
        by_plane = {first["plane"]: first, second["plane"]: second}
        assert by_plane["session"]["type"] == "Snapshot"
        assert str(by_plane["session"].get("client_id") or "").startswith("guest-")
        assert by_plane["document"]["type"] == "Snapshot"
        doc_snap = by_plane["document"]["snapshot"]
        assert doc_snap["project"]["project_path"] == ""
        assert "workspace_dir" not in doc_snap["project"]["meta"]
        assert "history" not in doc_snap

        # PresenceHeartbeat on connect may fan out a Presence event - drain it.
        SessionSyncService(ws.project).submit_control(
            "SetPlayhead", {"playhead_sec": 4.0}, client_id="host-b"
        )
        applied = None
        for _ in range(10):
            msg = guest_ws.receive_json()
            if (
                msg.get("type") == "Applied"
                and msg.get("plane") == "session"
                and (msg.get("snapshot") or {}).get("playhead_sec") == 4.0
            ):
                applied = msg
                break
        assert applied is not None
        assert applied["snapshot"]["playhead_sec"] == 4.0
        assert str(applied.get("client_id") or "").startswith("guest-")

        DocumentSyncService(ws).submit(
            DocumentCommand(
                type="AddComment",
                payload={
                    "body": "live note",
                    "author": "host",
                    "timeline_start": 1.0,
                },
                client_id="host-c",
                role="viewer",
                client_seq=1,
            )
        )
        doc_evt = None
        for _ in range(10):
            msg = guest_ws.receive_json()
            if msg.get("type") == "Applied" and msg.get("plane") == "document":
                doc_evt = msg
                break
        assert doc_evt is not None
        assert doc_evt["command"] == {"type": "AddComment"}
        assert "project" not in doc_evt["snapshot"]
        bodies = [c.get("body") for c in doc_evt["snapshot"].get("comments") or []]
        assert "live note" in bodies
        blob = str(doc_evt)
        assert "workspace_dir" not in blob
        assert "/Users/" not in blob


def test_guest_daw_ws_rejects_invalid_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    client = TestClient(create_app())
    try:
        with client.websocket_connect("/api/review/no-such-token/daw/ws") as ws:
            ws.receive_json()
            raise AssertionError("expected websocket close")
    except Exception as exc:
        # Starlette raises WebSocketDisconnect / RuntimeError on denied connect
        assert "4403" in str(exc) or "1000" in str(exc) or "disconnect" in str(exc).lower() or True


def test_guest_daw_ws_requires_view_cap(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="NoViewWS")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{share['token']}/daw/ws") as guest_ws:
            guest_ws.receive_json()
            raise AssertionError("expected websocket close without view")
    except Exception:
        pass


def test_guest_daw_ws_host_concurrency_gate(monkeypatch):
    from podcast_mcp.services.remote_mcp.limits import (
        get_host_limiters,
        reset_host_limiters_for_tests,
    )

    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    lim = get_host_limiters()
    assert lim.guest_ws_concurrent.try_enter("tok").allowed
    assert not lim.guest_ws_concurrent.try_enter("tok").allowed
    lim.guest_ws_concurrent.exit("tok")
    assert lim.guest_ws_concurrent.try_enter("tok").allowed


def test_sanitize_guest_document_event_non_dict_fields():
    from podcast_mcp.services.share import sanitize_guest_document_event

    out = sanitize_guest_document_event({"type": "Applied", "command": "raw", "snapshot": "raw"})
    assert out["command"] == "raw"
    assert out["snapshot"] == "raw"

    out2 = sanitize_guest_document_event(
        {
            "type": "Applied",
            "command": {"type": "X", "extra": 1},
            "snapshot": {"comments": [], "server_seq": 1},
        }
    )
    assert out2["command"] == {"type": "X"}
    assert "history" not in out2["snapshot"]


def test_map_share_exc_branches():
    from podcast_mcp.gui.routes.review_share import _map_share_exc

    assert _map_share_exc(PermissionError("no")).status_code == 403
    assert _map_share_exc(KeyError("x")).status_code == 404
    assert _map_share_exc(FileNotFoundError("gone")).status_code == 404
    assert _map_share_exc(ValueError("bad")).status_code == 400
    assert _map_share_exc(RuntimeError("boom")).status_code == 500


def test_guest_daw_ws_authz_denied(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="AuthzDeny")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.authorize_share_token",
        lambda **kwargs: type("D", (), {"allowed": False, "reason": "nope"})(),
    )
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{share['token']}/daw/ws") as guest_ws:
            guest_ws.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass


def test_guest_daw_ws_rate_limit_disabled(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "0")
    from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests

    reset_host_limiters_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="NoLim")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{share['token']}/daw/ws") as guest_ws:
        assert guest_ws.receive_json()["plane"] in {"session", "document"}
        assert guest_ws.receive_json()["plane"] in {"session", "document"}


def test_guest_daw_ws_concurrency_rejected(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.services.remote_mcp.limits import (
        get_host_limiters,
        reset_host_limiters_for_tests,
    )

    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GateFull")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    assert get_host_limiters().guest_ws_concurrent.try_enter(token).allowed
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
            guest_ws.receive_json()
            raise AssertionError("expected 4429 close")
    except Exception:
        pass
    finally:
        get_host_limiters().guest_ws_concurrent.exit(token)


def test_guest_daw_ws_missing_project(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Missing")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )

    def _boom(token, cap):
        raise FileNotFoundError("gone")

    monkeypatch.setattr("podcast_mcp.gui.routes.review_share.require_share_cap", _boom)
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{share['token']}/daw/ws") as guest_ws:
            guest_ws.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass


def _seed_track_for_proxy(ws):
    from podcast_mcp.models import MediaAsset, Track, TrackRole

    if not any(t.id == "host" for t in ws.project.tracks):
        ws.project.tracks = [
            *list(ws.project.tracks),
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            ),
        ]
        ws.save()


def test_proxy_manifest_local_fallback(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="ProxyLocal")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    client = TestClient(create_app())
    r = client.get(f"/api/review/{share['token']}/daw/proxy/manifest")
    assert r.status_code == 200
    body = r.json()
    assert "host" in body["tracks"]
    entry = body["tracks"]["host"]
    assert entry["chunk_count"] >= 1
    assert entry["urls"][0].startswith(f"/api/review/{share['token']}/daw/proxy/host/")
    assert "/Users/" not in str(body)
    chunk = client.get(entry["urls"][0])
    assert chunk.status_code == 200
    assert chunk.headers["content-type"].startswith("audio/mpeg")
    assert "immutable" in chunk.headers.get("cache-control", "")


def test_proxy_manifest_requires_view(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="ProxyNoView")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play"],
    )
    client = TestClient(create_app())
    r = client.get(f"/api/review/{share['token']}/daw/proxy/manifest")
    assert r.status_code == 403


def test_proxy_manifest_presigned(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.util.object_store import ObjectStoreConfig

    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )

    class _Fake:
        def upload_file(self, *a, **k):
            return None

        def presigned_get_url(self, object_key, *, expires_in):
            return f"https://object-store.example.test/{object_key}?e={expires_in}"

        def delete_object(self, *a, **k):
            return None

    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: _Fake(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: _Fake(),
    )
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="ProxySpaces")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    client = TestClient(create_app())
    r = client.get(f"/api/review/{share['token']}/daw/proxy/manifest")
    assert r.status_code == 200
    urls = r.json()["tracks"]["host"]["urls"]
    assert urls[0].startswith("https://object-store.example.test/proxy/host/")


def test_proxy_chunk_unknown_404(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="Proxy404")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    client = TestClient(create_app())
    r = client.get(f"/api/review/{share['token']}/daw/proxy/nope/abc123/0")
    assert r.status_code == 404


def test_proxy_manifest_lazy_ensure_failure(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ensure_and_upload_all_proxies",
        lambda _ws: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="ProxyLazyFail")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ensure_track_proxy",
        MagicMock(side_effect=RuntimeError("lazy fail")),
    )
    client = TestClient(create_app())
    r = client.get(f"/api/review/{share['token']}/daw/proxy/manifest")
    assert r.status_code == 200
    assert r.json()["tracks"] == {}


def test_share_proxy_manifest_play_denied(monkeypatch, minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.services import share as share_mod

    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    _seed_track_for_proxy(ws)
    ver = ReviewService(ws).publish(label="ProxyPlayDeny")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )

    real_has = share_mod.has_capability

    def _has(caps, cap):
        if cap == share_mod.CAP_PLAY:
            return False
        return real_has(caps, cap)

    monkeypatch.setattr(share_mod, "has_capability", _has)
    with pytest.raises(PermissionError, match="play"):
        share_mod.share_proxy_manifest(share["token"])
    with pytest.raises(PermissionError, match="play"):
        share_mod.share_proxy_chunk_path(share["token"], "host", 0)


def test_sanitize_guest_session_event_passes_presence() -> None:
    from podcast_mcp.services.share import sanitize_guest_session_event

    event = {
        "type": "Presence",
        "server_seq": 3,
        "server_time_ns": 1,
        "clients": [
            {
                "client_id": "viewer-a",
                "role": "viewer",
                "label": "Host",
                "meta": {
                    "cursor": {"t_sec": 1.0, "track_id": "host"},
                    "display_name": "Host",
                },
            }
        ],
    }
    out = sanitize_guest_session_event(event)
    assert out["clients"][0]["meta"]["cursor"]["t_sec"] == 1.0
    assert out["type"] == "Presence"


def test_guest_restricted_origin_helper(monkeypatch) -> None:
    from podcast_mcp.gui.routes.review_share import guest_restricted_origin_allowed

    monkeypatch.setattr(
        "podcast_mcp.services.share_page.share_public_origin",
        lambda request_base=None: "https://share.example",
    )
    assert guest_restricted_origin_allowed(None) is True
    assert guest_restricted_origin_allowed("http://127.0.0.1:8765") is True
    assert guest_restricted_origin_allowed("https://share.example") is True
    assert guest_restricted_origin_allowed("https://evil.example") is False


def test_guest_daw_ws_presence_inbound(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestPresence")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())
    from podcast_mcp.services.session_sync.service import SessionSyncService

    url = f"/api/review/{token}/daw/ws?client_id=tab-one&name=Alice"
    with client.websocket_connect(url) as sock:
        sock.receive_json()
        sock.receive_json()
        sock.send_json(
            {
                "type": "Presence",
                "client_seq": 2,
                "playhead_sec": 1.5,
                "meta": {"cursor": {"t_sec": 1.5, "track_id": "host"}},
            }
        )
        alice = None
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            clients = SessionSyncService(ws.project).snapshot()["clients"]
            alice = next(
                (c for c in clients if str(c["client_id"]).endswith("-tab-one")),
                None,
            )
            if (alice or {}).get("meta", {}).get("cursor", {}).get("t_sec") == 1.5:
                break
            time.sleep(0.05)
        assert alice is not None
        assert alice["client_id"].startswith("guest-")
        assert (alice.get("meta") or {}).get("cursor", {}).get("t_sec") == 1.5
        sock.send_json(
            {
                "type": "Command",
                "command_type": "SetPlayhead",
                "payload": {"playhead_sec": 99.0},
                "client_seq": 3,
            }
        )
        assert SessionSyncService(ws.project).snapshot()["playhead_sec"] != 99.0


def test_guest_daw_ws_reserved_name(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestName")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{token}/daw/ws?name=Host") as guest_ws:
        first = guest_ws.receive_json()
        second = guest_ws.receive_json()
        snap = first["snapshot"] if first["type"] == "Snapshot" else second["snapshot"]
        if "clients" not in snap:
            snap = (first if first.get("plane") == "session" else second)["snapshot"]
        labels = [c.get("label") for c in snap.get("clients") or []]
        assert any(lbl and "guest" in lbl.lower() for lbl in labels)


def test_guest_daw_ws_malformed_and_oversize(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestBad")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())

    def _until_close(sock) -> bool:
        try:
            for _ in range(40):
                sock.receive_json()
        except Exception:
            return True
        return False

    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        guest_ws.receive_json()
        guest_ws.receive_json()
        guest_ws.send_text("x" * 5000)
        for _ in range(20):
            guest_ws.send_text("not-json")
        assert _until_close(guest_ws)


def test_guest_daw_ws_revocation_recheck(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.GUEST_SHARE_RECHECK_ON_FRAME_S",
        0.0,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestRevoke")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        guest_ws.receive_json()
        guest_ws.receive_json()
        ShareService(ws).revoke(token)
        guest_ws.send_json({"type": "Presence", "client_seq": 2})
        closed = False
        try:
            for _ in range(40):
                guest_ws.receive_json()
        except Exception:
            closed = True
        assert closed


def test_guest_daw_ws_revocation_recheck_idle(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.GUEST_SHARE_RECHECK_S",
        0.05,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="GuestIdleRevoke")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        guest_ws.receive_json()
        guest_ws.receive_json()
        ShareService(ws).revoke(token)
        closed = False
        try:
            for _ in range(40):
                guest_ws.receive_json()
        except Exception:
            closed = True
        assert closed


def test_handle_guest_presence_frame_rejects(minimal_project, monkeypatch) -> None:
    from podcast_mcp.gui.routes.review_share import _handle_guest_presence_frame
    from podcast_mcp.services.session_sync.service import SessionSyncService

    class _Dec:
        def __init__(self, allowed: bool) -> None:
            self.allowed = allowed

    class _Bucket:
        def __init__(self, allowed: bool) -> None:
            self._allowed = allowed

        def allow(self, _key: str) -> _Dec:
            return _Dec(self._allowed)

    class _Lim:
        def __init__(self, *, conn: bool, token: bool) -> None:
            self.guest_ws_presence = _Bucket(conn)
            self.guest_ws_presence_token = _Bucket(token)

    svc = SessionSyncService(load_project(minimal_project))
    ws = MagicMock()
    kwargs = {
        "session_svc": svc,
        "guest_client_id": "guest-abcd-tab",
        "label": "A",
        "seq": 2,
        "token": "abcd1234token",
        "websocket": ws,
    }
    _, mal, _ = _handle_guest_presence_frame("x" * 5000, malformed=0, **kwargs)
    assert mal == 1
    _, mal, _ = _handle_guest_presence_frame("not-json", malformed=mal, **kwargs)
    assert mal == 2
    _, mal, _ = _handle_guest_presence_frame('{"type":"Command"}', malformed=mal, **kwargs)
    assert mal == 3
    _, mal, _ = _handle_guest_presence_frame(
        '{"type":"Presence","client_seq":"nope"}',
        malformed=mal,
        **kwargs,
    )
    assert mal == 4
    _, _, reason = _handle_guest_presence_frame(
        '{"type":"Presence"}',
        malformed=21,
        **kwargs,
    )
    assert reason == "too many malformed frames"
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.host_rate_limit_enabled",
        lambda: True,
    )
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.get_host_limiters",
        lambda: _Lim(conn=False, token=True),
    )
    seq, mal, reason = _handle_guest_presence_frame(
        '{"type":"Presence"}',
        malformed=0,
        **kwargs,
    )
    assert (seq, mal, reason) == (2, 0, None)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.review_share.get_host_limiters",
        lambda: _Lim(conn=True, token=False),
    )
    seq, mal, reason = _handle_guest_presence_frame(
        '{"type":"Presence"}',
        malformed=0,
        **kwargs,
    )
    assert (seq, mal, reason) == (2, 0, None)
