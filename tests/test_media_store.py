"""Media store upload helpers and GUI upload routes."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.media_store import (
    gui_media_chunk_max_bytes,
    safe_audio_filename,
    unique_raw_path,
    write_complete_upload,
    write_upload_chunk,
)
from podcast_mcp.services.workspace import ProjectWorkspace


def test_safe_audio_filename_rejects_exe():
    with pytest.raises(ValueError, match="unsupported"):
        safe_audio_filename("evil.exe")


def test_rewrite_share_html_edge_cases():
    from podcast_mcp.services.tunnel import _rewrite_share_html

    assert _rewrite_share_html(b"", "tok") == b""
    assert _rewrite_share_html(b"<html></html>", "") == b"<html></html>"
    assert _rewrite_share_html(b"\xff\xfe", "tok") == b"\xff\xfe"
    out = _rewrite_share_html(b"<html><head></head><body></body></html>", "abc")
    assert b'<base href="/r/abc/"' in out


def test_sweep_pending_oserror_branches(minimal_project, monkeypatch, tmp_path):
    """OSError on upload entries is skipped (no global Path.stat patch — that flakes under xdist)."""
    from podcast_mcp.services import media_store as ms

    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    part = ms.uploads_dir(root) / "deadbeef02"
    part.mkdir(parents=True)
    (part / "chunk_00000").write_bytes(b"x")

    real_is_dir = Path.is_dir
    real_is_file = Path.is_file

    def boom_is_dir(self) -> bool:
        if "deadbeef02" in str(self):
            raise OSError("boom")
        return real_is_dir(self)

    def boom_is_file(self) -> bool:
        if "deadbeef02" in str(self):
            raise OSError("boom")
        return real_is_file(self)

    monkeypatch.setattr(Path, "is_dir", boom_is_dir)
    monkeypatch.setattr(Path, "is_file", boom_is_file)
    assert ms.sweep_stale_uploads(root, ttl_sec=0) == 0
    assert ms.pending_upload_bytes(root) == 0


def test_sweep_stale_uploads_and_quota(minimal_project, monkeypatch, tmp_path):
    from podcast_mcp.services.media_store import (
        pending_upload_bytes,
        sweep_stale_uploads,
        uploads_dir,
        write_upload_chunk,
    )

    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "8")
    monkeypatch.setenv("PODCAST_GUI_MEDIA_MAX_BYTES", "64")
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    assert sweep_stale_uploads(root / "missing-workspace-marker") == 0
    assert pending_upload_bytes(root / "missing-workspace-marker") == 0

    part = uploads_dir(root) / "deadbeef01"
    part.mkdir(parents=True)
    (part / "chunk_00000").write_bytes(b"x" * 4)
    # Non-dir sibling should be skipped by the sweep.
    (uploads_dir(root) / "not-a-dir.txt").write_text("x", encoding="utf-8")
    # Force mtime into the past
    old = time.time() - 7200
    os.utime(part, (old, old))
    assert sweep_stale_uploads(root, ttl_sec=3600) == 1
    assert not part.exists()

    monkeypatch.setattr(
        "podcast_mcp.services.media_store._PENDING_UPLOAD_QUOTA",
        10,
    )
    write_upload_chunk(
        root,
        filename="a.wav",
        data=b"a" * 4,
        upload_id="abcd1234",
        chunk_index=0,
        total_chunks=2,
    )
    assert pending_upload_bytes(root) >= 4
    with pytest.raises(ValueError, match="quota"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"b" * 8,
            upload_id="abcd1234",
            chunk_index=1,
            total_chunks=2,
        )


def test_write_complete_and_chunked(minimal_project, sample_wav, tmp_path):
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    data = sample_wav.read_bytes()
    out = write_complete_upload(root, filename="host.wav", data=data)
    assert out["rel_path"].startswith("raw/")
    assert (root / out["rel_path"]).is_file()
    assert out["duration_sec"] > 0

    mid = len(data) // 2
    a = write_upload_chunk(
        root,
        filename="guest.wav",
        data=data[:mid],
        upload_id=None,
        chunk_index=0,
        total_chunks=2,
    )
    assert a["complete"] is False
    uid = str(a["upload_id"])
    b = write_upload_chunk(
        root,
        filename="guest.wav",
        data=data[mid:],
        upload_id=uid,
        chunk_index=1,
        total_chunks=2,
    )
    assert b["complete"] is True
    assert (root / b["rel_path"]).is_file()


def test_chunk_rejects_duplicate_index(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    data = sample_wav.read_bytes()
    mid = len(data) // 2
    a = write_upload_chunk(
        root,
        filename="dup.wav",
        data=data[:mid],
        upload_id=None,
        chunk_index=0,
        total_chunks=2,
    )
    uid = str(a["upload_id"])
    with pytest.raises(ValueError, match="duplicate"):
        write_upload_chunk(
            root,
            filename="dup.wav",
            data=data[:mid],
            upload_id=uid,
            chunk_index=0,
            total_chunks=2,
        )


def test_chunk_assemble_streams_via_from_parts(minimal_project, sample_wav, monkeypatch):
    """Multi-chunk complete path must stream parts (not b"".join into RAM)."""
    from podcast_mcp.services import media_store as ms

    calls: list[int] = []
    real = ms.write_complete_upload_from_parts

    def spy(workspace_dir, *, filename, part_paths):
        calls.append(len(part_paths))
        return real(workspace_dir, filename=filename, part_paths=part_paths)

    monkeypatch.setattr(ms, "write_complete_upload_from_parts", spy)
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    data = sample_wav.read_bytes()
    mid = max(1, len(data) // 2)
    first = write_upload_chunk(
        root,
        filename="stream.wav",
        data=data[:mid],
        upload_id=None,
        chunk_index=0,
        total_chunks=2,
    )
    out = write_upload_chunk(
        root,
        filename="stream.wav",
        data=data[mid:],
        upload_id=str(first["upload_id"]),
        chunk_index=1,
        total_chunks=2,
    )
    assert out["complete"] is True
    assert calls == [2]
    assert (root / out["rel_path"]).is_file()


def test_chunk_rejects_assembled_oversize(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_MAX_BYTES", "40")
    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "24")
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    first = write_upload_chunk(
        root,
        filename="big.wav",
        data=b"a" * 24,
        upload_id=None,
        chunk_index=0,
        total_chunks=2,
    )
    uid = str(first["upload_id"])
    with pytest.raises(ValueError, match="exceeds"):
        write_upload_chunk(
            root,
            filename="big.wav",
            data=b"b" * 24,
            upload_id=uid,
            chunk_index=1,
            total_chunks=2,
        )


def test_host_media_upload_route(minimal_project, sample_wav):
    client = TestClient(create_app(served_project=None))
    data = sample_wav.read_bytes()
    res = client.post(
        f"/api/media/upload?path={minimal_project}&filename=import.wav",
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["complete"] is True
    assert body["rel_path"].startswith("raw/")


def test_host_media_upload_rejects_bad_ext(minimal_project):
    client = TestClient(create_app(served_project=None))
    res = client.post(
        f"/api/media/upload?path={minimal_project}&filename=nope.txt",
        content=b"not audio",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 400


def test_host_media_upload_413_chunk(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "16")
    # Reloading env helper reads at call time
    assert gui_media_chunk_max_bytes() == 16
    client = TestClient(create_app(served_project=None))
    res = client.post(
        f"/api/media/upload?path={minimal_project}&filename=a.wav&chunk_index=0&total_chunks=2",
        content=b"x" * 32,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 413


def _guest_share_client(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from pathlib import Path

    from podcast_mcp.models import load_project, save_project
    from podcast_mcp.services.review import ReviewService
    from podcast_mcp.services.share import ShareService

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="Upload")
    view_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "mcp"],
    )["token"]
    edit_tok = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "edit", "mcp"],
    )["token"]
    return TestClient(create_app()), view_tok, edit_tok


def test_guest_media_upload_requires_edit(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    client, view_tok, edit_tok = _guest_share_client(
        minimal_project, sample_wav, tmp_workspace, monkeypatch
    )
    data = sample_wav.read_bytes()
    denied = client.post(
        f"/api/review/{view_tok}/daw/media/upload?filename=g.wav",
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert denied.status_code == 403
    ok = client.post(
        f"/api/review/{edit_tok}/daw/media/upload?filename=g.wav",
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["complete"] is True
    assert ok.json()["rel_path"].startswith("raw/")


def test_guest_upload_media_mcp_requires_edit(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import base64

    from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    _client, view_tok, edit_tok = _guest_share_client(
        minimal_project, sample_wav, tmp_workspace, monkeypatch
    )
    payload = {
        "filename": "g.wav",
        "data_base64": base64.b64encode(sample_wav.read_bytes()).decode("ascii"),
    }

    def _call(token: str, arguments: dict, req_id: int = 1):
        return handle_mcp_jsonrpc(
            token,
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "tools/call",
                "params": {"name": "guest_upload_media", "arguments": arguments},
            },
        )

    denied = _call(view_tok, payload)
    assert denied["error"]["code"] == -32003

    ok = _call(edit_tok, payload, req_id=2)
    assert "error" not in ok, ok
    body = json.loads(ok["result"]["content"][0]["text"])
    assert body["complete"] is True
    assert body["rel_path"].startswith("raw/")
    dumped = json.dumps(body)
    assert "/Users/" not in dumped

    bad_b64 = _call(edit_tok, {"filename": "g.wav", "data_base64": "not-base64!!"}, req_id=3)
    assert "error" in bad_b64


def test_unique_raw_path_increments_on_collision(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    first = unique_raw_path(root, "take.wav")
    first.write_bytes(sample_wav.read_bytes())
    second = unique_raw_path(root, "take.wav")
    second.write_bytes(sample_wav.read_bytes())
    third = unique_raw_path(root, "take.wav")
    assert second.name == "take_2.wav"
    assert third.name == "take_3.wav"


def test_write_complete_rejects_empty_and_oversize(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_MAX_BYTES", "8")
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    with pytest.raises(ValueError, match="empty"):
        write_complete_upload(root, filename="a.wav", data=b"")
    with pytest.raises(ValueError, match="exceeds"):
        write_complete_upload(root, filename="a.wav", data=b"x" * 16)


def test_write_complete_rejects_unreadable_audio(minimal_project):
    import subprocess

    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    with pytest.raises(subprocess.CalledProcessError):
        write_complete_upload(root, filename="bad.wav", data=b"not a wav")
    raw = root / "raw"
    if raw.is_dir():
        assert list(raw.glob("bad*.wav")) == []


def test_write_complete_rejects_zero_duration(minimal_project, sample_wav, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(
        "podcast_mcp.services.media_store.FFmpegEngine.probe",
        lambda self, path, untrusted=False: SimpleNamespace(duration_sec=0),
    )
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    with pytest.raises(ValueError, match="zero duration"):
        write_complete_upload(root, filename="silent.wav", data=sample_wav.read_bytes())


def test_write_upload_chunk_rejects_invalid_args(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "4")
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    with pytest.raises(ValueError, match="chunk exceeds"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"xxxxx",
            upload_id=None,
            chunk_index=0,
            total_chunks=2,
        )
    with pytest.raises(ValueError, match="total_chunks"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"x",
            upload_id=None,
            chunk_index=0,
            total_chunks=0,
        )
    with pytest.raises(ValueError, match="exceeds max"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"x",
            upload_id=None,
            chunk_index=0,
            total_chunks=10_000,
        )
    with pytest.raises(ValueError, match="chunk_index"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"x",
            upload_id=None,
            chunk_index=2,
            total_chunks=2,
        )
    with pytest.raises(ValueError, match="invalid upload_id"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"x",
            upload_id="!!!",
            chunk_index=0,
            total_chunks=2,
        )


def test_write_upload_chunk_rejects_total_mismatch(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "64")
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    first = write_upload_chunk(
        root,
        filename="a.wav",
        data=b"a" * 8,
        upload_id=None,
        chunk_index=0,
        total_chunks=2,
    )
    uid = str(first["upload_id"])
    with pytest.raises(ValueError, match="total_chunks mismatch"):
        write_upload_chunk(
            root,
            filename="a.wav",
            data=b"b" * 8,
            upload_id=uid,
            chunk_index=1,
            total_chunks=3,
        )


def test_host_media_upload_maps_probe_errors(minimal_project, monkeypatch):
    client = TestClient(create_app(served_project=None))

    def boom(*_args, **_kwargs):
        raise RuntimeError("ffprobe exploded")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.media.write_upload_chunk",
        boom,
    )
    res = client.post(
        f"/api/media/upload?path={minimal_project}&filename=a.wav",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 400
    assert "invalid audio" in res.json()["detail"]


def test_guest_media_upload_413_and_400(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "16")
    client, _view, edit_tok = _guest_share_client(
        minimal_project, sample_wav, tmp_workspace, monkeypatch
    )
    too_big = client.post(
        f"/api/review/{edit_tok}/daw/media/upload?filename=a.wav",
        content=b"x" * 32,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert too_big.status_code == 413
    bad = client.post(
        f"/api/review/{edit_tok}/daw/media/upload?filename=nope.txt",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert bad.status_code == 400


def test_guest_media_upload_maps_probe_errors(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    client, _view, edit_tok = _guest_share_client(
        minimal_project, sample_wav, tmp_workspace, monkeypatch
    )

    def boom(*_args, **_kwargs):
        raise RuntimeError("ffprobe exploded")

    monkeypatch.setattr(
        "podcast_mcp.services.media_store.write_upload_chunk",
        boom,
    )
    res = client.post(
        f"/api/review/{edit_tok}/daw/media/upload?filename=a.wav",
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 400
    assert "invalid audio" in res.json()["detail"]
