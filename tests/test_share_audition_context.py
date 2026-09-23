"""Share HTTP + guest MCP windowed hear context (play+view)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS, tools_for_capabilities
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.share import (
    ShareService,
    share_audition_context_cached,
    share_audition_context_image,
    share_audition_context_info,
)


def _seed_dialogue(minimal_project, sample_wav, tmp_workspace) -> ProjectWorkspace:
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
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    return ws


def _share(ws, monkeypatch, tmp_workspace, caps: list[str]):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ver = ReviewService(ws).publish(label="audition-context")
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


def _stub_ffmpeg_pngs(monkeypatch):
    calls = {"n": 0}

    def _fake_png(self, src, dest, **kwargs):
        calls["n"] += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
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
    return calls


def test_guest_audition_context_requires_play_and_view() -> None:
    assert "guest_audition_context" in tools_for_capabilities(["play", "view", "mcp"])
    assert "guest_audition_context" in tools_for_capabilities(["view", "mcp"])
    assert "guest_audition_context" not in tools_for_capabilities(["play", "mcp"])
    assert "guest_audition_context" not in tools_for_capabilities(["play", "comment", "mcp"])
    assert "guest_resolve" not in ALL_GUEST_TOOLS
    assert "guest_resolve_comment" not in ALL_GUEST_TOOLS


def test_share_audition_context_http_caps(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    play_only = _share(ws, monkeypatch, tmp_workspace, ["play", "comment"])
    both = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    _stub_ffmpeg_pngs(monkeypatch)
    client = TestClient(create_app())

    denied = client.get(
        f"/api/review/{play_only['token']}/daw/audition-context",
        params={"start": 0.0, "end": 1.0},
    )
    assert denied.status_code == 403, denied.text

    ok = client.get(
        f"/api/review/{both['token']}/daw/audition-context",
        params={"start": 0.0, "end": 1.0},
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    dumped = json.dumps(body)
    assert "/Users/" not in dumped
    assert "workspace_dir" not in dumped
    assert body["visuals"]
    wave = body["visuals"][0]["wave_path"]
    assert wave.startswith(f"/api/review/{both['token']}/daw/audition-context-image")
    assert "kind=wave" in wave
    assert "astats" not in body["visuals"][0]
    assert "hum" not in body["visuals"][0]


def test_share_audition_context_mcp_urls_and_image(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]
    calls = _stub_ffmpeg_pngs(monkeypatch)

    info = share_audition_context_info(token, start=0.2, end=1.5, visual=True)
    dumped = json.dumps(info)
    assert "/Users/" not in dumped
    assert "workspace_dir" not in dumped
    assert info["visuals"][0]["wave_path"].startswith(
        f"/api/review/{token}/daw/audition-context-image"
    )
    assert "astats" not in info["visuals"][0]
    assert "hum" not in info["visuals"][0]
    assert share_audition_context_cached(token, start=0.2, end=1.5)
    first_renders = calls["n"]
    assert first_renders == 2
    share_audition_context_info(token, start=0.2, end=1.5, visual=True)
    assert calls["n"] == first_renders

    listed = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    )
    names = {t["name"] for t in listed["result"]["tools"]}
    assert "guest_audition_context" in names

    called = _mcp_call(token, "guest_audition_context", {"start": 0.2, "end": 1.5})
    assert "error" not in called, called
    payload = json.loads(called["result"]["content"][0]["text"])
    assert payload["visuals"][0]["wave_path"].startswith(f"/api/review/{token}/")
    assert "/Users/" not in json.dumps(payload)

    client = TestClient(create_app())
    wave_resp = client.get(
        f"/api/review/{token}/daw/audition-context-image",
        params={"start": 0.2, "end": 1.5, "track_id": "host", "kind": "wave"},
    )
    assert wave_resp.status_code == 200
    assert wave_resp.content.startswith(b"\x89PNG")

    png = share_audition_context_image(token, start=0.2, end=1.5, track_id="host", kind="wave")
    artifacts = ws.project.artifacts_dir().resolve()
    assert artifacts in png.resolve().parents
    assert png.name == "waveform_200_1500.png"
    assert calls["n"] == first_renders


def test_share_audition_context_warnings_include_hum(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    def fake_report(project, tid, **kwargs):
        return {
            "track_id": tid,
            "astats": {},
            "hum": {"hum_detected": True, "dominant_frequency": 60.0},
            "window": {"clock": "timeline", "unit": "sec", "start": 0.2, "end": 1.5},
        }

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        fake_report,
    )
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    info = share_audition_context_info(share["token"], start=0.2, end=1.5, visual=False)
    assert "hypotheses" not in info
    assert "suggested_listen" not in info
    assert any("hum_in_window" in w for w in info["warnings"])


def test_guest_audition_context_names_acoustic_candidate_without_owner_tools(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Guests get the acoustic hypothesis as a warning line only -- never the
    owner-only ``next.tools`` list (``play_pending_preview_tool``)."""
    pending = {
        "id": "acoustic-1",
        "track_id": "host",
        "reason": "filler:acoustic",
        "review_required": True,
        "timeline_start": 0.5,
        "timeline_end": 0.8,
    }
    monkeypatch.setattr(
        "podcast_mcp.edits.audition_context._edits_in_window",
        lambda *_a, **_k: {"pending": [pending], "applied": []},
    )
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])

    info = share_audition_context_info(share["token"], start=0.2, end=1.5, visual=False)

    assert any(w.startswith("acoustic_gap_filler:") for w in info["warnings"])
    assert "hypotheses" not in info
    assert "play_pending_preview_tool" not in json.dumps(info)


