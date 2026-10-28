"""A chain with a one-rate filter puts the render's pieces on that rate's grid (#2456).

``arnndn`` runs at 48 kHz only. FFmpeg negotiates that rate back through the graph, so the
recording is resampled before ``atrim`` and every piece is cut at 48 kHz, whatever the
recording's own rate. A grid on the recording's rate leaves ``atrim`` to round each start and
end on its own at 48 kHz, so a window and the stem drift apart by a sample or two.
"""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import ffmpeg as ffmpeg_module
from podcast_mcp.engines.audio import MixAudio, delay_frames, duration, sources
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.timeline_render import (
    graph_rate,
    render_track_from_timeline,
    render_track_segment,
    track_grid,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
)

FORCED = 48_000


def _project(root: Path, rates: dict[str, int], *, chain: bool) -> EpisodeProject:
    (root / "raw").mkdir()
    project = EpisodeProject.create("forced_rate", str(root))
    tracks = []
    for name, rate in rates.items():
        with wave.open(str(root / "raw" / f"{name}.wav"), "wb") as audio_file:
            audio_file.setnchannels(1)
            audio_file.setsampwidth(2)
            audio_file.setframerate(rate)
            audio_file.writeframes(np.zeros(rate, dtype="<i2").tobytes())
        tracks.append(
            Track(
                id=name,
                label=name,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{name}.wav", duration_sec=1.0),
            )
        )
    project.timeline.tracks = tracks
    rng = np.random.default_rng(5)
    clips: list[Clip] = []
    timeline = source = 0.0
    for index in range(40):
        length = round(float(rng.uniform(0.2, 2.5)), int(rng.choice([3, 5, 7])))
        clips.append(
            Clip(
                id=f"c{index}",
                track_id=tracks[0].id,
                source_start=source,
                source_end=source + length,
                timeline_start=timeline,
            )
        )
        timeline += length
        source += length + float(rng.uniform(0.0, 0.3))
    project.timeline.clips = clips
    project.timeline.duration_sec = timeline
    if chain:
        project.processing_chains = [
            ProcessingChain(
                track_id=tracks[0].id,
                effects=[ProcessingEffect(effect="arnndn", params={"model": "/models/x.rnnn"})],
            )
        ]
    return project


@pytest.mark.parametrize(
    ("af", "rate"),
    [
        ("anull", None),
        ("highpass=f=80,acompressor=threshold=0.1", None),
        ("highpass=f=80,arnndn=m=/m/x.rnnn,acompressor", FORCED),
        ("arnndn=m=/m/x.rnnn", FORCED),
        ("loudnorm=I=-16:TP=-1.5:LRA=11", None),
        ("loudnorm=I=-16,arnndn=m=/m/x.rnnn", FORCED),
        ("arnndn=m=/m/x.rnnn,loudnorm=I=-16", FORCED),
        ("volume=2", None),
    ],
)
def test_graph_rate_reads_the_one_rate_filters(af: str, rate: int | None) -> None:
    assert graph_rate(af) == rate


def test_forced_rate_replaces_the_recordings_rate(tmp_path: Path) -> None:
    project = _project(tmp_path, {"a": 44_100}, chain=False)
    track = project.timeline.tracks[0]
    clips = project.timeline.clips
    own = track_grid(project, track, clips)
    forced = track_grid(project, track, clips, forced_rate=FORCED)
    assert own is not None and own.rate == 44_100
    assert forced is not None and forced.rate == FORCED
    assert forced.seeks == own.seeks


def _captured_positions(monkeypatch: pytest.MonkeyPatch, render) -> dict[str, tuple[int, int]]:
    """Each clip's (timeline frame, source frame) at 48 kHz, from the audio the render is handed."""
    captured = []

    def capture(self, output_path, audio, af, **kwargs):
        captured.append(audio)
        output_path.write_bytes(b"")

    monkeypatch.setattr(FFmpegEngine, "render_timeline", capture)
    render()
    (audio,) = captured
    assert isinstance(audio, MixAudio)
    seek = MediaSeek.at(0.0, lead_sec=0.0)
    found: dict[str, tuple[int, int]] = {}
    for at in (audio.head, *audio.tail):
        frame = delay_frames(at.start_sec, FORCED)
        for leaf in sources(at.audio):
            found[leaf.clip_id] = (frame, seek.first_sample(leaf.src_start, FORCED))
            frame += round(duration(leaf) * FORCED)
    return found


def test_a_window_cuts_its_pieces_on_the_48k_lattice_of_the_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _project(tmp_path, {"a": 44_100}, chain=True)
    track = project.timeline.tracks[0]
    defaults = load_defaults()
    stem = _captured_positions(
        monkeypatch,
        lambda: render_track_from_timeline(project, track, tmp_path / "stem.wav", defaults),
    )
    checked = 0
    for index in range(2, 36, 3):
        start = project.timeline.clips[index].timeline_start + 0.0123
        origin = math.floor(start * FORCED + 0.5)
        window = _captured_positions(
            monkeypatch,
            lambda start=start: render_track_segment(
                project, "a", start, start + 2.0, tmp_path / "win.wav", defaults
            ),
        )
        for clip_id, (frame, source) in window.items():
            stem_frame, stem_source = stem[clip_id]
            assert origin + frame - source == stem_frame - stem_source, (index, clip_id)
            checked += 1
    assert checked > 20


def test_the_render_graph_resamples_each_recording_before_atrim_even_with_delays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the named resample a delay's rate pin lets ``atrim`` run at the recording's rate."""
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _project(tmp_path, {"a": 44_100}, chain=True)
    project.timeline.clips = project.timeline.clips[:3]
    project.timeline.clips[0].timeline_start = 0.37
    graphs: list[str] = []

    def spy(run, cmd, **kwargs):
        index = max(
            cmd.index(flag) for flag in ("-filter_complex", "-/filter_complex") if flag in cmd
        )
        graphs.append(
            Path(cmd[index + 1]).read_text() if cmd[index] == "-/filter_complex" else cmd[index + 1]
        )

    monkeypatch.setattr(ffmpeg_module, "spawn_or_too_long", spy)
    monkeypatch.setattr(
        ffmpeg_module,
        "negotiated_rates",
        lambda *_args, **_kwargs: {f"adelay@pin_{k}": FORCED for k in range(9)},
    )
    render_track_from_timeline(
        project, project.timeline.tracks[0], tmp_path / "stem.wav", load_defaults(), engine=engine
    )
    assert graphs[-1].startswith("[0:a]aresample=48000,asplit=3[")
    assert "adelay=delays=" in graphs[-1]
