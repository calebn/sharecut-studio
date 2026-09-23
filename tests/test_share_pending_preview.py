"""Share HTTP + guest MCP listen-first pending-preview (play+view)."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.play import PlayService
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.share import (
    ShareService,
    share_pending_preview_image,
    share_pending_preview_image_cached,
    share_pending_preview_info,
    share_pending_preview_wav,
    share_pending_preview_wav_cached,
)


def _wav_duration_sec(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _seed_pending_cut(minimal_project, sample_wav, tmp_workspace) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    proj.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.8,
            end=1.2,
            applied=False,
            review_required=True,
            scope="session",
        )
    )
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    return ws


def _share(ws, monkeypatch, tmp_workspace, caps: list[str]):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ver = ReviewService(ws).publish(label="pending-preview")
    return ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        capabilities=caps,
    )


def _mcp_call(token: str, name: str, arguments: dict | None = None, req_id: int = 1):
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )


def test_guest_pending_preview_requires_play_and_view() -> None:
    assert "guest_pending_preview" in tools_for_capabilities(["play", "view", "mcp"])
    # ``view`` implies ``play`` for streaming.
    assert "guest_pending_preview" in tools_for_capabilities(["view", "mcp"])
    assert "guest_pending_preview" not in tools_for_capabilities(["play", "mcp"])
    assert "guest_pending_preview" not in tools_for_capabilities(["play", "comment", "mcp"])


def test_share_pending_preview_http_caps_and_skip(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_pending_cut(minimal_project, sample_wav, tmp_workspace)
    play_only = _share(ws, monkeypatch, tmp_workspace, ["play", "comment"])
    both = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    assert "view" not in (play_only.get("capabilities") or [])
    client = TestClient(create_app())

    denied = client.get(
        f"/api/review/{play_only['token']}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "suggested"},
    )
    assert denied.status_code == 403, denied.text

    split = EditDecision(
        id="split1",
        track_id="host",
        type=EditDecisionType.SPLIT,
        start=1.0,
        end=1.0,
        applied=False,
        timebase="timeline",
    )
    ws.project.edit_decisions.append(split)
    save_project(ws.project, ws.path)
    split_resp = client.get(
        f"/api/review/{both['token']}/daw/pending-preview",
        params={"edit_id": "split1", "mode": "suggested"},
    )
    assert split_resp.status_code == 400
    assert "split" in split_resp.json()["detail"].lower()


def test_share_pending_preview_suggested_shorter_and_mcp_urls(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_pending_cut(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]
    client = TestClient(create_app())

    current = client.get(
        f"/api/review/{token}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "current"},
    )
    suggested = client.get(
        f"/api/review/{token}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "suggested"},
    )
    assert current.status_code == 200, current.text
    assert suggested.status_code == 200, suggested.text
    tmp = tmp_workspace / "out"
    tmp.mkdir(exist_ok=True)
    cur_wav = tmp / "current.wav"
    sug_wav = tmp / "suggested.wav"
    cur_wav.write_bytes(current.content)
    sug_wav.write_bytes(suggested.content)
    assert _wav_duration_sec(sug_wav) < _wav_duration_sec(cur_wav)

    listed = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    )
    names = {t["name"] for t in listed["result"]["tools"]}
    assert "guest_pending_preview" in names

    called = _mcp_call(token, "guest_pending_preview", {"edit_id": "cut1", "mode": "suggested"})
    assert "error" not in called, called
    payload = json.loads(called["result"]["content"][0]["text"])
    audio = payload["audio_path"]
    assert audio.startswith(f"/api/review/{token}/daw/pending-preview")
    assert "edit_id=cut1" in audio
    assert "mode=suggested" in audio
    assert "workspace_dir" not in json.dumps(payload)
    assert "/Users/" not in json.dumps(payload)
    assert "player" not in payload


def test_share_pending_preview_visual_pngs(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_pending_cut(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]

    def _fake_png(self, src, dest, **kwargs):
        dest.write_bytes(b"\x89PNG\r\n")
        return dest

    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_showwavespic",
        _fake_png,
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_spectrogram",
        _fake_png,
    )

    info = share_pending_preview_info(token, edit_id="cut1", mode="suggested", visual=True)
    assert info["wave_path"].startswith(f"/api/review/{token}/daw/pending-preview-image")
    assert "kind=wave" in info["wave_path"]
    assert "kind=spec" in info["spec_path"]
    assert "/Users/" not in json.dumps(info)

    client = TestClient(create_app())
    wave_resp = client.get(
        f"/api/review/{token}/daw/pending-preview-image",
        params={"edit_id": "cut1", "mode": "suggested", "kind": "wave"},
    )
    assert wave_resp.status_code == 200
    assert wave_resp.content.startswith(b"\x89PNG")

    mcp = _mcp_call(
        token,
        "guest_pending_preview",
        {"edit_id": "cut1", "mode": "suggested", "visual": True},
    )
    body = json.loads(mcp["result"]["content"][0]["text"])
    assert "wave_path" in body
    assert "spec_path" in body
    assert "/Users/" not in json.dumps(body)


def test_guest_pending_preview_denied_without_tool(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_pending_cut(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "mcp"])
    denied = _mcp_call(share["token"], "guest_pending_preview", {"edit_id": "cut1"})
    assert denied["error"]["code"] == -32003


def test_share_pending_preview_errors_and_cache(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_pending_cut(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view"])
    token = share["token"]
    client = TestClient(create_app())

    assert (
        client.get(
            f"/api/review/{token}/daw/pending-preview",
            params={"edit_id": "cut1", "mode": "nope"},
        ).status_code
        == 400
    )
    assert (
        client.get(
            f"/api/review/{token}/daw/pending-preview",
            params={"edit_id": "missing", "mode": "suggested"},
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/review/{token}/daw/pending-preview-image",
            params={"edit_id": "cut1", "mode": "suggested", "kind": "jpeg"},
        ).status_code
        == 400
    )

    assert share_pending_preview_wav_cached(token, edit_id="cut1", mode="suggested") is None
    assert (
        share_pending_preview_image_cached(token, edit_id="cut1", mode="suggested", kind="wave")
        is None
    )
    first = client.get(
        f"/api/review/{token}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "suggested"},
    )
    assert first.status_code == 200
    cached = share_pending_preview_wav_cached(token, edit_id="cut1", mode="suggested")
    assert cached is not None and cached.is_file()
    second = client.get(
        f"/api/review/{token}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "suggested"},
    )
    assert second.status_code == 200

    ab = client.get(
        f"/api/review/{token}/daw/pending-preview",
        params={"edit_id": "cut1", "mode": "ab"},
    )
    assert ab.status_code == 200
    svc = PlayService(ws)
    assert svc.pending_preview_cached_wav("cut1", mode="suggested") is not None
    assert svc.pending_preview_cached_wav("cut1", mode="current") is not None
    assert svc.pending_preview_cached_wav("cut1", mode="ab") is not None
    with pytest.raises(ValueError, match="mode must be"):
        svc.pending_preview_cached_wav("cut1", mode="nope")

    def _fake_png(self, src, dest, **kwargs):
        dest.write_bytes(b"\x89PNG\r\n")
        return dest

    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_showwavespic",
        _fake_png,
    )
    png = share_pending_preview_image(token, edit_id="cut1", mode="suggested", kind="wave")
    assert png.is_file()
    again = share_pending_preview_image(token, edit_id="cut1", mode="suggested", kind="wave")
    assert again == png
    assert (
        share_pending_preview_image_cached(token, edit_id="cut1", mode="suggested", kind="wave")
        == png
    )
    with pytest.raises(ValueError, match="kind must be"):
        share_pending_preview_image_cached(token, edit_id="cut1", kind="jpeg")
    with pytest.raises(ValueError, match="kind must be"):
        share_pending_preview_image(token, edit_id="cut1", kind="jpeg")
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.unlink()
    with pytest.raises(FileNotFoundError, match="premix"):
        share_pending_preview_wav(token, edit_id="cut1")
