from __future__ import annotations

import copy
import os
import random
import sys
import typing
from pathlib import Path

import pytest
from pydantic import BaseModel

from podcast_mcp.edits import cut_effects
from podcast_mcp.edits.cut_application import _cut_copy
from podcast_mcp.engines import session_timeline
from podcast_mcp.engines.audio import PlacedSource, SourceAudio
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    ArchivedTranscriptWord,
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.episode import TranscriptWords
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.workspace_paths import resolve_under_workspace


def _recordings(tmp_path: Path) -> list[Path]:
    root = tmp_path / "media"
    (root / "sub").mkdir(parents=True)
    first = root / "a.wav"
    first.write_bytes(b"recording")
    hardlink = root / "hardlink.wav"
    os.link(first, hardlink)
    symlink = root / "symlink.wav"
    try:
        symlink.symlink_to(first)
    except OSError:
        pytest.skip("symlinks unavailable")
    twin = root / "twin.wav"
    twin.write_bytes(b"recording")
    return [
        first,
        hardlink,
        symlink,
        twin,
        root / "sub" / ".." / "a.wav",
        root / "A.WAV",
        root / "missing.wav",
        root / "sub" / ".." / "missing.wav",
    ]


def _leaf(path: Path, index: int, *, source_id=None, is_fill=False) -> PlacedSource:
    return PlacedSource(
        SourceAudio(
            path,
            float(index),
            float(index) + 0.5,
            clip_id=f"c{index}",
            source_id=source_id,
            is_fill=is_fill,
        ),
        float(index),
        (),
    )


def _naive_matches(old, source) -> list[int]:
    return [
        index
        for index, previous in enumerate(old)
        if previous.source.source_id == source.source_id
        and previous.source.is_fill == source.is_fill
        and same_recording(previous.source.path, source.path)
    ]


def _counting(monkeypatch, module) -> list[tuple[Path, Path]]:
    calls: list[tuple[Path, Path]] = []

    def counted(first, second):
        calls.append((first, second))
        return same_recording(first, second)

    monkeypatch.setattr(module, "same_recording", counted)
    return calls


@pytest.mark.parametrize("seed", range(6))
def test_leaf_matching_equals_the_all_pairs_scan(tmp_path, seed):
    paths = _recordings(tmp_path)
    rng = random.Random(seed)
    kinds = [(None, False), (None, True), ("b", False), ("b", True)]

    def random_leaf(index: int) -> PlacedSource:
        source_id, is_fill = rng.choice(kinds)
        return _leaf(rng.choice(paths), index, source_id=source_id, is_fill=is_fill)

    old = [random_leaf(i) for i in range(60)]
    matching = cut_effects._same_recording_leaves(old)
    for query in (random_leaf(100 + i).source for i in range(60)):
        assert matching(query) == _naive_matches(old, query)


def test_leaf_matching_keeps_alias_semantics_of_same_recording(tmp_path):
    first, hardlink, symlink, twin, dotted, cased, missing, dotted_missing = _recordings(tmp_path)
    old = [_leaf(path, i) for i, path in enumerate([hardlink, symlink, twin, missing, cased])]
    matching = cut_effects._same_recording_leaves(old)

    assert matching(_leaf(first, 9).source) == _naive_matches(old, _leaf(first, 9).source)
    assert matching(_leaf(dotted, 9).source) == _naive_matches(old, _leaf(dotted, 9).source)
    assert {0, 1} <= set(matching(_leaf(first, 9).source))
    assert 2 not in matching(_leaf(first, 9).source)
    assert matching(_leaf(dotted_missing, 9).source) == [3]
    assert matching(_leaf(cased, 9).source) == _naive_matches(old, _leaf(cased, 9).source)


def test_leaf_matching_compares_each_group_path_pair_once(tmp_path, monkeypatch):
    first, hardlink, _, twin, *_ = _recordings(tmp_path)
    calls = _counting(monkeypatch, cut_effects)
    old = [_leaf([first, hardlink, twin][i % 3], i) for i in range(90)]
    matching = cut_effects._same_recording_leaves(old)

    for i in range(90):
        matching(_leaf([first, hardlink, twin][i % 3], 200 + i).source)

    assert len(calls) == 9
    assert len(set(calls)) == 9


def test_leaf_matching_raises_for_the_path_an_all_pairs_scan_reaches_first(tmp_path, monkeypatch):
    first, hardlink, symlink, twin, *_ = _recordings(tmp_path)

    def refuse(left, _right):
        if left in (hardlink, symlink):
            raise ValueError(f"no identity for {left.name}")
        return False

    monkeypatch.setattr(cut_effects, "same_recording", refuse)
    old = [_leaf(twin, 0), _leaf(symlink, 1), _leaf(hardlink, 2), _leaf(symlink, 3)]
    matching = cut_effects._same_recording_leaves(old)
    with pytest.raises(ValueError, match=r"symlink\.wav"):
        matching(_leaf(first, 9).source)
    with pytest.raises(ValueError, match=r"symlink\.wav"):
        for previous in old:
            cut_effects.same_recording(previous.source.path, first)


