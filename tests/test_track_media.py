"""Unit tests for edits.track_media helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.track_media import (
    apply_full_span_media,
    ensure_audio_in_workspace,
    media_asset_from_path,
    resolve_workspace_raw_audio,
)
from podcast_mcp.models import Track, TrackRole, load_project
from podcast_mcp.services.workspace import ProjectWorkspace


def test_media_asset_from_path(sample_wav):
    media = media_asset_from_path(sample_wav, store_path="raw/host.wav")
    assert media.path == "raw/host.wav"
    assert media.duration_sec is not None and media.duration_sec > 0
    assert media.sample_rate
    assert media.channels


def test_apply_full_span_media_and_store_path(minimal_project, sample_wav, tmp_path):
    ws = ProjectWorkspace.open(minimal_project)
    project = ws.project
    track = Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    project.tracks = [track]
    audio, store = ensure_audio_in_workspace(project.workspace_path(), sample_wav)
    apply_full_span_media(project, track, store_path=store, audio_path=audio)
    assert track.media is not None
    assert track.media.path == store
    assert not Path(store).is_absolute()
    clips = [c for c in project.clips if c.track_id == "host"]
    assert len(clips) == 1
    assert clips[0].source_end == track.media.duration_sec
    assert project.timeline.duration_sec == clips[0].timeline_end

    # Relative when under workspace
    raw = project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "copy.wav"
    dest.write_bytes(sample_wav.read_bytes())
    copied, rel = ensure_audio_in_workspace(project.workspace_path(), dest)
    assert rel == "raw/copy.wav"
    assert copied == dest.resolve()
    with pytest.raises(FileNotFoundError, match="audio file not found"):
        ensure_audio_in_workspace(project.workspace_path(), tmp_path / "missing.wav")

    # Reload still has clip after save via workspace
    ws.save()
    again = load_project(minimal_project)
    assert again.track_by_id("host") is not None
    # Saved JSON uses portable workspace_dir
    raw_json = Path(minimal_project).read_text(encoding="utf-8")
    assert '"workspace_dir": "."' in raw_json


def test_resolve_workspace_raw_audio_rejects_escape(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    raw = root / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "ok.wav"
    dest.write_bytes(sample_wav.read_bytes())
    assert resolve_workspace_raw_audio(root, "raw/ok.wav") == dest.resolve()
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, str(sample_wav))
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, "../secrets.wav")
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, "raw/../episode.project.json")
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, "")
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, "clips/ok.wav")


def test_resolve_workspace_raw_audio_rejects_symlink_escape(minimal_project, sample_wav, tmp_path):
    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    raw = root / "raw"
    raw.mkdir(exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.wav"
    secret.write_bytes(sample_wav.read_bytes())
    (raw / "link").symlink_to(outside)
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(root, "raw/link/secret.wav")


def test_resolve_workspace_raw_audio_rejects_symlinked_raw_root(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (workspace / "raw").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="raw/"):
        resolve_workspace_raw_audio(workspace, "raw/guest.wav")
