from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines import lane_window, timeline_render
from podcast_mcp.engines.lane_window import lane_clip_placements
from podcast_mcp.engines.timeline_render import (
    ClipAudioPaths,
    placed_track_audio,
    resolve_clip_audio_path,
    track_grid,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
)

SOURCE_IDS = (None, "g1", "g2")


class ColdPaths:
    """Frozen oracle: the per-clip resolver with nothing remembered."""

    def __init__(self, project: EpisodeProject, track: Track) -> None:
        self._project = project
        self._track = track

    def __call__(self, clip: Clip) -> Path:
        return resolve_clip_audio_path(self._project, self._track, clip)


def _project(ws: Path, wav: Path, *, clips: int = 12) -> tuple[EpisodeProject, Track]:
    raw = ws / "raw"
    raw.mkdir(parents=True)
    for name in ("host", "g1", "g2"):
        (raw / f"{name}.wav").write_bytes(wav.read_bytes())
    project = EpisodeProject.create("paths", str(ws))
    project.sources = [
        SourceRecording(id=sid, path=f"raw/{sid}.wav", duration_sec=1.0) for sid in ("g1", "g2")
    ]
    track = Track(
        id="host",
        label="Host",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
    )
    project.timeline.tracks.append(track)
    for index in range(clips):
        project.clips.append(
            Clip(
                id=f"c{index}",
                track_id="host",
                source_start=0.0,
                source_end=0.4,
                timeline_start=index * 0.5,
                source_id=SOURCE_IDS[index % len(SOURCE_IDS)],
            )
        )
    return project, track


def _spy(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    seen: list[str] = []
    real = timeline_render.resolve_clip_audio_path

    def spy(project: EpisodeProject, track: Track, clip: Clip) -> Path:
        seen.append(clip.id)
        return real(project, track, clip)

    monkeypatch.setattr(timeline_render, "resolve_clip_audio_path", spy)
    return seen


def test_memo_returns_the_cold_path_for_every_clip(tmp_path: Path, sample_wav: Path) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    paths = ClipAudioPaths(project, track)
    for clip in project.clips:
        assert paths(clip) == resolve_clip_audio_path(project, track, clip)
    assert paths(project.clips[0]) is paths(project.clips[3])


def test_memo_resolves_each_source_once(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    seen = _spy(monkeypatch)
    paths = ClipAudioPaths(project, track)
    for clip in project.clips * 2:
        paths(clip)
    assert len(seen) == len(SOURCE_IDS)


def test_a_new_memo_sees_edited_sources_and_other_projects(
    tmp_path: Path, sample_wav: Path
) -> None:
    project, track = _project(tmp_path / "a", sample_wav)
    clip = project.clips[1]
    first = ClipAudioPaths(project, track)(clip)
    project.sources[0] = SourceRecording(id="g1", path="raw/g2.wav", duration_sec=1.0)
    assert ClipAudioPaths(project, track)(clip) == project.workspace_path() / "raw" / "g2.wav"
    assert ClipAudioPaths(project, track)(clip) != first
    other, other_track = _project(tmp_path / "b", sample_wav)
    assert ClipAudioPaths(other, other_track)(other.clips[1]) != first


def test_a_failure_is_not_remembered(tmp_path: Path, sample_wav: Path) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    ghost = project.clips[1].model_copy(update={"id": "ghost", "source_id": "nope"})
    paths = ClipAudioPaths(project, track)
    for _ in range(2):
        with pytest.raises(ValueError, match="ghost"):
            paths(ghost)
    gone = project.workspace_path() / "raw" / "g1.wav"
    saved = gone.read_bytes()
    gone.unlink()
    with pytest.raises(FileNotFoundError, match="c1"):
        paths(project.clips[1])
    with pytest.raises(FileNotFoundError, match="c4"):
        paths(project.clips[4])
    gone.write_bytes(saved)
    assert paths(project.clips[1]) == gone.resolve()


def test_lane_walks_resolve_each_source_once(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    seen = _spy(monkeypatch)
    lane_clip_placements(project, track)
    assert len(seen) <= len(SOURCE_IDS)
    seen.clear()
    grid = track_grid(project, track, project.clips)
    assert len(seen) <= len(SOURCE_IDS)
    seen.clear()
    placed_track_audio(project, track, project.clips, grid=grid)
    assert len(seen) <= len(SOURCE_IDS)


def test_lane_walks_match_the_cold_resolver(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)

    def walk() -> tuple[object, object]:
        grid = track_grid(project, track, project.clips)
        assert grid is not None
        placed = placed_track_audio(project, track, project.clips, grid=grid)
        return lane_clip_placements(project, track), placed.audio

    warm = walk()
    monkeypatch.setattr(timeline_render, "ClipAudioPaths", ColdPaths)
    monkeypatch.setattr(lane_window, "ClipAudioPaths", ColdPaths)
    assert walk() == warm