def test_leaf_matching_surfaces_identity_errors(tmp_path, monkeypatch):
    first, hardlink, *_ = _recordings(tmp_path)

    def refuse(_first, _second):
        raise ValueError("Distinct media paths have no usable physical file identity")

    monkeypatch.setattr(cut_effects, "same_recording", refuse)
    matching = cut_effects._same_recording_leaves([_leaf(first, 0)])
    with pytest.raises(ValueError, match="physical file identity"):
        matching(_leaf(hardlink, 1).source)


@pytest.mark.parametrize("count", [3, 60])
def test_before_occurrences_binds_alike_and_compares_one_pair_per_recording(
    tmp_path, monkeypatch, count
):
    path = _recordings(tmp_path)[0]
    calls = _counting(monkeypatch, cut_effects)
    old = [_leaf(path, i) for i in range(count)]
    new = [_leaf(path, i) for i in range(count)]

    bindings = cut_effects._before_occurrences(old, new, frozenset())

    assert bindings == list(range(count))
    assert len(calls) == 1


def _timeline_project(tmp_path: Path, paths: list[Path]) -> EpisodeProject:
    project = EpisodeProject.create("scan", str(tmp_path))
    project.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path=str(paths[0]))),
        Track(id="guest", label="Guest", media=MediaAsset(path=str(paths[3]))),
    ]
    project.sources = [
        SourceRecording(id=f"s{i}", path=str(path), duration_sec=4) for i, path in enumerate(paths)
    ]
    rng = random.Random(3)
    project.clips = [
        Clip(
            id=f"clip{i}",
            track_id=rng.choice(["host", "guest"]),
            source_id=rng.choice([None, *[f"s{n}" for n in range(len(paths))]]),
            source_start=0,
            source_end=1,
            timeline_start=float(i),
        )
        for i in range(48)
    ]
    return project


def _naive_recording_clips(project: EpisodeProject, track_id: str) -> list[Clip]:
    track = project.track_by_id(track_id)
    assert track is not None and track.media is not None
    media = resolve_under_workspace(project, track.media.path)
    found = []
    for clip in project.clips:
        if clip.source_id:
            source = project.source_by_id(clip.source_id)
            path = source.path if source is not None and source.path else None
        else:
            lane = project.track_by_id(clip.track_id)
            path = lane.media.path if lane is not None and lane.media is not None else None
        if not path:
            continue
        try:
            candidate = resolve_under_workspace(project, path)
        except ValueError:
            if clip.track_id == track_id:
                raise
            continue
        if same_recording(candidate, media):
            found.append(clip)
    return found


def test_recording_clips_equal_the_clip_by_clip_scan(tmp_path):
    paths = _recordings(tmp_path)[:5]
    project = _timeline_project(tmp_path, paths)
    for track_id in ("host", "guest"):
        assert [c.id for c in SessionTimeline(project)._recording_clips(track_id)] == [
            c.id for c in _naive_recording_clips(project, track_id)
        ]


def test_recording_clips_compare_each_stored_path_once(tmp_path, monkeypatch):
    paths = _recordings(tmp_path)[:5]
    project = _timeline_project(tmp_path, paths)
    calls = _counting(monkeypatch, session_timeline)

    SessionTimeline(project)._recording_clips("host")

    stored = set()
    for clip in project.clips:
        if clip.source_id:
            stored.add(project.source_by_id(clip.source_id).path)
        else:
            stored.add(project.track_by_id(clip.track_id).media.path)
    assert len(stored) > 1
    assert len(calls) == len(stored)


def test_recording_clips_skip_a_foreign_lane_path_outside_the_workspace_but_not_their_own(
    tmp_path,
):
    paths = _recordings(tmp_path)[:5]
    project = _timeline_project(tmp_path, paths)
    project.sources.append(SourceRecording(id="outside", path="../outside.wav", duration_sec=4))
    project.clips.append(
        Clip(
            id="foreign",
            track_id="guest",
            source_id="outside",
            source_start=0,
            source_end=1,
            timeline_start=90,
        )
    )
    timeline = SessionTimeline(project)
    assert [c.id for c in timeline._recording_clips("host")] == [
        c.id for c in _naive_recording_clips(project, "host")
    ]
    with pytest.raises(ValueError, match="path must be under workspace"):
        timeline._recording_clips("guest")
    with pytest.raises(ValueError, match="path must be under workspace"):
        timeline._recording_clips("guest")
    with pytest.raises(ValueError, match="path must be under workspace"):
        _naive_recording_clips(project, "guest")


