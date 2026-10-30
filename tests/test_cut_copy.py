from __future__ import annotations

import copy
import typing
from typing import Any

import pytest
from pydantic import BaseModel

from cut_copy_fields import SHARED_FIELDS
from podcast_mcp.edits.cut_application import _SECTION_COPIES, _cut_copy
from podcast_mcp.models import (
    AppliedEditRecord,
    ArchivedTranscriptWord,
    ChapterMarker,
    Clip,
    EditDecision,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    TimelineComment,
    Track,
    TrackRole,
)
from podcast_mcp.models.episode import (
    CombinedTranscript,
    SpeakerIngestAlignment,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.words_revision import words_revision


def _project() -> EpisodeProject:
    project = EpisodeProject.create("t", "/tmp/t")
    project.transcript_data.per_track.append(
        Transcript(track_id="a", words=[TranscriptWord(text="hi", start=0.0, end=0.5)])
    )
    return project


def test_cut_copy_keeps_the_word_objects_and_copies_the_rest():
    project = _project()
    copy = _cut_copy(project)
    assert copy == project
    assert copy.transcripts[0] is not project.transcripts[0]
    assert copy.transcripts[0].words is not project.transcripts[0].words
    assert copy.transcripts[0].words[0] is project.transcripts[0].words[0]
    copy.transcripts[0].words.clear()
    copy.meta.name = "other"
    assert len(project.transcripts[0].words) == 1
    assert project.meta.name == "t"


def populated() -> EpisodeProject:
    """Every top-level section holds something, so an aliased one shows as the same object."""
    project = EpisodeProject.create("t", "/tmp/t")
    media = MediaAsset(path="raw/a.wav", duration_sec=9, sample_rate=16_000, channels=1)
    project.sources = [SourceRecording(id="src", path="raw/a.wav", duration_sec=9)]
    project.tracks = [Track(id="a", label="A", role=TrackRole.DIALOGUE, media=media)]
    project.clips = [Clip(id="c1", track_id="a", source_start=0, source_end=9, timeline_start=0)]
    project.timeline.duration_sec = 9
    words = [TranscriptWord(text=f"w{i}", start=i, end=i + 0.5) for i in range(3)]
    transcript = Transcript(track_id="a", words=words)
    transcript.archived_words = [
        ArchivedTranscriptWord(ordinal=3, word=TranscriptWord(text="old", start=8, end=8.5))
    ]
    project.transcripts = [transcript]
    project.combined_transcript = CombinedTranscript(utterances=[])
    project.edit_decisions = [
        EditDecision(id="e1", track_id="a", start=1, end=2, applied=False),
        EditDecision(id="e2", track_id="a", start=4, end=5, applied=False),
    ]
    project.editorial.edit_log = [
        AppliedEditRecord(id="alog_1", applied_at="2026-01-01T00:00:00+00:00", operation="x")
    ]
    project.chapters = [ChapterMarker(time=1, title="One")]
    project.comments = [
        TimelineComment(
            id="k1", body="b", author="me", created_at="2026-01-01T00:00:00+00:00", timeline_start=1
        )
    ]
    project.meta.ingest_alignment = {"a:c1": SpeakerIngestAlignment(align_method="manual")}
    return project


# One verdict per section a project holds. "shared": the copy holds the original object.
# "list": a new list or dict of the original items. "items": a new container of new shallow
# copies. "deep": a new container of deep copies. "scalar": a value. "shell": a new model
# whose own fields are in the nested table. A new field fails the key checks below until a
# row says what the cut may write.
TOP: dict[str, str] = {
    "version": "scalar",
    "meta": "shell",
    "sources": "shared",
    "timeline": "shell",
    "editorial": "shell",
    "transcript_data": "shell",
    "mix": "shared",
    "render": "shared",
    "social": "shared",
    "feed": "shared",
    "review": "shell",
    "history": "shared",
    "document_sync": "shared",
}
NESTED: dict[str, dict[str, str]] = {
    "meta": {
        "name": "scalar",
        "workspace_dir": "scalar",
        "created_at": "scalar",
        "schema_id": "scalar",
        "ingest_alignment": "list",
        "analysis_reads_first_audio_stream": "scalar",
    },
    "timeline": {"duration_sec": "scalar", "tracks": "deep", "clips": "deep"},
    "editorial": {
        "edit_decisions": "items",
        "edit_log": "list",
        "chapters": "list",
        "retained_bleed_alignments": "shared",
        "sound_actions": "shared",
        "speaker_splits": "shared",
        "record_sessions": "shared",
        "session_suggestions": "shared",
    },
    "transcript_data": {"per_track": "items", "combined": "shared"},
    "review": {"comments": "list", "versions": "shared", "active_version_id": "scalar"},
}


def _members(value: Any) -> list[Any]:
    return list(value.values()) if isinstance(value, dict) else list(value)


def _check(verdict: str, original: Any, made: Any, where: str) -> None:
    if verdict == "scalar":
        assert made == original, where
    elif verdict == "shared":
        assert made is original, f"{where} must be shared by reference"
    else:
        assert made is not original, f"{where} must not alias the original container"
        assert made == original, where
        pairs = list(zip(_members(original), _members(made), strict=True))
        assert pairs, f"{where} is empty in the fixture, so it proves nothing"
        for before, after in pairs:
            if verdict == "list":
                assert after is before, f"{where} items are shared"
            else:
                assert after is not before, f"{where} items are copies"


def test_every_project_section_has_a_copy_verdict():
    assert set(_SECTION_COPIES) == set(EpisodeProject.model_fields) == set(TOP), (
        "a project section was added or removed: decide in TOP (and _cut_copy) whether a cut "
        "may write it before it is shared or copied"
    )
    for name, verdicts in NESTED.items():
        model = type(getattr(EpisodeProject.create("t", "/tmp/t"), name))
        assert set(verdicts) == set(model.model_fields), (
            f"{model.__name__} gained or lost a field: decide in NESTED (and _cut_copy) "
            "whether a cut may write it"
        )
    assert set(TOP.values()) <= {"scalar", "shared", "shell"}
    assert set(TOP) >= set(NESTED)
    assert {name for name, v in TOP.items() if v == "shell"} == set(NESTED)


def test_cut_copy_shares_what_a_cut_never_writes_and_copies_what_it_does():
    project = populated()
    made = _cut_copy(project)

    assert made == project
    assert made is not project
    for name, verdict in TOP.items():
        original, copied = getattr(project, name), getattr(made, name)
        if verdict == "shell":
            assert copied is not original, name
            for field, nested in NESTED[name].items():
                _check(nested, getattr(original, field), getattr(copied, field), f"{name}.{field}")
        else:
            _check(verdict, original, copied, name)


def test_cut_copy_gives_each_transcript_its_own_word_and_archive_lists_over_shared_words():
    project = populated()
    made = _cut_copy(project)

    original, copied = project.transcripts[0], made.transcripts[0]
    assert copied is not original
    assert copied.words is not original.words
    assert copied.archived_words is not original.archived_words
    assert all(a is b for a, b in zip(copied.words, original.words, strict=True))
    assert all(a is b for a, b in zip(copied.archived_words, original.archived_words, strict=True))


def test_cut_copy_does_not_move_the_words_revision():
    project = populated()
    before = words_revision()
    _cut_copy(project)
    assert words_revision() == before


def test_cut_copy_writes_stay_off_the_original():
    project = populated()
    snapshot = project.model_dump_json()
    made = _cut_copy(project)

    made.clips[0].timeline_start = 3.0
    made.tracks[0].timeline_empty = True
    made.timeline.duration_sec = 1.0
    made.edit_decisions[0].replace_gap_sec = 0.4
    made.edit_decisions.pop()
    made.editorial.edit_log.append(
        AppliedEditRecord(id="alog_2", applied_at="2026-01-01T00:00:00+00:00", operation="y")
    )
    made.chapters = []
    made.comments.clear()
    made.meta.ingest_alignment["a:new"] = SpeakerIngestAlignment()
    made.transcripts[0].words.pop()
    made.transcripts[0].archived_words.clear()
    made.transcripts.clear()
    made.combined_transcript = None

    assert project.model_dump_json() == snapshot


@pytest.mark.parametrize("section", ["clips", "tracks"])
def test_cut_copy_deep_copies_the_timeline_objects_a_cut_edits_in_place(section):
    project = populated()
    made = _cut_copy(project)
    assert all(
        a is not b for a, b in zip(getattr(made, section), getattr(project, section), strict=True)
    )


def _models_in(annotation: Any) -> list[type[BaseModel]]:
    found = (
        [annotation] if isinstance(annotation, type) and issubclass(annotation, BaseModel) else []
    )
    for arg in typing.get_args(annotation):
        found += _models_in(arg)
    return found


def shared_field_names() -> set[str]:
    """``Model.field`` for every model a cut can reach through a section it shares.

    That is the shared sections, the items of the lists the copy only re-containers, the
    nested models of a shallow-copied decision, and the words a transcript holds.
    """
    roots: list[type[BaseModel]] = []
    for name, verdict in TOP.items():
        if verdict == "shared":
            roots += _models_in(EpisodeProject.model_fields[name].annotation)
    sections = {
        "meta": type(EpisodeProject.create("t", "/tmp/t").meta),
        "editorial": type(EpisodeProject.create("t", "/tmp/t").editorial),
        "transcript_data": type(EpisodeProject.create("t", "/tmp/t").transcript_data),
        "review": type(EpisodeProject.create("t", "/tmp/t").review),
    }
    for name, model in sections.items():
        for field, verdict in NESTED[name].items():
            if verdict in {"shared", "list", "items"}:
                roots += [
                    m
                    for m in _models_in(model.model_fields[field].annotation)
                    if m is not EditDecision
                ]
    roots += [
        model
        for field in EditDecision.model_fields.values()
        for model in _models_in(field.annotation)
    ]
    roots += [TranscriptWord, ArchivedTranscriptWord]
    names: set[str] = set()
    seen: set[type[BaseModel]] = set()
    while roots:
        model = roots.pop()
        if model in seen:
            continue
        seen.add(model)
        names |= {f"{model.__name__}.{field}" for field in model.model_fields}
        for field in model.model_fields.values():
            roots += _models_in(field.annotation)
    return names


def test_a_new_field_inside_a_shared_section_needs_a_verdict():
    listed = {
        f"{model}.{field}" for model, fields in SHARED_FIELDS.items() for field in fields.split()
    }
    assert shared_field_names() == listed, (
        "a model reachable through a section _cut_copy shares gained or lost a field: if a source "
        "cut can write it, copy it in _SECTION_COPIES; otherwise add it to SHARED_FIELDS"
    )


@pytest.mark.parametrize("make", [lambda: EpisodeProject.create("t", "/tmp/t"), populated])
def test_cut_copy_leaves_which_fields_were_set_as_they_were(make):
    project = make()
    made = _cut_copy(project)
    assert made.model_dump(exclude_unset=True) == project.model_dump(exclude_unset=True)
    assert made.model_dump(exclude_unset=True) == copy.deepcopy(project).model_dump(
        exclude_unset=True
    )
    assert made.__pydantic_fields_set__ == project.__pydantic_fields_set__
    assert made.transcript_data.__pydantic_fields_set__ == (
        project.transcript_data.__pydantic_fields_set__
    )
