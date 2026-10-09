import struct
import wave
from pathlib import Path

import pytest

from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
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


@pytest.mark.parametrize("window", [False, True])
def test_saved_ramp_cut_keeps_5926_sample_boundary(tmp_path: Path, window: bool) -> None:
    samples = [index % 20000 for index in range(48000)]
    boundary = 5926 / 48000
    project = saved_project(
        tmp_path, samples, [clip("a", 0, boundary, 0), clip("b", boundary, 1, boundary)]
    )
    output = tmp_path / "ramp.wav"
    if window:
        render_track_segment(project, "host", 0, 1, output, {})
    else:
        render_track_from_timeline(project, project.tracks[0], output, {})
    with wave.open(str(output)) as rendered:
        assert rendered.getnframes() == 48000
        pcm = struct.unpack("<48000h", rendered.readframes(48000))
    assert pcm == tuple(samples)


@pytest.mark.parametrize(
    "first_rate,second_rate,frames", [(44100, 48000, 13097), (48000, 44100, 14255)]
)
def test_saved_mixed_rate_window_keeps_negotiated_extent(
    tmp_path: Path, first_rate: int, second_rate: int, frames: int
) -> None:
    for name, rate, value in [("a", first_rate, 1000), ("b", second_rate, 2000)]:
        with wave.open(str(tmp_path / f"{name}.wav"), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(struct.pack("<h", value) * rate)
    project = EpisodeProject.create("mixed", str(tmp_path))
    project.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="a.wav", duration_sec=1))
    ]
    project.sources = [SourceRecording(id="other", path="b.wav", speaker="Host", duration_sec=1)]
    project.clips = [
        clip("a", 0, 0.4, 0),
        clip("b", 0, 0.8, 0.2).model_copy(update={"source_id": "other"}),
    ]
    project = load_project(save_project(project))
    output = tmp_path / "mixed.wav"
    render_track_segment(project, "host", 0.30301041666666667, 0.6, output, {})
    with wave.open(str(output)) as rendered:
        assert (rendered.getnframes(), rendered.getframerate(), rendered.getnchannels()) == (
            frames,
            first_rate,
            1,
        )
        pcm = struct.unpack(f"<{frames}h", rendered.readframes(frames))
    assert pcm[100] == 3000
    assert pcm[-100] == 2000


def test_saved_source_cut_preserves_actual_gap(tmp_path: Path) -> None:
    project = saved_project(
        tmp_path, [3000] * 48000 + [9000] * 48000, [clip("a", 0, 1, 0), clip("b", 1, 2, 1.2)]
    )
    project.edit_decisions = [
        EditDecision(
            id="remove",
            track_id="host",
            start=0.2,
            end=0.4,
            type=EditDecisionType.REMOVE,
            applied=True,
        )
    ]
    project = load_project(save_project(project))
    output = tmp_path / "gap.wav"
    render_track_from_timeline(project, project.tracks[0], output, {})
    with wave.open(str(output)) as rendered:
        assert (rendered.getnframes(), rendered.getframerate(), rendered.getnchannels()) == (
            96000,
            48000,
            1,
        )
        pcm = struct.unpack("<96000h", rendered.readframes(96000))
    assert pcm[38000] == 3000
    assert pcm[40000:48000] == (0,) * 8000
    assert pcm[48000:] == (9000,) * 48000
