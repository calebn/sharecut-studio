"""Component delays after a gap stay on the grid however many clips came before (#2456).

``duration()`` of a body is a difference of two microsecond-rounded source times, so summing
it over hundreds of clips drifts by whole samples at 48 kHz and above. Placement keeps
frames, so a window puts every clip on the stem's sample.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio import MixAudio, delay_frames, duration, sources
from podcast_mcp.engines.timeline_render import placed_track_audio, track_grid
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track, TrackRole


def _project(root: Path, rate: int, clip_count: int, seed: int) -> EpisodeProject:
    (root / "raw").mkdir()
    with wave.open(str(root / "raw" / "host.wav"), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(rate)
        audio_file.writeframes(np.zeros(rate, dtype="<i2").tobytes())
    project = EpisodeProject.create("accumulation", str(root))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    project.sources = [SourceRecording(id="host", path="raw/host.wav", duration_sec=1.0)]
    rng = np.random.default_rng(seed)
    clips: list[Clip] = []
    timeline = source = 0.0
    for index in range(clip_count):
        if index % 3 == 2:
            timeline += float(rng.uniform(0.06, 0.5))
        length = round(float(rng.uniform(0.2, 2.5)), int(rng.choice([3, 5, 7, 9])))
        clips.append(
            Clip(
                id=f"c{index}",
                track_id="host",
                source_start=source,
                source_end=source + length,
                timeline_start=timeline,
            )
        )
        timeline += length
        source += length + float(rng.uniform(0.0, 0.3))
    project.timeline.clips = clips
    project.timeline.duration_sec = timeline
    return project


def _positions(project: EpisodeProject, window: tuple[float, float] | None, rate: int):
    """Each clip's (timeline frame, source frame) in the render, from its leaf's placement."""
    track = project.timeline.tracks[0]
    clips = project.timeline.clips
    grid = track_grid(project, track, clips, window=window)
    assert grid is not None and grid.rate == rate
    audio = placed_track_audio(project, track, clips, grid=grid, window=window).audio
    assert isinstance(audio, MixAudio)
    origin = grid.frame(window[0]) if window else 0
    found: dict[str, tuple[int, int]] = {}
    for at in (audio.head, *audio.tail):
        frame = delay_frames(at.start_sec, rate)
        for leaf in sources(at.audio):
            found[leaf.clip_id] = (
                origin + frame,
                grid.source_frame(leaf.path, leaf.src_start),
            )
            frame += round(duration(leaf) * rate)
    return found


@pytest.mark.parametrize(
    ("rate", "clip_count", "seed"), [(48_000, 500, 3), (44_100, 500, 2), (192_000, 100, 3)]
)
def test_window_places_every_clip_on_the_stem_sample(
    tmp_path: Path, rate: int, clip_count: int, seed: int
) -> None:
    project = _project(tmp_path, rate, clip_count, seed)
    stem = _positions(project, None, rate)
    clips = project.timeline.clips
    checked = 0
    # Every 20th clip plus the last few: the drift builds with the clips before a window, so
    # the late windows carry the proof; a window per clip would rebuild the placement of all
    # the clips 500 times (over a minute on a slow runner) for no extra coverage.
    indices = {*range(0, clip_count - 4, 20), *range(clip_count - 12, clip_count - 4)}
    for index in sorted(indices):
        start = clips[index].timeline_start
        window = _positions(project, (start, start + 2.0), rate)
        for clip_id, placed in window.items():
            assert placed[0] - placed[1] == stem[clip_id][0] - stem[clip_id][1], (index, clip_id)
            checked += 1
    assert checked > len(indices)
