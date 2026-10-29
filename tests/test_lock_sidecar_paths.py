"""Pin the on-disk names of every lock sidecar and where its path is built."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.project_state import (
    asr_cache_lock_path,
    play_cache_lock_path,
    project_commit_lock_path,
    prosody_lock_path,
    record_land_lock_path,
    render_lock_path,
    transcript_context_lock_path,
    waveform_lock_path,
)


def _project(tmp_path: Path) -> EpisodeProject:
    return EpisodeProject.create("lock_paths", str(tmp_path))


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def test_lock_sidecars_keep_their_names_on_disk(tmp_path: Path) -> None:
    project = _project(tmp_path)
    root = project.workspace_path().resolve()
    artifacts = root / "artifacts"

    assert _rel(project_commit_lock_path(project), root) == "artifacts/episode.sharecut.lock"
    assert _rel(render_lock_path(project), root) == "artifacts/render.lock"
    assert (
        _rel(transcript_context_lock_path(root), root) == "artifacts/transcript_context.yaml.lock"
    )
    assert (
        _rel(asr_cache_lock_path(project, "host_0123456789abcdef"), root)
        == "artifacts/transcript-cache-host_0123456789abcdef.lock"
    )
    assert _rel(waveform_lock_path(artifacts / "peaks"), root) == "artifacts/peaks/.waveform.lock"
    assert (
        _rel(play_cache_lock_path(artifacts / "play_cache"), root)
        == "artifacts/play_cache/.cache.lock"
    )
    assert _rel(record_land_lock_path(root, "room1"), root) == "artifacts/record/land-room1.lock"
    assert (
        _rel(prosody_lock_path(project.transcripts_dir() / "prosody", "host"), root)
        == _rel(project.transcripts_dir(), root) + "/prosody/host.lock"
    )


def test_prosody_edit_layer_locks_the_same_file(tmp_path: Path) -> None:
    from podcast_mcp.edits import prosody_profile

    project = _project(tmp_path)
    expected = prosody_lock_path(prosody_profile.prosody_dir(project), "host")
    assert prosody_profile._lock_path(project, "host") == expected.resolve()
