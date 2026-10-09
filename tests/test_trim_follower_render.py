from __future__ import annotations

import struct
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from contract_project_helpers import contract_project
from podcast_mcp.edits.clips_ops import update_timeline_duration
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.session_timeline import same_source_timeline_overlaps
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EditMode,
    EpisodeProject,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context


def _write_mono_pcm_wav(path: Path, audio: bytes) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48_000)
        output.writeframes(audio)


def _trimmed_nested_project(tmp_path: Path) -> EpisodeProject:
    project = contract_project(
        [{"id": "host", "role": "dialogue", "media_path": "raw/host.wav", "duration_sec": 60}],
        clips=[
            Clip(
                id="anchor",
                track_id="host",
                timeline_start=5,
                source_start=0,
                source_end=6,
                fade_in_ms=0,
                fade_out_ms=0,
                join_in_mode=ClipJoinMode.CUT,
                mute_regions=[ClipMuteRegion(start_s=0, end_s=6)],
            ),
            Clip(
                id="follower",
                track_id="host",
                timeline_start=2,
                source_start=20,
                source_end=40,
                fade_in_ms=0,
                fade_out_ms=0,
                join_in_mode=ClipJoinMode.CUT,
            ),
            Clip(
                id="later",
                track_id="host",
                timeline_start=26,
                source_start=40,
                source_end=50,
                fade_in_ms=0,
                fade_out_ms=0,
                join_in_mode=ClipJoinMode.CUT,
            ),
        ],
    )
    project.workspace_dir = str(tmp_path)
    return project


def test_single_source_nested_follower_uses_accumulated_render_clock(tmp_path: Path) -> None:
    project = _trimmed_nested_project(tmp_path)
    engine = MagicMock(spec=FFmpegEngine)
    engine.segments_after_edits.side_effect = lambda duration, *_args: [
        MagicMock(start=0.0, end=duration)
    ]

    render_track_from_timeline(
        project, project.tracks[0], tmp_path / "render.wav", {}, engine=engine
    )

    rendered_source, _, segments = engine.render_timeline.call_args.args[:3]
    assert rendered_source == tmp_path / "raw/host.wav"
    assert [(segment.src_start, segment.src_end) for segment in segments] == [
        (20, 40),
        (0, 6),
        (40, 50),
    ]
    assert engine.render_timeline.call_args.kwargs["lead_in_sec"] == 2
    assert segments[1].overlap_prev_sec == 17
    assert segments[2].gap_before_sec == 4


def test_saved_ripple_trim_renders_single_source_at_saved_positions(tmp_path: Path) -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")

    raw = tmp_path / "raw"
    raw.mkdir()
    audio = (
        struct.pack("<h", 3000) * (10 * 48_000)
        + bytes(10 * 48_000 * 2)
        + struct.pack("<h", 10_000) * (20 * 48_000)
        + struct.pack("<h", 15_000) * (10 * 48_000)
        + bytes(10 * 48_000 * 2)
    )
    _write_mono_pcm_wav(raw / "host.wav", audio)

    project = _trimmed_nested_project(tmp_path)
    project.timeline.clips[0].source_end = 10
    project.timeline.clips[0].mute_regions = [ClipMuteRegion(start_s=0, end_s=10)]
    project.timeline.clips[0].timeline_start = 5
    project.timeline.clips[1].timeline_start = 6
    project.timeline.clips[2].timeline_start = 30
    project_path = save_project(project)
    workspace = ProjectWorkspace.open(project_path)
    target = TrimBoundaryTarget(clip_id="anchor", edge="out", mode=EditMode.RIPPLE)
    EditService(workspace).trim_clip_edge(
        "anchor",
        "out",
        6,
        mode=EditMode.RIPPLE,
        expected_token=boundary_context(workspace.project, target).token,
        confirm_cut_speech=True,
    )

    saved = load_project(project_path)
    clips = {clip.id: clip for clip in saved.clips}
    assert [
        (clip.timeline_start, clip.timeline_end)
        for clip in (clips["anchor"], clips["follower"], clips["later"])
    ] == [(5, 11), (2, 22), (26, 36)]
    assert (clips["anchor"].source_start, clips["anchor"].source_end) == (0, 6)
    assert (clips["follower"].source_start, clips["follower"].source_end) == (20, 40)
    assert (clips["later"].source_start, clips["later"].source_end) == (40, 50)
    assert same_source_timeline_overlaps(saved) == []

    output = tmp_path / "after.wav"
    engine = FFmpegEngine()
    render_track_from_timeline(saved, saved.tracks[0], output, {}, engine=engine)

    with wave.open(str(output), "rb") as rendered:
        actual_frames = rendered.getnframes()
        actual_samples = []
        for second in (1.5, 2.5, 5.5, 22.5, 25.5, 26.5, 35.5):
            rendered.setpos(round(second * rendered.getframerate()))
            actual_samples.append(struct.unpack("<h", rendered.readframes(1))[0])

    expected_frames = 36 * 48_000
    expected_samples = [0, 10_000, 10_000, 0, 0, 15_000, 15_000]
    assert (actual_frames, actual_samples) == (
        expected_frames,
        expected_samples,
    ), f"rendered {actual_frames} frames and sampled {actual_samples}"


