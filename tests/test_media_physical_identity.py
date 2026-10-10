from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from podcast_mcp.edits.session_air import Placement, SessionAir, lane_placements
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec


def _project(tmp_path):
    first = tmp_path / "first.wav"
    first.write_bytes(b"recording")
    alias = tmp_path / "alias.wav"
    os.link(first, alias)
    different = tmp_path / "different.wav"
    different.write_bytes(b"recording")
    project = EpisodeProject.create("physical identity", str(tmp_path))
    project.tracks = [Track(id="host", label="Host", media=MediaAsset(path="first.wav"))]
    project.sources = [
        SourceRecording(id="alias", path="alias.wav", duration_sec=4),
        SourceRecording(id="different", path="different.wav", duration_sec=4),
    ]
    project.clips = [
        Clip(id="primary", track_id="host", source_start=0, source_end=2, timeline_start=0),
        Clip(
            id="alias",
            track_id="host",
            source_id="alias",
            source_start=0,
            source_end=2,
            timeline_start=3,
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="primary", start=0.2, end=0.4),
            ],
        )
    ]
    return project, first, alias, different


def test_physical_aliases_and_missing_path_geometry(tmp_path):
    _, first, alias, different = _project(tmp_path)
    assert same_recording(first, alias) is True
    assert same_recording(first, different) is False
    missing = tmp_path / "missing.wav"
    assert same_recording(missing, tmp_path / "." / "missing.wav") is True
    assert same_recording(missing, tmp_path / "other-missing.wav") is False
    alias.unlink()
    assert same_recording(first, alias) is False


def test_timeline_geometry_accepts_aliases_and_canonical_missing_media(tmp_path):
    project, first, _, _ = _project(tmp_path)
    project.clips = [project.clips[1]]
    assert SessionTimeline(project).exact_source_span(
        "host", SourceSec(0.5), SourceSec(0.7)
    ) == pytest.approx((3.5, 3.7))
    project.clips[0].source_id = "different"
    assert (
        SessionTimeline(project).exact_source_span("host", SourceSec(0.5), SourceSec(0.7)) is None
    )
    project.clips[0].source_id = None
    first.unlink()
    assert SessionTimeline(project).exact_source_span(
        "host", SourceSec(0.5), SourceSec(0.7)
    ) == pytest.approx((3.5, 3.7))


def test_identity_errors_are_not_missing_media(monkeypatch, tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    monkeypatch.setattr(Path, "stat", lambda self: SimpleNamespace(st_dev=1, st_ino=0))
    with pytest.raises(ValueError, match="physical file identity"):
        same_recording(first, second)
    assert same_recording(first, first) is True

    def denied(self):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "stat", denied)
    with pytest.raises(PermissionError, match="denied"):
        same_recording(first, second)


def test_alias_transcript_fallback_and_exact_source_provenance(tmp_path):
    project, _, _, _ = _project(tmp_path)
    assert project.transcript_for_source("host", "alias").words[0].text == "primary"
    assert project.transcript_for_source("host", "different") is None
    project.transcripts.append(
        Transcript(
            track_id="host",
            source_id="alias",
            words=[
                TranscriptWord(text="alias-only", start=0.8, end=1.0),
            ],
        )
    )
    assert project.transcript_for_source("host", "alias").words[0].text == "alias-only"
    assert project.transcript_for_source("host", None).words[0].text == "primary"
    air = SessionAir(project)
    assert air.silence_around(0.5, 0.7) == pytest.approx(3.4)
    assert air.silence_around(3.5, 3.7) == pytest.approx(3.4)
    assert air.silence_around(3.85, 3.9) is None


def test_alias_guard_refuses_replay_but_accepts_different_media(tmp_path):
    project, _, _, _ = _project(tmp_path)
    air = SessionAir(project)
    placement, recording = air._lane("host")[0]
    assert air._unique_guard(recording, placement, 0.5, 0.7) is False
    project.clips[1].source_id = "different"
    air = SessionAir(project)
    placement, recording = air._lane("host")[0]
    assert air._unique_guard(recording, placement, 0.5, 0.7) is True


def test_silent_source_frames_consider_all_physical_transcript_groups(tmp_path):
    project, _, _, _ = _project(tmp_path)
    project.transcripts.append(
        Transcript(
            track_id="host",
            source_id="alias",
            words=[
                TranscriptWord(text="alias-only", start=0.8, end=1.0),
            ],
        )
    )
    air = SessionAir(project)
    _, primary = air._lane("host")[0]
    silent = air.session_silent_frames(primary, 200)
    assert bool(silent[60]) is True
    assert bool(silent[85]) is False
    project.clips[1].source_id = "different"
    air = SessionAir(project)
    _, primary = air._lane("host")[0]
    assert bool(air.session_silent_frames(primary, 200)[85]) is True


def test_abutting_aliases_keep_explicit_source_transcript_boundaries(tmp_path):
    project, first, alias, _ = _project(tmp_path)
    primary = Placement("host", None, first, 0, 1, 0)
    same_source = Placement("host", None, alias, 1, 2, 1)
    distinct_source = Placement("host", "alias", alias, 1, 2, 1)
    assert primary.abuts(same_source) is True
    assert primary.abuts(distinct_source) is False
    project.clips[0].source_end = 1
    project.clips[1].source_start = 1
    project.clips[1].timeline_start = 1
    placements = lane_placements(project, project.tracks[0])
    assert [(p.source_id, p.tl_start, p.tl_end) for p in placements] == [
        (None, 0, 1),
        ("alias", 1, 2),
    ]
