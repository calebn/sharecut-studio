from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.ripple import ripple_remove_clips
from podcast_mcp.edits.timeline_ops import _write_punch_delete
from podcast_mcp.engines.audio_audit import _played_window
from podcast_mcp.engines.clips_ops import set_track_clips
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.engines.ungated_audio import raw_timeline_samples, raw_timeline_window
from podcast_mcp.models import (
    Clip,
    EditMode,
    EpisodeProject,
    MediaAsset,
    Track,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    HistoryService,
    PlayRequest,
    PlayService,
    TimelineService,
)
from podcast_mcp.util.timebase import SourceSec

RATE = 8000


def _project(directory: Path, signal: np.ndarray) -> EpisodeProject:
    project = EpisodeProject.create("empty-lane", str(directory))
    project.ensure_dirs()
    path = directory / "raw" / "guest.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(signal.shape[1] if signal.ndim == 2 else 1)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes((signal * 32767).astype("<i2").tobytes())
    duration = len(signal) / RATE
    project.tracks = [
        Track(
            id="guest", label="Guest", media=MediaAsset(path="raw/guest.wav", duration_sec=duration)
        )
    ]
    project.clips = [
        Clip(id="last", track_id="guest", source_start=0, source_end=duration, timeline_start=0)
    ]
    project.timeline.duration_sec = duration
    return project


def _counts(project: EpisodeProject) -> tuple[int, int]:
    return (
        int(np.count_nonzero(_played_window(project, "guest", 0, 9, defaults=load_defaults()))),
        int(np.count_nonzero(raw_timeline_samples(project, "guest", sample_rate=RATE))),
    )


