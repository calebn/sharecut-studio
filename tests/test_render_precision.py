from pathlib import Path
import struct
import wave

import pytest

from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EpisodeProject,
    MediaAsset,
    Track,
    load_project,
    save_project,
)


def saved_project(tmp_path: Path, samples: list[int], clips: list[Clip]) -> EpisodeProject:
    with wave.open(str(tmp_path / "source.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    project = EpisodeProject.create("precision", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="source.wav", duration_sec=len(samples) / 48000),
        )
    ]
    project.clips = clips
    return load_project(save_project(project))


def clip(id: str, start: float, end: float, placement: float) -> Clip:
    return Clip(
        id=id,
        track_id="host",
        source_start=start,
        source_end=end,
        timeline_start=placement,
        fade_in_ms=0,
        fade_out_ms=0,
        join_in_mode=ClipJoinMode.CUT,
    )


@pytest.mark.parametrize("window", [False, True])
def test_saved_abutting_cut_preserves_sample_boundary(tmp_path: Path, window: bool) -> None:
    project = saved_project(
        tmp_path,
        [3000] * 504 + [9000] * 504,
        [clip("a", 0, 0.0105, 0), clip("b", 0.0105, 0.021, 0.0105)],
    )
    output = tmp_path / "render.wav"
    if window:
        render_track_segment(project, "host", 0, 0.021, output, {})
    else:
        render_track_from_timeline(project, project.tracks[0], output, {})
    with wave.open(str(output)) as rendered:
        assert (rendered.getnframes(), rendered.getframerate(), rendered.getnchannels()) == (
            1008,
            48000,
            1,
        )
        pcm = struct.unpack("<1008h", rendered.readframes(1008))
    assert pcm == (3000,) * 504 + (9000,) * 504


@pytest.mark.parametrize("end,frames", [(0.123456, 5926), (0.12347708333333332, 5927)])
def test_saved_fractional_window_negotiates_tail_extent(
    tmp_path: Path, end: float, frames: int
) -> None:
    project = saved_project(tmp_path, [1000] * 48000, [clip("a", 0, 0.01, 0)])
    output = tmp_path / "window.wav"
    render_track_segment(project, "host", 0, end, output, {})
    with wave.open(str(output)) as rendered:
        assert (rendered.getnframes(), rendered.getframerate(), rendered.getnchannels()) == (
            frames,
            48000,
            1,
        )
        pcm = struct.unpack(f"<{frames}h", rendered.readframes(frames))
    assert pcm[:480] == (1000,) * 480
    assert pcm[480:] == (0,) * (frames - 480)
