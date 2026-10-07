"""Removed source words remain previewable and return with restored audio."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.timeline_ops import (
    punch_delete,
    roll_clip_join,
)
from podcast_mcp.edits.transcript_sync import (
    apply_source_transcript_removes,
    restore_archived_words,
)
from podcast_mcp.gui.mapper import map_edit_boundaries
from podcast_mcp.models import (
    Clip,
    EditMode,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService, TrimBoundaryTarget
from ripple_helpers import ripple_cut, ripple_cut_spans, trim


def _episode(path, *, word: TranscriptWord | None = None):
    project = ProjectWorkspace.open(path).project
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(id="full", track_id="host", source_start=0, source_end=30, timeline_start=0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[word or TranscriptWord(text="cut", start=8, end=9)],
        )
    ]
    return project


def test_archive_defaults_empty_and_rejects_negative_ordinal():
    assert Transcript.model_validate({"track_id": "host", "words": []}).archived_words == []
    with pytest.raises(ValidationError):
        Transcript.model_validate(
            {
                "track_id": "host",
                "words": [],
                "archived_words": [{"ordinal": -1, "word": {"text": "cut", "start": 8, "end": 9}}],
            }
        )


def test_archive_preserves_word_metadata_across_save_and_restoration(minimal_project):
    original = TranscriptWord(
        text="cut",
        start=8,
        end=9,
        confidence=0.37,
        suppressed=True,
        audibility_status="review",
        dominant_track="guest",
        ignored=True,
        audibility_locked=True,
    )
    project = _episode(minimal_project, word=original)
    ripple_cut(project, 5, 15, use_inaudible_opt=False)
    assert project.transcripts[0].words == []
    assert project.transcripts[0].archived_words[0].word.model_dump() == original.model_dump()
    save_project(project, minimal_project)

    loaded = load_project(minimal_project)
    (join,) = map_edit_boundaries(loaded)
    assert join["cutaway_word_ids"][0]["word_index"] < 0
    trim(loaded, join["right_clip_id"], "in", 5)
    assert [w.model_dump() for w in loaded.transcripts[0].words] == [original.model_dump()]
    assert loaded.transcripts[0].archived_words == []
    ripple_cut(loaded, 6, 10, use_inaudible_opt=False)
    assert len(loaded.transcripts[0].archived_words) == 1


def test_partial_source_exposure_does_not_restore_word(minimal_project):
    project = _episode(minimal_project, word=TranscriptWord(text="partial", start=7.5, end=9.5))
    ripple_cut(project, 8, 9, use_inaudible_opt=False)
    assert [entry.word.text for entry in project.transcripts[0].archived_words] == ["partial"]
    (join,) = map_edit_boundaries(project)
    trim(project, join["right_clip_id"], "in", 8.5)
    assert project.transcripts[0].words == []
    assert len(project.transcripts[0].archived_words) == 1
    trim(project, join["right_clip_id"], "in", 8)
    assert [w.text for w in project.transcripts[0].words] == ["partial"]


def test_zero_length_word_needs_its_padded_source_span(minimal_project):
    project = _episode(minimal_project, word=TranscriptWord(text="point", start=8.1, end=8.1))
    ripple_cut(project, 8, 9, use_inaudible_opt=False)
    (join,) = map_edit_boundaries(project)
    trim(project, join["right_clip_id"], "in", 8.1005)
    assert project.transcripts[0].words == []
    trim(project, join["right_clip_id"], "in", 8.1)
    assert [w.text for w in project.transcripts[0].words] == ["point"]


def test_restore_preserves_equal_start_order_across_repeated_cuts(minimal_project):
    project = _episode(minimal_project)
    project.transcripts[0].words = [
        TranscriptWord(text="first", start=8, end=8.2),
        TranscriptWord(text="second", start=8, end=9),
        TranscriptWord(text="third", start=8, end=8.3),
        TranscriptWord(text="fourth", start=8, end=9.5),
    ]
    apply_source_transcript_removes(project, {"host": [(8.5, 9)]}, rebuild=False)
    apply_source_transcript_removes(project, {"host": [(8.25, 8.3)]}, rebuild=False)
    assert [entry.ordinal for entry in project.transcripts[0].archived_words] == [1, 3, 2]
    restore_archived_words(project, {"host"})
    assert [w.text for w in project.transcripts[0].words] == [
        "first",
        "second",
        "third",
        "fourth",
    ]


def test_restore_uses_source_time_after_active_token_count_changes(minimal_project):
    project = _episode(minimal_project)
    project.transcripts[0].words = [
        TranscriptWord(text="before", start=2, end=3),
        TranscriptWord(text="cut", start=8, end=9),
        TranscriptWord(text="after", start=18, end=19),
    ]
    apply_source_transcript_removes(project, {"host": [(5, 15)]}, rebuild=False)
    project.transcripts[0].words[0:1] = [
        TranscriptWord(text="one", start=2, end=2.2),
        TranscriptWord(text="two", start=2.2, end=2.5),
        TranscriptWord(text="three", start=2.5, end=3),
    ]
    restore_archived_words(project, {"host"})
    assert [w.text for w in project.transcripts[0].words] == [
        "one",
        "two",
        "three",
        "cut",
        "after",
    ]


def test_roll_restores_full_word_from_cutaway(minimal_project):
    project = _episode(minimal_project)
    ripple_cut(project, 5, 15, use_inaudible_opt=False)
    (join,) = map_edit_boundaries(project)
    roll_clip_join(project, join["left_clip_id"], join["right_clip_id"], 4)
    assert [w.text for w in project.transcripts[0].words] == ["cut"]
    assert project.transcripts[0].archived_words == []


@pytest.mark.parametrize("operation", ["ripple", "batch", "punch"])
def test_cut_maps_each_recording_separately(minimal_project, operation):
    project = _episode(minimal_project)
    project.sources = [
        SourceRecording(id="a", path="raw/a.wav", duration_sec=10),
        SourceRecording(id="b", path="raw/b.wav", duration_sec=10),
    ]
    project.clips = [
        Clip(
            id="a", track_id="host", source_id="a", source_start=0, source_end=10, timeline_start=0
        ),
        Clip(
            id="b", track_id="host", source_id="b", source_start=0, source_end=10, timeline_start=10
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host", source_id="a", words=[TranscriptWord(text="a", start=8, end=9)]
        ),
        Transcript(
            track_id="host", source_id="b", words=[TranscriptWord(text="b", start=1, end=2)]
        ),
    ]
    if operation == "ripple":
        ripple_cut(project, 7, 13, use_inaudible_opt=False)
    elif operation == "batch":
        ripple_cut_spans(project, [(7, 13)], use_inaudible_opt=False)
    else:
        punch_delete(project, "host", 7, 13, use_inaudible_opt=False)
    assert [t.words for t in project.transcripts] == [[], []]
    assert [[entry.word.text for entry in t.archived_words] for t in project.transcripts] == [
        ["a"],
        ["b"],
    ]
    for join in map_edit_boundaries(project):
        assert join["cutaway_word_ids"] == []
        assert join["has_cutaway"] is False


def test_history_undo_redo_restores_archive_and_active_words(minimal_project):
    project = _episode(minimal_project)
    save_project(project, minimal_project)
    EditService(ProjectWorkspace.open(minimal_project)).cut_range(
        5, 15, use_inaudible_opt=False, mode=EditMode.RIPPLE
    )
    cut = load_project(minimal_project)
    assert cut.transcripts[0].words == []
    assert [w.word.text for w in cut.transcripts[0].archived_words] == ["cut"]
    (join,) = map_edit_boundaries(cut)
    workspace = ProjectWorkspace.open(minimal_project)
    service = EditService(workspace)
    revision = service.boundary_context(
        TrimBoundaryTarget(clip_id=join["right_clip_id"], edge="in")
    ).token
    service.trim_clip_edge(
        join["right_clip_id"], "in", 5, mode=EditMode.RIPPLE, expected_token=revision
    )
    assert [w.text for w in load_project(minimal_project).transcripts[0].words] == ["cut"]
    HistoryService(ProjectWorkspace.open(minimal_project)).undo(rerender=False)
    undone = load_project(minimal_project)
    assert undone.transcripts[0].words == []
    assert [w.word.text for w in undone.transcripts[0].archived_words] == ["cut"]
    HistoryService(ProjectWorkspace.open(minimal_project)).redo(rerender=False)
    redone = load_project(minimal_project)
    assert [w.text for w in redone.transcripts[0].words] == ["cut"]
    assert redone.transcripts[0].archived_words == []
