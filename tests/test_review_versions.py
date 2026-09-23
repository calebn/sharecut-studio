"""Review mix version publish / play / comment stamp."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.review_versions import publish_version, version_audio_path
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import PlayService, ProjectWorkspace, ReviewService
from podcast_mcp.util.binaries import resolve_ffmpeg


@pytest.mark.parametrize("source", ["premix", "mastered"])
def test_publish_version_and_stamp_comment(minimal_project, sample_wav, tmp_workspace, source):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / f"{source}.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)

    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="v1 for guests", prefer=source)
    assert ver["label"] == "v1 for guests"
    assert ver["source"] == source
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [ver]
    assert persisted.review.active_version_id == ver["id"]

    audio = Path(persisted.workspace_dir) / ver["audio_relpath"]
    assert audio.is_file()
    wav_bytes = audio.read_bytes()
    assert wav_bytes == sample_wav.read_bytes()
    assert hashlib.sha256(wav_bytes).hexdigest() == ver["sha256"]

    assert ver.get("mp3_relpath")
    mp3 = Path(persisted.workspace_dir) / ver["mp3_relpath"]
    assert mp3.is_file()
    assert mp3.stat().st_size > 0
    subprocess.run(
        [resolve_ffmpeg(), "-nostdin", "-v", "error", "-xerror", "-i", str(mp3), "-f", "null", "-"],
        check=True,
        capture_output=True,
        timeout=15,
    )

    c = add_comment(ws.project, body="On this mix", author="guest", timeline_start=1.0)
    assert c.review_version_id == ver["id"]

    transport = PlayService(ws).resolve_transport_path("review", track_id=ver["id"])
    assert transport.path == audio.resolve()
    assert transport.tier == "review"

    transport2 = PlayService(ws).resolve_transport_path(f"review:{ver['id']}")
    assert transport2.path == audio.resolve()


def test_publish_requires_mix(minimal_project):
    proj = load_project(minimal_project)
    with pytest.raises(FileNotFoundError):
        publish_version(proj, label="x")


def test_list_and_set_active(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = ReviewService(ws)
    a = svc.publish(label="A")
    b = svc.publish(label="B", set_active=False)
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [a, b]
    assert persisted.review.active_version_id == a["id"]

    rows = svc.list_versions()
    assert len(rows) == 2
    assert any(r["id"] == a["id"] and r["active"] for r in rows)
    svc.set_active(b["id"])
    assert ws.project.review.active_version_id == b["id"]
    persisted = load_project(minimal_project)
    assert [version.model_dump() for version in persisted.review.versions] == [a, b]
    assert persisted.review.active_version_id == b["id"]
    path = version_audio_path(persisted, b["id"])
    assert path.is_file()
