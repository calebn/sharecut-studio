from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.clips_ops import set_track_clips
from podcast_mcp.edits.ripple import ripple_remove_clips
from podcast_mcp.edits.timeline_ops import punch_delete
from podcast_mcp.engines.audio_audit import _played_window
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
from podcast_mcp.services.document import EditService, HistoryService
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
        int(np.count_nonzero(_played_window(project, "guest", 0, 9))),
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

    ripple_remove_clips(project, spans, ["host", "guest"])

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

    EditService(ws).delete_clips(["last"], mode=mode)
    reloaded = load_project(ws.path)
    segment = tmp_path / "after-segment.wav"
    stem = tmp_path / "after-stem.wav"
    render_track_segment(reloaded, "guest", 0, 1, segment, {})
    render_track_from_timeline(reloaded, reloaded.tracks[0], stem, {})
    assert (_wav_count(segment), _wav_count(stem)) == (0, 0)
    assert reloaded.tracks[0].timeline_empty is True

    HistoryService(ws).undo()
    assert ws.project.tracks[0].timeline_empty is False
    assert _counts(ws.project) == (8000, 8000)


def test_empty_replacement_on_unclipped_ingest_preserves_implicit_audio(tmp_path: Path) -> None:
    project = _project(tmp_path, np.full(RATE, 0.1))
    project.clips = []
    assert _counts(project) == (8000, 8000)

    set_track_clips(project, "guest", [])
    ripple_remove_clips(project, [(2, 3)], ["guest"])

    assert _counts(project) == (8000, 8000)
    assert project.tracks[0].timeline_empty is False


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
    punch_delete(project, "guest", 1, 2, use_inaudible_opt=False)
    assert _counts(project) == (16000, 16000)
    assert project.tracks[0].timeline_empty is False
    ripple_remove_clips(project, [(2, 3)], ["guest", "peer"])
    assert _counts(project) == (8000, 8000)
    assert int(np.count_nonzero(_played_window(project, "peer", 0, 9))) == 24000
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
