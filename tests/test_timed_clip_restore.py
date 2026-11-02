"""Bleed Restore under a clip with a timing map restores each piece as its own untimed clip would."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import ClipOffSpeakerMuteRegion, EpisodeProject
from test_bleed_restore_core import _restore
from test_timed_clip_render import (
    RATE,
    _four_clips,
    _frames,
    _mapped,
    _project,
    _source,
)

_PLAN = BleedGatePlan(
    attenuation_spans=((0.2, 3.9),), fade_sec=0.02, reduction="attenuate", attenuation_db=20
)
_REGIONS = [(0.3, 0.6), (2.3, 2.7), (3.3, 3.6)]


def _pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        assert audio.getframerate() == RATE
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")


def _gated(project: EpisodeProject, monkeypatch: pytest.MonkeyPatch) -> EpisodeProject:
    project.tracks[0].transcript_gate = True
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: _PLAN,
    )
    return project


def _render(project: EpisodeProject, name: str) -> np.ndarray:
    out = Path(project.workspace_dir) / "artifacts" / f"{name}.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    return _pcm(out)


def _restored(clips, tmp_path: Path, regions):
    source = tmp_path / "raw" / "host.wav"
    return [
        _restore(clip, source, [r for r in regions if clip.source_start <= r[0] < clip.source_end])
        if any(clip.source_start <= r[0] < clip.source_end for r in regions)
        else clip
        for clip in clips
    ]


def _pair(tmp_path, monkeypatch, regions, signal=None):
    signal = _source() if signal is None else signal
    timed = _gated(_project(tmp_path / "timed", [_mapped()], signal), monkeypatch)
    timed.clips = [_restore(timed.clips[0], tmp_path / "timed" / "raw" / "host.wav", regions)]
    pieces = _gated(_project(tmp_path / "pieces", _four_clips(), signal), monkeypatch)
    pieces.clips = _restored(pieces.clips, tmp_path / "pieces", regions)
    return timed, pieces


def test_regions_spanning_pieces_0_2_and_3_equal_the_pieces_as_untimed_clips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    timed, pieces = _pair(tmp_path, monkeypatch, _REGIONS)
    rendered_timed = _render(timed, "timed")
    rendered_pieces = _render(pieces, "pieces")
    assert rendered_timed.shape == rendered_pieces.shape
    assert np.array_equal(rendered_timed, rendered_pieces)
    plain = _render(_gated(_project(tmp_path / "plain", [_mapped()], _source()), monkeypatch), "p")
    assert np.any(rendered_timed != plain)


def test_pieces_without_restore_regions_are_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    timed, pieces = _pair(tmp_path, monkeypatch, [(0.3, 0.6), (3.3, 3.6)])
    rendered_timed = _render(timed, "timed")
    assert np.array_equal(rendered_timed, _render(pieces, "pieces"))
    plain = _render(_gated(_project(tmp_path / "plain", [_mapped()], _source()), monkeypatch), "p")
    middle = slice(_frames(1.3), _frames(3.1))
    assert np.array_equal(rendered_timed[middle], plain[middle])


@pytest.mark.parametrize("window", [(1.1, 3.4), (0.5, 2.6)])
def test_a_segment_render_restores_each_piece_like_the_untimed_pieces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, window: tuple[float, float]
) -> None:
    timed, pieces = _pair(tmp_path, monkeypatch, _REGIONS)
    rendered = []
    for name, project in (("timed", timed), ("pieces", pieces)):
        out = Path(project.workspace_dir) / "artifacts" / f"{name}-segment.wav"
        render_track_segment(project, "host", *window, out, {})
        rendered.append(_pcm(out))
    assert rendered[0].shape == rendered[1].shape
    assert np.array_equal(rendered[0], rendered[1])


def test_automatic_mutes_under_a_late_gate_restore_per_piece(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mutes = [{"start_s": 0.1, "end_s": 0.9}, {"start_s": 2.2, "end_s": 2.9}]
    timed, pieces = _pair(tmp_path, monkeypatch, [(0.3, 0.6), (2.3, 2.7)])
    for project in (timed, pieces):
        project.clips = [
            clip.model_copy(
                update={
                    "off_speaker_mute_regions": [
                        ClipOffSpeakerMuteRegion(**m)
                        for m in mutes
                        if clip.source_start <= m["start_s"] < clip.source_end
                    ]
                }
            )
            for clip in project.clips
        ]
    assert np.array_equal(_render(timed, "timed"), _render(pieces, "pieces"))
