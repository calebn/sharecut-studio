from __future__ import annotations

import os
import wave
from pathlib import Path

import numpy as np

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_speech import (
    LaneSourceExtent,
    RecordingSourceExtent,
    _chosen_on_timeline,
    assess_cut_speech,
)
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent
from podcast_mcp.models import (
    Clip,
    CutSpeechWord,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _write_wav(path: Path, seconds: float = 30.0) -> None:
    samples = (0.02 * np.sin(2 * np.pi * 440 * np.arange(int(16_000 * seconds)) / 16_000)).astype(
        "<i2"
    )
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16_000)
        out.writeframes(samples.tobytes())


def _cross_lane_alias_project(tmp_path: Path) -> EpisodeProject:
    root = tmp_path / "ep"
    raw = root / "raw"
    raw.mkdir(parents=True)
    guest_wav = raw / "guest.wav"
    _write_wav(guest_wav)
    alias_path = raw / "guest-alias.wav"
    os.link(guest_wav, alias_path)
    project = EpisodeProject.create("batch alias", str(root))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=30),
        ),
        Track(
            id="parking",
            label="Parking",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/parking.wav", duration_sec=30),
        ),
    ]
    _write_wav(raw / "host.wav")
    _write_wav(raw / "parking.wav")
    project.sources = [
        SourceRecording(id="guest-alias", path="raw/guest-alias.wav", duration_sec=30),
    ]
    project.clips = [
        Clip(id="host-1", track_id="host", source_start=0, source_end=30, timeline_start=0),
        Clip(
            id="guest-alias-clip",
            track_id="parking",
            source_id="guest-alias",
            source_start=0,
            source_end=30,
            timeline_start=20,
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="hi", start=5.0, end=5.5)],
        ),
    ]
    return project


def test_equivalent_source_ids_includes_alias(tmp_path: Path):
    project = _cross_lane_alias_project(tmp_path)
    ids = project.equivalent_source_ids("guest", None)
    assert ids == frozenset({None, "guest-alias"})


def test_equivalent_source_ids_on_track_without_media(tmp_path: Path):
    root = tmp_path / "ep"
    project = EpisodeProject.create("clip lane", str(root))
    project.tracks = [Track(id="c", label="c", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="other", track_id="c", source_start=0, source_end=20, timeline_start=0),
    ]
    assert project.equivalent_source_ids("c", None) == frozenset({None})


def test_chosen_on_timeline_maps_parked_alias_for_primary_extent(tmp_path: Path):
    project = _cross_lane_alias_project(tmp_path)
    chosen = [RecordingSourceExtent("guest", 5.0, 5.5, source_id=None)]
    spans = _chosen_on_timeline(project, "guest", chosen, 24.0, 26.0)
    assert spans == [(25.0, 25.5)]


def test_unwitnessed_lane_extent_covers_foreign_take_on_that_lane(tmp_path: Path):
    project = _cross_lane_alias_project(tmp_path)
    project.clips = [clip for clip in project.clips if clip.id != "guest-alias-clip"]
    project.sources.append(SourceRecording(id="foreign", path="raw/host.wav", duration_sec=30))
    project.clips.append(
        Clip(
            id="foreign-on-guest",
            track_id="guest",
            source_id="foreign",
            source_start=5,
            source_end=6,
            timeline_start=25,
        )
    )

    lane = _chosen_on_timeline(project, "guest", [LaneSourceExtent("guest", 5, 5.5)], 24, 26)
    primary = _chosen_on_timeline(
        project, "guest", [RecordingSourceExtent("guest", 5, 5.5, source_id=None)], 24, 26
    )

    assert lane == [(25, 25.5)]
    assert primary == []


def test_assess_cut_speech_ignores_words_covered_by_equivalent_batch_extent(
    tmp_path: Path, monkeypatch
):
    project = _cross_lane_alias_project(tmp_path)
    removal = RippleRemoval.of([TrackExtent("host", 24.0, 26.0)])
    word = CutSpeechWord(text="hi", timeline_start=25.0, timeline_end=25.5)

    def fake_words(_project, tid, parts, *_args, **_kwargs):
        if tid != "guest":
            return []
        return [
            word for start, end in parts if word.timeline_start < end and word.timeline_end > start
        ]

    monkeypatch.setattr("podcast_mcp.edits.cut_speech.speech_words_in", fake_words)
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_speech.speech_energy_guard_enabled", lambda _cfg: False
    )
    without_batch = assess_cut_speech(project, removal, defaults=load_defaults())
    assert without_batch is not None
    with_batch = assess_cut_speech(
        project,
        removal,
        also_chosen=[RecordingSourceExtent("guest", 5.0, 5.5, source_id=None)],
        defaults=load_defaults(),
    )
    assert with_batch is None
