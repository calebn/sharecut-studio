from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
)


def _project(tmp_path: Path, points: list[tuple[float, float]] | None) -> EpisodeProject:
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(np.full(16000, 1000, dtype="<i2").tobytes())
    project = EpisodeProject.create("envelope", str(tmp_path))
    project.timeline.tracks = [
        Track(id=track_id, label=track_id, media=MediaAsset(path="source.wav", duration_sec=2))
        for track_id in ("host", "other")
    ]
    project.timeline.clips = [
        Clip(
            id=f"{track_id}-{start}",
            track_id=track_id,
            source_start=0,
            source_end=2,
            timeline_start=start,
        )
        for track_id in ("host", "other")
        for start in (0, 4)
    ]
    if points is not None:
        project.automation_envelopes = [
            AutomationEnvelope(
                track_id="host",
                points=[
                    AutomationPoint(id=f"p{i}", time=time, value=value)
                    for i, (time, value) in enumerate(points)
                ],
            )
        ]
    return project


def _pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        assert audio.getsampwidth() == 2
        assert audio.getnchannels() == 1
        return np.frombuffer(
            audio.readframes(audio.getnframes()), dtype="<i2"
        ), audio.getframerate()


def _gain(data: np.ndarray, rate: int, time: float) -> float:
    return float(data[round((time - 0.025) * rate) : round((time + 0.025) * rate)].mean()) / 1000


@pytest.mark.parametrize(
    ("points", "expected"),
    [
        (None, [1, 1, 1, 1]),
        ([], [1, 1, 1, 1]),
        ([(0, 1), (6, 1)], [1, 1, 1, 1]),
        ([(2, 0.5)], [0.5, 0.5, 0.5, 0.5]),
        ([(1, 0.25), (5, 1)], [0.25, 0.296875, 0.859375, 1]),
        ([(0, 0.25), (1, 0.5), (1, 1), (6, 1)], [0.3125, 1, 1, 1]),
        ([(0, 0), (1, 0), (1, 1), (6, 1)], [0, 1, 1, 1]),
        ([(0, 0.25), (1, 0.5), (1, 1)], [0.3125, 1, 1, 1]),
        ([(1, 0.25), (1, 0.5), (5, 1)], [0.25, 0.53125, 0.90625, 1]),
    ],
)
def test_actual_envelope_pcm_and_destination_window(tmp_path: Path, points, expected):
    project = _project(tmp_path, points)
    full = tmp_path / "full.wav"
    window = tmp_path / "window.wav"
    render_track_from_timeline(project, project.tracks[0], full, {})
    render_track_segment(project, "host", 4, 6, window, {})
    data, rate = _pcm(full)
    segment, segment_rate = _pcm(window)
    assert rate == segment_rate == 8000
    assert len(data) == 6 * rate
    assert len(segment) == 2 * rate
    assert not np.any(data[round(2.2 * rate) : round(3.8 * rate)])
    for time, value in zip((0.25, 1.25, 4.25, 5.25), expected, strict=True):
        assert _gain(data, rate, time) == pytest.approx(value, abs=0.05)
    for time, value in zip((0.25, 1.25), expected[2:], strict=True):
        assert _gain(segment, rate, time) == pytest.approx(value, abs=0.05)
        assert _gain(segment, rate, time) == pytest.approx(_gain(data, rate, time + 4), abs=0.025)
    if points is None or not points or all(value == 1 for _, value in points):
        assert np.all(data[: 2 * rate] == 1000)
        assert np.all(data[4 * rate :] == 1000)
        assert np.all(segment == 1000)


def test_track_envelope_does_not_change_other_track_pcm(tmp_path: Path):
    project = _project(tmp_path, [(0, 0)])
    host = tmp_path / "host.wav"
    other = tmp_path / "other.wav"
    render_track_from_timeline(project, project.tracks[0], host, {})
    render_track_from_timeline(project, project.tracks[1], other, {})
    muted, rate = _pcm(host)
    untouched, _ = _pcm(other)
    assert not np.any(muted)
    assert np.all(untouched[: 2 * rate] == 1000)
    assert np.all(untouched[4 * rate :] == 1000)


@pytest.mark.parametrize("origin", [-1, float("nan"), float("inf")])
def test_envelope_filter_rejects_invalid_timeline_origin(origin):
    with pytest.raises(ValueError, match="timeline_origin_sec"):
        FFmpegEngine().build_track_filter(None, None, timeline_origin_sec=origin)


@pytest.mark.parametrize("previous_revision", [10, 13])
def test_previous_envelope_render_revision_cannot_reuse_stem(
    tmp_path: Path, monkeypatch, previous_revision
):
    import podcast_mcp.engines.play_audit as play_audit
    from podcast_mcp.engines.timeline_render import RENDER_SEMANTICS_REV

    project = _project(tmp_path, [(0, 1), (6, 1)])
    stem = tmp_path / "artifacts" / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True)
    render_track_from_timeline(project, project.tracks[0], stem, {})
    monkeypatch.setattr(play_audit, "RENDER_SEMANTICS_REV", previous_revision)
    play_audit.write_stem_hash(project, "host")
    assert play_audit.stem_is_fresh(project, "host")
    monkeypatch.setattr(play_audit, "RENDER_SEMANTICS_REV", RENDER_SEMANTICS_REV)
    assert RENDER_SEMANTICS_REV > 10
    assert not play_audit.stem_is_fresh(project, "host")
