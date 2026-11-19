from pathlib import Path

import pytest

from podcast_mcp.gui.mapper import map_edit_boundaries
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def project_with_join(tmp_path: Path, left_source: str | None, right_source: str | None):
    project = EpisodeProject.create(name="Source identity", workspace_dir=str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30),
        )
    ]
    project.sources = [
        SourceRecording(id="primary", path="raw/host.wav", duration_sec=30),
        SourceRecording(id="other", path="raw/other.wav", duration_sec=30),
    ]
    project.clips = [
        Clip(
            id="left",
            track_id="host",
            source_id=left_source,
            source_start=0,
            source_end=5,
            timeline_start=0,
        ),
        Clip(
            id="right",
            track_id="host",
            source_id=right_source,
            source_start=15,
            source_end=20,
            timeline_start=5,
        ),
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="gone", start=8, end=8.5)])
    ]
    return project


@pytest.mark.parametrize("right_source", [None, "primary"])
def test_alias_neighbors_emit_primary_transcript_identity(tmp_path, right_source):
    project = project_with_join(tmp_path, "primary", right_source)
    assert project.transcript_for_source("host", "primary") is project.transcripts[0]
    assert project.transcript_for_source("host", right_source) is project.transcripts[0]

    (boundary,) = map_edit_boundaries(project)

    assert boundary["has_cutaway"] is True
    assert boundary["cutaway_word_ids"] == [
        {
            "track_id": "host",
            "source_id": None,
            "word_index": -1,
            "text": "gone",
            "start": 8.0,
            "end": 8.5,
        }
    ]
    assert project.clips[0].source_id == "primary"


def test_explicit_same_path_transcript_takes_precedence(tmp_path):
    project = project_with_join(tmp_path, "primary", "primary")
    explicit = Transcript(
        track_id="host",
        source_id="primary",
        words=[TranscriptWord(text="explicit", start=9, end=9.5)],
    )
    project.transcripts.append(explicit)
    assert project.transcript_for_source("host", "primary") is explicit

    (boundary,) = map_edit_boundaries(project)

    assert boundary["cutaway_word_ids"] == [
        {
            "track_id": "host",
            "source_id": "primary",
            "word_index": -1,
            "text": "explicit",
            "start": 9.0,
            "end": 9.5,
        }
    ]


def test_separate_recordings_do_not_borrow_cutaway_words(tmp_path):
    project = project_with_join(tmp_path, "primary", "other")
    other = Transcript(
        track_id="host",
        source_id="other",
        words=[TranscriptWord(text="other", start=8, end=8.5)],
    )
    project.transcripts.append(other)
    assert project.transcript_for_source("host", "primary") is project.transcripts[0]
    assert project.transcript_for_source("host", "other") is other

    (boundary,) = map_edit_boundaries(project)

    assert boundary["has_cutaway"] is False
    assert boundary["cutaway_word_ids"] == []