def _project_with_words(count: int, archived: int = 0, *, tracked: bool = True) -> EpisodeProject:
    project = EpisodeProject.create("t", "/tmp/t")
    for track_id in ("a", "b"):
        words = [
            TranscriptWord(text=f"w{i}", start=i * 0.1, end=i * 0.1 + 0.05) for i in range(count)
        ]
        transcript = Transcript(track_id=track_id, words=words)
        if not tracked:
            transcript = transcript.model_copy(update={"words": list(words)})
        transcript.archived_words = [
            ArchivedTranscriptWord(
                ordinal=count + i, word=TranscriptWord(text=f"x{i}", start=i, end=i)
            )
            for i in range(archived)
        ]
        if archived:
            transcript.archived_words.append(
                ArchivedTranscriptWord(ordinal=count + archived, word=words[0])
            )
        project.transcript_data.per_track.append(transcript)
    return project


def _walked_copy(project: EpisodeProject) -> EpisodeProject:
    memo: dict[int, object] = {}
    for transcript in project.transcripts:
        for word in transcript.words:
            memo[id(word)] = word
        for archived in transcript.archived_words:
            memo[id(archived.word)] = archived.word
    return copy.deepcopy(project, memo)


@pytest.mark.parametrize(
    ("count", "archived", "tracked"),
    [(0, 0, True), (5, 0, True), (40, 3, True), (40, 3, False), (7, 1, False)],
)
def test_cut_copy_matches_a_word_by_word_shared_copy(count, archived, tracked):
    project = _project_with_words(count, archived, tracked=tracked)
    expected = _walked_copy(project)
    actual = _cut_copy(project)

    assert actual == expected
    assert actual.model_dump() == expected.model_dump()
    for source, made, reference in zip(
        project.transcripts, actual.transcripts, expected.transcripts, strict=True
    ):
        assert type(made.words) is type(reference.words)
        assert made.words is not source.words
        assert all(a is b for a, b in zip(made.words, source.words, strict=True))
        assert [
            a.word is b.word
            for a, b in zip(made.archived_words, source.archived_words, strict=True)
        ] == [True] * len(source.archived_words)
        assert made.archived_words is not source.archived_words
        assert all(a is b for a, b in zip(made.archived_words, source.archived_words, strict=True))
        if isinstance(made.words, TranscriptWords):
            assert made.words._memo == {}
            assert made.words._memo is not source.words._memo


def test_cut_copy_lists_are_independent_of_the_original():
    project = _project_with_words(6, 2)
    made = _cut_copy(project)
    made.transcripts[0].words.pop()
    made.transcripts[0].archived_words.pop()
    made.transcripts[1].words.append(TranscriptWord(text="new", start=9, end=9.5))
    assert len(project.transcripts[0].words) == 6
    assert len(project.transcripts[0].archived_words) == 3
    assert len(project.transcripts[1].words) == 6


def _deepcopy_calls(make) -> int:
    code = copy.deepcopy.__code__
    calls = 0

    def profiler(frame, event, _arg):
        nonlocal calls
        if event == "call" and frame.f_code is code:
            calls += 1

    sys.setprofile(profiler)
    try:
        make()
    finally:
        sys.setprofile(None)
    return calls


def test_cut_copy_visits_no_word_individually():
    small = _project_with_words(20)
    large = _project_with_words(4000)

    few = _deepcopy_calls(lambda: _cut_copy(small))

    assert few > 0
    assert _deepcopy_calls(lambda: _cut_copy(large)) == few


def test_cut_copy_runs_inside_a_batch_scope_unchanged():
    project = _project_with_words(10, 1)
    with batch_scope():
        assert _cut_copy(project) == _walked_copy(project)


def test_transcript_words_are_held_only_by_the_lists_that_cut_copy_shares():
    holders: set[str] = set()
    seen: set[type] = set()

    def mentions_word(annotation) -> bool:
        if annotation is TranscriptWord:
            return True
        return any(mentions_word(arg) for arg in typing.get_args(annotation))

    def walk(model: type[BaseModel]) -> None:
        if model in seen:
            return
        seen.add(model)
        for name, field in model.model_fields.items():
            if mentions_word(field.annotation):
                holders.add(f"{model.__name__}.{name}")

            def nested(annotation):
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    walk(annotation)
                for arg in typing.get_args(annotation):
                    nested(arg)

            nested(field.annotation)

    walk(EpisodeProject)
    assert holders == {"Transcript.words", "ArchivedTranscriptWord.word"}, (
        "a new field holds TranscriptWord objects; _cut_copy shares words only through "
        "Transcript.words and ArchivedTranscriptWord.word, so it must seed this field too"
    )
