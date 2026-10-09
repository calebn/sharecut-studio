import struct
import wave
from pathlib import Path

from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EpisodeProject,
    MediaAsset,
    Track,
    load_project,
    save_project,
)


def test_saved_shared_source_native_crossfade_chain_keeps_all_samples(tmp_path: Path) -> None:
    with wave.open(str(tmp_path / "source.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(struct.pack("<h", 3000) * 9600)
    project = EpisodeProject.create("native source chain", str(tmp_path))
    project.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="source.wav", duration_sec=0.2))
    ]
    project.clips = [
        Clip(
            id=f"clip-{index}",
            track_id="host",
            source_start=0,
            source_end=0.2,
            timeline_start=index * 0.2,
            fade_in_ms=20,
            fade_out_ms=20,
            join_in_mode=ClipJoinMode.CROSSFADE,
        )
        for index in range(10)
    ]
    project = load_project(save_project(project))
    output = tmp_path / "chain.wav"
    render_track_from_timeline(project, project.tracks[0], output, {})
    with wave.open(str(output)) as rendered:
        assert (rendered.getnframes(), rendered.getframerate(), rendered.getnchannels()) == (
            87360,
            48000,
            1,
        )
        pcm = struct.unpack("<87360h", rendered.readframes(87360))
    assert [pcm[round(time * 48000)] for time in (0.1, 0.5, 1.5)] == [3000, 3000, 3000]
