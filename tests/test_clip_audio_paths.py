from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import lane_window, timeline_render
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.engines.lane_window import lane_clip_placements
from podcast_mcp.engines.timeline_render import (
    ClipAudioPaths,
    placed_track_audio,
    resolve_clip_audio_path,
    track_grid,
)
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EpisodeProject,
    MediaAsset,
    RoomToneFill,
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
    assert paths(project.clips[1]) == gone.resolve()
    gone.unlink()
    assert paths(project.clips[4]) == gone.resolve()
    with pytest.raises(FileNotFoundError, match="c7"):
        ClipAudioPaths(project, track)(project.clips[7])
    gone.write_bytes(saved)
    fresh = ClipAudioPaths(project, track)
    assert fresh(project.clips[7]) == gone.resolve()


def test_lane_walks_resolve_each_source_once(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    seen = _spy(monkeypatch)
    lane_clip_placements(project, track)
    assert len(seen) == len(SOURCE_IDS)
    seen.clear()
    grid = track_grid(project, track, project.clips)
    assert len(seen) == len(SOURCE_IDS)
    seen.clear()
    placed_track_audio(project, track, project.clips, grid=grid)
    assert len(seen) == len(SOURCE_IDS)


def test_rms_caches_resolve_each_source_once(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    seen = _spy(monkeypatch)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    assert track.id in caches.caches
    assert len(seen) == len(SOURCE_IDS)


def _walk(project: EpisodeProject, track: Track) -> tuple[object, ...]:
    out: list[object] = [lane_clip_placements(project, track)]
    for window in (None, (1.2, 3.1)):
        grid = track_grid(project, track, project.clips, window=window)
        assert grid is not None
        placed = placed_track_audio(project, track, project.clips, grid=grid, window=window)
        out.append((placed.audio, placed.extent, placed.bodies))
    return tuple(out)


def _use_cold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(timeline_render, "ClipAudioPaths", ColdPaths)
    monkeypatch.setattr(lane_window, "ClipAudioPaths", ColdPaths)


def test_lane_walks_match_the_cold_resolver(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    project.clips[4] = project.clips[4].model_copy(
        update={
            "mute_regions": [
                ClipMuteRegion(
                    start_s=0.1,
                    end_s=0.2,
                    fill=RoomToneFill(start_s=0.0, end_s=0.1, source_id="g2"),
                )
            ]
        }
    )
    warm = _walk(project, track)
    _use_cold(monkeypatch)
    assert _walk(project, track) == warm


def _raised(project: EpisodeProject, track: Track) -> str:
    with pytest.raises((OSError, ValueError)) as caught:
        track_grid(project, track, project.clips)
    return f"{type(caught.value).__name__}: {caught.value}"


def test_walk_errors_match_the_cold_resolver(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track = _project(tmp_path / "ws", sample_wav)
    project.clips[5] = project.clips[5].model_copy(update={"source_id": "nope"})
    project.clips[9] = project.clips[9].model_copy(update={"source_id": "nope"})
    warm = _raised(project, track)
    assert "c5" in warm
    _use_cold(monkeypatch)
    assert _raised(project, track) == warm

    bare = track.model_copy(update={"media": None})
    project.clips[5] = project.clips[5].model_copy(update={"source_id": None})
    monkeypatch.undo()
    warm = _raised(project, bare)
    assert "no media" in warm
    _use_cold(monkeypatch)
    assert _raised(project, bare) == warm