def test_saved_ripple_trim_keeps_nested_crossfade_at_saved_positions(
    tmp_path: Path,
) -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")

    raw = tmp_path / "raw"
    raw.mkdir()
    audio = (
        struct.pack("<h", 3000) * (10 * 48_000)
        + bytes(10 * 48_000 * 2)
        + struct.pack("<h", 10_000) * (20 * 48_000)
        + struct.pack("<h", 15_000) * (2 * 48_000)
        + bytes(18 * 48_000 * 2)
    )
    _write_mono_pcm_wav(raw / "host.wav", audio)

    project = contract_project(
        [{"id": "host", "role": "dialogue", "media_path": "raw/host.wav", "duration_sec": 60}],
        clips=[
            Clip(
                id="anchor",
                track_id="host",
                timeline_start=5,
                source_start=0,
                source_end=10,
                fade_in_ms=0,
                fade_out_ms=100,
                join_in_mode=ClipJoinMode.CUT,
                mute_regions=[ClipMuteRegion(start_s=0, end_s=10)],
            ),
            Clip(
                id="follower",
                track_id="host",
                timeline_start=6,
                source_start=20,
                source_end=40,
                fade_in_ms=0,
                fade_out_ms=0,
                join_in_mode=ClipJoinMode.CUT,
                mute_regions=[ClipMuteRegion(start_s=29, end_s=40)],
            ),
            Clip(
                id="later",
                track_id="host",
                timeline_start=15,
                source_start=40,
                source_end=42,
                fade_in_ms=100,
                fade_out_ms=0,
                join_in_mode=ClipJoinMode.CROSSFADE,
            ),
        ],
    )
    project.workspace_dir = str(tmp_path)
    update_timeline_duration(project)
    assert project.timeline.duration_sec == 26

    project_path = save_project(project)
    workspace = ProjectWorkspace.open(project_path)
    target = TrimBoundaryTarget(clip_id="anchor", edge="out", mode=EditMode.RIPPLE)
    EditService(workspace).trim_clip_edge(
        "anchor",
        "out",
        6,
        mode=EditMode.RIPPLE,
        expected_token=boundary_context(workspace.project, target).token,
        confirm_cut_speech=True,
    )

    saved = load_project(project_path)
    clips = {clip.id: clip for clip in saved.clips}
    assert [
        (clip.timeline_start, clip.timeline_end)
        for clip in (clips["anchor"], clips["follower"], clips["later"])
    ] == [(5, 11), (2, 22), (11, 13)]
    assert (clips["anchor"].source_start, clips["anchor"].source_end) == (0, 6)
    assert (clips["follower"].source_start, clips["follower"].source_end) == (20, 40)
    assert (clips["later"].source_start, clips["later"].source_end) == (40, 42)
    assert clips["later"].join_in_mode is ClipJoinMode.CROSSFADE
    assert same_source_timeline_overlaps(saved) == []

    output = tmp_path / "after-crossfade.wav"
    engine = FFmpegEngine()
    render_track_from_timeline(saved, saved.tracks[0], output, {}, engine=engine)

    with wave.open(str(output), "rb") as rendered:
        actual_frames = rendered.getnframes()
        sample_positions = (10.5, 11.5, 12.5, 14.5, 21.5)
        actual_samples = []
        for second in sample_positions:
            rendered.setpos(round(second * rendered.getframerate()))
            actual_samples.append(struct.unpack("<h", rendered.readframes(1))[0])

    assert (actual_frames, actual_samples) == (
        22 * 48_000,
        [10_000, 15_000, 15_000, 0, 0],
    ), f"rendered {actual_frames} frames and sampled {actual_samples}"
