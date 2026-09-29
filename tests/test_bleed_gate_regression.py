from __future__ import annotations

import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.project_state import render_lock

RATE = 48_000


def _write_pcm(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(np.round(samples * 32767).astype("<i2").tobytes())


def _read_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        assert source.getframerate() == RATE
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")


def _episode(tmp_path: Path, style: str = "voiced") -> EpisodeProject:
    project = EpisodeProject.create("speech and bleed", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(4 * RATE) / RATE
    owner = np.zeros(clock.size)
    owner_mask = (clock >= 0.4) & (clock < 1.2)
    if style == "unvoiced":
        owner[owner_mask] = np.random.default_rng(1).normal(0, 0.035, owner_mask.sum())
    else:
        amplitude = 0.007 if style == "quiet" else 0.2
        owner[owner_mask] = amplitude * np.sin(2 * np.pi * (173 * clock[owner_mask]))
    omitted = (clock >= 3.1) & (clock < 3.5)
    owner[omitted] = 0.09 * np.sin(2 * np.pi * 257 * clock[omitted])
    peer = np.zeros(clock.size)
    foreign = (clock >= 2.0) & (clock < 2.6)
    peer[foreign] = np.random.default_rng(2).normal(0, 0.15, foreign.sum())
    owner += peer * 0.12
    for track_id, samples in (("host", owner), ("guest", peer)):
        raw = tmp_path / "raw" / f"{track_id}.wav"
        _write_pcm(raw, samples)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=4.0),
                role=TrackRole.DIALOGUE,
                transcript_gate=track_id == "host",
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip-{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=4.0,
                timeline_start=0.0,
            )
        )
        stem = project.artifacts_dir() / "tracks" / f"{track_id}.wav"
        stem.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(raw, stem)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="owner", start=0.55, end=1.0),
                TranscriptWord(
                    text="foreign",
                    start=2.0,
                    end=2.6,
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        ),
        Transcript(track_id="guest", words=[TranscriptWord(text="foreign", start=2.0, end=2.6)]),
    ]
    write_stem_hash(project, "host")
    write_stem_hash(project, "guest")
    return project


@pytest.mark.parametrize("style", ["voiced", "unvoiced", "quiet"])
def test_gate_preserves_own_speech_and_reduces_confirmed_foreign_audio(
    tmp_path: Path, style: str
) -> None:
    project = _episode(tmp_path, style)
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "gated.wav"
    shutil.copyfile(source, output)
    apply_track_transcript_gate(project, "host", output, timeline_start=0, timeline_end=4)
    before, after = _read_pcm(source), _read_pcm(output)
    np.testing.assert_allclose(
        after[int(0.4 * RATE) : int(1.2 * RATE)], before[int(0.4 * RATE) : int(1.2 * RATE)], atol=1
    )
    np.testing.assert_allclose(
        after[int(3.1 * RATE) : int(3.5 * RATE)], before[int(3.1 * RATE) : int(3.5 * RATE)], atol=1
    )
    foreign = slice(int(2.05 * RATE), int(2.55 * RATE))
    assert np.sqrt(np.mean(after[foreign].astype(float) ** 2)) < 0.1 * np.sqrt(
        np.mean(before[foreign].astype(float) ** 2)
    )


def test_midword_segment_matches_full_gate(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    source = tmp_path / "raw" / "host.wav"
    whole = tmp_path / "whole.wav"
    segment = tmp_path / "segment.wav"
    shutil.copyfile(source, whole)
    raw = _read_pcm(source)
    _write_pcm(segment, raw[int(0.7 * RATE) : int(0.9 * RATE)] / 32767)
    apply_track_transcript_gate(project, "host", whole, timeline_start=0, timeline_end=4)
    apply_track_transcript_gate(project, "host", segment, timeline_start=0.7, timeline_end=0.9)
    np.testing.assert_allclose(
        _read_pcm(segment), _read_pcm(whole)[int(0.7 * RATE) : int(0.9 * RATE)], atol=1
    )


def test_scoped_apply_survives_reopen_and_render(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    project.track_by_id("host").transcript_gate = False
    write_stem_hash(project, "host")
    with render_lock(project):
        result = apply_transcript_bleed_mute(
            project, track_id="host", start_sec=2.05, end_sec=2.35, dry_run=False
        )
    assert result["applied_count"] == 1
    reopened = EpisodeProject.model_validate(project.model_dump())
    output = tmp_path / "rerendered.wav"
    render_track_from_timeline(reopened, reopened.track_by_id("host"), output, {})
    raw = _read_pcm(tmp_path / "raw" / "host.wav")
    actual = _read_pcm(output)
    np.testing.assert_allclose(actual[: int(2.05 * RATE)], raw[: int(2.05 * RATE)], atol=1)
    np.testing.assert_allclose(actual[int(2.35 * RATE) :], raw[int(2.35 * RATE) :], atol=1)
    assert np.max(np.abs(actual[int(2.1 * RATE) : int(2.3 * RATE)])) <= 1


def test_reapplying_gate_does_not_multiply_an_existing_fade(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    project.track_by_id("host").transcript_gate = False
    write_stem_hash(project, "host")
    with render_lock(project):
        apply_transcript_bleed_mute(project, track_id="host", dry_run=False)
        first = _read_pcm(project.artifacts_dir() / "tracks" / "host.wav")
        apply_transcript_bleed_mute(project, track_id="host", dry_run=False)
    np.testing.assert_array_equal(_read_pcm(project.artifacts_dir() / "tracks" / "host.wav"), first)