def _wav_count(path: Path) -> int:
    with wave.open(str(path), "rb") as audio:
        return int(
            np.count_nonzero(np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2"))
        )


def test_ripple_final_placement_removal_silences_played_and_raw_samples(tmp_path: Path) -> None:
    signal = np.zeros(8 * RATE)
    signal[63199] = 0.045
    project = _project(tmp_path, signal)
    project.tracks.append(Track(id="host", label="Host", media=project.tracks[0].media))
    project.clips = [
        Clip(id="host1", track_id="host", source_start=0, source_end=7.9, timeline_start=0.7001),
        Clip(
            id="guest1",
            track_id="guest",
            source_start=0.00003,
            source_end=7.9,
            timeline_start=0.7001 + 0.00003,
        ),
    ]
    project.timeline.duration_sec = 8.7001
    spans = tuple(
        (float(start), float(end))
        for start, end in SessionTimeline(project).map_source_span(
            "host", SourceSec(0.00003), SourceSec(7.8999999995)
        )
    )
    assert _counts(project) == (1, 1)

    ripple_remove_clips(project, spans, ["host", "guest"], defaults=load_defaults())

    assert [clip.id for clip in project.clips if clip.track_id == "guest"] == []
    assert _counts(project) == (0, 0)


@pytest.mark.parametrize("mode", [EditMode.GAP, EditMode.RIPPLE])
def test_public_final_delete_reload_renders_silence_and_undo_restores_audio(
    tmp_path: Path, mode: EditMode
) -> None:
    project = _project(tmp_path, np.full(RATE, 0.1))
    ws = ProjectWorkspace.open(save_project(project))
    before_segment = tmp_path / "before-segment.wav"
    before_stem = tmp_path / "before-stem.wav"
    render_track_segment(ws.project, "guest", 0, 1, before_segment, {})
    render_track_from_timeline(ws.project, ws.project.tracks[0], before_stem, {})
    assert (_wav_count(before_segment), _wav_count(before_stem)) == (8000, 8000)

    TimelineService(ws).delete_clips(["last"], mode=mode)
    reloaded = load_project(ws.path)
    segment = tmp_path / "after-segment.wav"
    stem = tmp_path / "after-stem.wav"
    render_track_segment(reloaded, "guest", 0, 1, segment, {})
    render_track_from_timeline(reloaded, reloaded.tracks[0], stem, {})
    assert (_wav_count(segment), _wav_count(stem)) == (0, 0)
    assert reloaded.tracks[0].timeline_empty is True
    processed = PlayService(ws).play(
        PlayRequest(source="processed:guest", start_sec=0, end_sec=1), dry_run=True
    )
    raw = PlayService(ws).play(
        PlayRequest(source="track:guest", start_sec=0, end_sec=1), dry_run=True
    )
    assert (_wav_count(processed.wav_path), _wav_count(raw.wav_path)) == (0, 8000)

    HistoryService(ws).undo()
    assert ws.project.tracks[0].timeline_empty is False
    assert _counts(ws.project) == (8000, 8000)
    HistoryService(ws).redo()
    assert ws.project.tracks[0].timeline_empty is True
    assert _counts(ws.project) == (0, 0)


def test_empty_replacement_on_unclipped_ingest_preserves_implicit_audio(tmp_path: Path) -> None:
    project = _project(tmp_path, np.full(RATE, 0.1))
    project.clips = []
    assert _counts(project) == (8000, 8000)

    set_track_clips(project, "guest", [])
    ripple_remove_clips(project, [(2, 3)], ["guest"], defaults=load_defaults())

    assert _counts(project) == (8000, 8000)
    assert project.tracks[0].timeline_empty is False


def test_empty_lane_keeps_shared_source_cache_and_placed_peer_audible(tmp_path: Path) -> None:
    project = _project(tmp_path, np.full((RATE, 2), 0.1))
    project.tracks.append(Track(id="peer", label="Peer", media=project.tracks[0].media))
    project.clips.append(
        Clip(id="peer", track_id="peer", source_start=0, source_end=1, timeline_start=0)
    )
    sources: dict[Path, np.ndarray] = {}
    before = raw_timeline_samples(
        project, "peer", sample_rate=RATE, preserve_channels=True, sources=sources
    )
    cached = sources[(tmp_path / "raw" / "guest.wav").resolve()]
    set_track_clips(project, "guest", [])
    set_track_clips(project, "guest", [])

    empty = raw_timeline_samples(
        project, "guest", sample_rate=RATE, preserve_channels=True, sources=sources
    )
    assert empty.shape == (8000, 2)
    assert empty.dtype == cached.dtype == np.float32
    assert int(np.count_nonzero(empty)) == 0
    assert not np.shares_memory(empty, cached)
    assert int(np.count_nonzero(cached)) == 16000
    after = raw_timeline_samples(
        project, "peer", sample_rate=RATE, preserve_channels=True, sources=sources
    )
    np.testing.assert_array_equal(after, before)
    assert int(np.count_nonzero(after)) == 16000
    assert project.tracks[0].timeline_empty is True


def test_raw_readers_prioritize_placements_over_stale_empty_flag(tmp_path: Path) -> None:
    project = _project(tmp_path, np.full((RATE, 2), 0.1))
    project.tracks[0].timeline_empty = True

    full = raw_timeline_samples(project, "guest", sample_rate=RATE, preserve_channels=True)
    window = raw_timeline_window(
        project, "guest", 0.25, 0.75, sample_rate=RATE, preserve_channels=True
    )

    assert full.shape == (8000, 2)
    assert window.shape == (4000, 2)
    assert (int(np.count_nonzero(full)), int(np.count_nonzero(window))) == (16000, 8000)


def test_empty_raw_readers_preserve_missing_media_errors(tmp_path: Path) -> None:
    project = _project(tmp_path, np.full((RATE, 2), 0.1))
    set_track_clips(project, "guest", [])
    project.tracks[0].media.path = "raw/missing.wav"

    with pytest.raises(ValueError, match="could not be probed"):
        raw_timeline_samples(project, "guest", sample_rate=RATE, preserve_channels=True)
    with pytest.raises(FileNotFoundError):
        raw_timeline_window(project, "guest", 0.25, 0.75, sample_rate=RATE, preserve_channels=True)


@pytest.mark.parametrize("channels", [1, 2])
def test_raw_readers_honor_saved_empty_lane_with_duration_and_channel_layout(
    tmp_path: Path, channels: int
) -> None:
    project = _project(tmp_path, np.full((RATE, channels), 0.1))
    project.clips = []
    full = raw_timeline_samples(project, "guest", sample_rate=RATE, preserve_channels=True)
    window = raw_timeline_window(
        project, "guest", 0.25, 0.75, sample_rate=RATE, preserve_channels=True
    )
    assert full.shape == (8000, channels)
    assert window.shape == (4000, channels)
    assert (int(np.count_nonzero(full)), int(np.count_nonzero(window))) == (
        8000 * channels,
        4000 * channels,
    )

    project.tracks[0].timeline_empty = True
    reloaded = load_project(save_project(project))
    full = raw_timeline_samples(reloaded, "guest", sample_rate=RATE, preserve_channels=True)
    window = raw_timeline_window(
        reloaded, "guest", 0.25, 0.75, sample_rate=RATE, preserve_channels=True
    )
    assert full.shape == (8000, channels)
    assert window.shape == (4000, channels)
    assert (int(np.count_nonzero(full)), int(np.count_nonzero(window))) == (0, 0)
    mono = raw_timeline_window(reloaded, "guest", 0.25, 0.75, sample_rate=RATE)
    assert mono.shape == (4000,)
    assert int(np.count_nonzero(mono)) == 0


def test_partial_suffix_and_unaffected_lanes_keep_audio_then_readding_restores(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, np.full(3 * RATE, 0.1))
    project.tracks.append(Track(id="peer", label="Peer", media=project.tracks[0].media))
    project.clips.append(
        Clip(id="peer", track_id="peer", source_start=0, source_end=3, timeline_start=5)
    )
    _write_punch_delete(
        project,
        "guest",
        1,
        2,
        defaults=load_defaults(),
    )
    assert _counts(project) == (16000, 16000)
    assert project.tracks[0].timeline_empty is False
    ripple_remove_clips(project, [(2, 3)], ["guest", "peer"], defaults=load_defaults())
    assert _counts(project) == (8000, 8000)
    assert (
        int(np.count_nonzero(_played_window(project, "peer", 0, 9, defaults=load_defaults())))
        == 24000
    )
    assert [
        (c.source_start, c.source_end, c.timeline_start)
        for c in project.clips
        if c.track_id == "peer"
    ] == [(0, 3, 4)]

    set_track_clips(project, "guest", [])
    assert _counts(project) == (0, 0)
    assert project.tracks[0].timeline_empty is True
    set_track_clips(
        project,
        "guest",
        [Clip(id="restored", track_id="guest", source_start=0, source_end=1, timeline_start=0)],
    )
    assert project.tracks[0].timeline_empty is False
    assert _counts(project) == (8000, 8000)