def test_guest_audition_context_denied_without_tool(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "mcp"])
    denied = _mcp_call(share["token"], "guest_audition_context", {"start": 0.0, "end": 1.0})
    assert denied["error"]["code"] == -32003


def test_share_audition_context_errors(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]
    _stub_ffmpeg_pngs(monkeypatch)
    client = TestClient(create_app())

    inverted = client.get(
        f"/api/review/{token}/daw/audition-context",
        params={"start": 2.0, "end": 1.0},
    )
    assert inverted.status_code == 400

    missing = client.get(
        f"/api/review/{token}/daw/audition-context-image",
        params={"start": 0.0, "end": 1.0, "track_id": "nope", "kind": "wave"},
    )
    assert missing.status_code == 404

    bad_kind = client.get(
        f"/api/review/{token}/daw/audition-context-image",
        params={"start": 0.0, "end": 1.0, "track_id": "host", "kind": "jpeg"},
    )
    assert bad_kind.status_code == 400


def test_share_audition_context_visual_false_and_errors(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]

    def boom(*_args, **_kwargs):
        raise RuntimeError("/Users/host/secret.wav: no ffmpeg")

    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_showwavespic",
        boom,
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_spectrogram",
        boom,
    )
    info = share_audition_context_info(token, start=0.0, end=1.0, visual=True)
    assert info["visuals"][0]["error"] == "diagnostics failed"
    assert "wave_path" not in info["visuals"][0]
    assert "/Users/" not in json.dumps(info)

    summary = share_audition_context_info(token, start=0.0, end=1.0, visual=False)
    assert "visuals" not in summary or not summary.get("visuals")
    dumped = json.dumps(summary)
    assert "/Users/" not in dumped


def test_share_audition_png_keys_use_milliseconds(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    _stub_ffmpeg_pngs(monkeypatch)
    png = share_audition_context_image(
        share["token"], start=0.9, end=1.1, track_id="host", kind="wave"
    )
    assert png.name == "waveform_900_1100.png"


def test_share_audition_context_image_rejects_outside_workspace(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]
    _stub_ffmpeg_pngs(monkeypatch)

    def outside(*_args, **_kwargs):
        return Path("/tmp/not-in-workspace.png")

    monkeypatch.setattr("podcast_mcp.services.share._audition_png_path", outside)
    with pytest.raises(PermissionError):
        share_audition_context_image(token, start=0.0, end=1.0, track_id="host", kind="wave")


def test_share_audition_context_image_missing_file(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_dialogue(minimal_project, sample_wav, tmp_workspace)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]

    def missing_write(self, src, dest, **kwargs):
        return dest

    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg.FFmpegEngine.render_showwavespic",
        missing_write,
    )
    with pytest.raises(FileNotFoundError):
        share_audition_context_image(token, start=0.0, end=1.0, track_id="host", kind="wave")
