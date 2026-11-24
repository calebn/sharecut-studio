"""Measure what a command leaves in ``combined_transcript`` on every commit path (#1849 S0).

``observe`` builds a two-speaker project in one of three entry states, runs one command through
its real entry point, and reads the stored combined transcript from each place it lives: memory,
``episode.sharecut``, ``transcripts/combined.json``, the after-history snapshot, and memory and
file again after undo and after redo. ``tests/test_combined_commit_contract.py`` pins the result.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import EPISODE_PROJECT_FILENAME
from podcast_mcp.project.store import WriteGrantKind, read_history_snapshot, write_grant
from podcast_mcp.services.app import ProjectWorkspace

HOST_WORDS = (
    ("hello", 0.0, 0.4),
    ("there", 0.5, 0.9),
    ("friend", 1.0, 1.4),
    ("welcome", 3.0, 3.4),
    ("back", 3.5, 3.9),
)
GUEST_WORDS = (
    ("thanks", 5.0, 5.4),
    ("for", 5.5, 5.8),
    ("having", 5.9, 6.3),
    ("me", 6.4, 6.7),
)
FRESH_TEXTS = ("hello there friend", "welcome back", "thanks for having me")
SOURCE_SEC = 10.0


class State(StrEnum):
    FRESH = "fresh"
    STALE = "stale"
    NONE = "none"


class Outcome(StrEnum):
    """What the command left in the stored combined transcript."""

    REBUILT = "rebuilt"
    """``merge_transcripts`` of the project after the command."""
    UNTOUCHED = "untouched"
    """Exactly the value the project held on entry (``None`` stays ``None``)."""


STALE_COMBINED = CombinedTranscript(
    utterances=[
        CombinedUtterance(
            track_id="host", speaker="Host", start=0.0, end=0.4, text="stale combined text"
        )
    ]
)


def _words(rows: tuple[tuple[str, float, float], ...]) -> list[TranscriptWord]:
    return [TranscriptWord(text=t, start=s, end=e, confidence=0.9) for t, s, e in rows]


def merged(project: EpisodeProject) -> CombinedTranscript:
    return TranscriptionEngine(defaults=load_defaults()).merge_transcripts(project)


def build_project(
    root: Path,
    wav: Path,
    state: State,
    *,
    with_words: bool = True,
    arrange: Callable[[EpisodeProject], None] | None = None,
) -> EpisodeProject:
    """Host and guest lanes of ``SOURCE_SEC`` s each, words on both, combined as ``state`` says.

    ``State.NONE`` has no combined transcript. With ``with_words=False`` it also has no
    transcripts, the case of a project whose speech was never transcribed. ``arrange`` reshapes
    the project (clips, transcripts) before the entry combined is computed.
    """
    raw = root / "raw"
    raw.mkdir(parents=True)
    for name in ("host", "guest"):
        shutil.copyfile(wav, raw / f"{name}.wav")
    project = EpisodeProject.create("contract", str(root))
    project.ensure_dirs()
    project.timeline.tracks = [
        Track(
            id=tid,
            label=speaker,
            role=TrackRole.DIALOGUE,
            speaker=speaker,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=SOURCE_SEC),
        )
        for tid, speaker in (("host", "Host"), ("guest", "Guest"))
    ]
    project.timeline.clips = [
        Clip(
            id=f"{tid}-1",
            track_id=tid,
            source_start=0.0,
            source_end=SOURCE_SEC,
            timeline_start=0.0,
        )
        for tid in ("host", "guest")
    ]
    if with_words or state is not State.NONE:
        project.transcripts = [
            Transcript(track_id="host", words=_words(HOST_WORDS)),
            Transcript(track_id="guest", words=_words(GUEST_WORDS)),
        ]
    if arrange is not None:
        arrange(project)
    project.combined_transcript = {
        State.FRESH: lambda: merged(project),
        State.STALE: lambda: STALE_COMBINED.model_copy(deep=True),
        State.NONE: lambda: None,
    }[state]()
    return project


def open_workspace(
    root: Path,
    wav: Path,
    state: State,
    *,
    with_words: bool = True,
    arrange: Callable[[EpisodeProject], None] | None = None,
    prepare: Callable[[ProjectWorkspace], object] | None = None,
) -> ProjectWorkspace:
    """A saved workspace with an ``initial`` history entry, so the next command adds one step.

    ``prepare`` is a command that must have run first (an edit to revert). It leaves its own
    combined transcript, so the entry state is set again after it.
    """
    project = build_project(root, wav, state, with_words=with_words, arrange=arrange)
    path = save_project(project, root / EPISODE_PROJECT_FILENAME)
    ws = ProjectWorkspace.open(path)
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.record_snapshot("initial", force=True)
        if prepare is not None:
            prepare(ws)
            entry = {
                State.FRESH: lambda: merged(ws.project),
                State.STALE: lambda: STALE_COMBINED.model_copy(deep=True),
                State.NONE: lambda: None,
            }[state]()
            ws.mutate("restate", "restated", lambda p: setattr(p, "combined_transcript", entry))
    return ws


def combined_json_path(ws: ProjectWorkspace) -> Path:
    return ws.project.transcripts_dir() / "combined.json"


def read_combined_json(ws: ProjectWorkspace) -> dict[str, Any] | None:
    path = combined_json_path(ws)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def saved_combined(ws: ProjectWorkspace) -> CombinedTranscript | None:
    return load_project(ws.path).combined_transcript


def head_snapshot_combined(ws: ProjectWorkspace) -> CombinedTranscript | None:
    """The combined transcript inside the history entry the saved project's cursor is on."""
    saved = load_project(ws.path)
    entry = saved.history.entries[saved.history.cursor]
    raw = read_history_snapshot(saved, entry).transcripts.get("combined")
    return None if raw is None else CombinedTranscript.model_validate(raw)


@dataclass
class Observed:
    entry: CombinedTranscript | None
    entry_json: dict[str, Any] | None
    memory: CombinedTranscript | None = None
    saved: CombinedTranscript | None = None
    combined_json: dict[str, Any] | None = None
    snapshot: CombinedTranscript | None = None
    moved: bool = False
    expected_rebuilt: CombinedTranscript | None = None
    undo_memory: CombinedTranscript | None = None
    undo_saved: CombinedTranscript | None = None
    undo_json: dict[str, Any] | None = None
    redo_memory: CombinedTranscript | None = None
    redo_saved: CombinedTranscript | None = None
    redo_json: dict[str, Any] | None = None
    result: Any = field(default=None, repr=False)


def observe(
    ws: ProjectWorkspace, command: Callable[[ProjectWorkspace], Any], *, undo_redo: bool = True
) -> Observed:
    """Run ``command`` on ``ws`` and read the combined transcript from every place it is kept."""
    seen = Observed(entry=_copy(ws.project.combined_transcript), entry_json=read_combined_json(ws))
    head_before = ws.project.history.head_id()
    with write_grant(WriteGrantKind.DISPATCHER):
        seen.result = command(ws)
    seen.memory = ws.project.combined_transcript
    seen.expected_rebuilt = merged(ws.project)
    seen.saved = saved_combined(ws)
    seen.combined_json = read_combined_json(ws)
    seen.snapshot = head_snapshot_combined(ws)
    seen.moved = ws.project.history.head_id() != head_before
    if undo_redo and seen.moved:
        with write_grant(WriteGrantKind.DISPATCHER):
            ws.undo()
        seen.undo_memory = ws.project.combined_transcript
        seen.undo_saved = saved_combined(ws)
        seen.undo_json = read_combined_json(ws)
        with write_grant(WriteGrantKind.DISPATCHER):
            ws.redo()
        seen.redo_memory = ws.project.combined_transcript
        seen.redo_saved = saved_combined(ws)
        seen.redo_json = read_combined_json(ws)
    return seen


def _copy(value: CombinedTranscript | None) -> CombinedTranscript | None:
    return None if value is None else value.model_copy(deep=True)


def json_of(value: CombinedTranscript | None) -> dict[str, Any] | None:
    return None if value is None else value.model_dump(by_alias=True, mode="json")


def texts(value: CombinedTranscript | None) -> tuple[str, ...] | None:
    return None if value is None else tuple(u.text for u in value.utterances)


Command = Callable[[ProjectWorkspace], Any]
REBUILT, UNTOUCHED = Outcome.REBUILT, Outcome.UNTOUCHED


@dataclass(frozen=True)
class Case:
    """One command family: how to run it and what it leaves in each entry state."""

    name: str
    run: Command
    texts: tuple[str, ...]
    """The combined utterance texts after the command, from a ``fresh`` or ``stale`` entry."""
    fresh: Outcome = REBUILT
    stale: Outcome = REBUILT
    none: Outcome = REBUILT
    quirk: str = ""
    """``h1`` or ``h2`` when the outcome is one of the two named quirks of today's behavior."""
    words: bool = True
    """False when the command works on a project with no transcripts at all."""
    arrange: Callable[[EpisodeProject], None] | None = None
    """Reshapes the entry project before it is saved."""
    speakers: tuple[str, ...] | None = None
    """The utterance speaker labels after the command, where the labels are what it changes."""
    prepare: Command | None = None
    """A command that runs first, so there is something for this one to undo."""
    configure: Callable[[pytest.MonkeyPatch], None] | None = None
    """Sets the run's pipeline defaults, for a command that reads them."""
    s2_changes: tuple[State, ...] = ()
    s3_changes: bool = False

    def outcome(self, state: State) -> Outcome:
        if state in self.s2_changes:
            return REBUILT
        return self.entry_outcome(state)

    def entry_outcome(self, state: State) -> Outcome:
        return {State.FRESH: self.fresh, State.STALE: self.stale, State.NONE: self.none}[state]

    def id_for(self, state: State) -> str:
        parts = [self.name, str(state), str(self.entry_outcome(state))]
        if self.quirk:
            parts.append(self.quirk)
        if state in self.s2_changes:
            parts.append("s2-changes")
        if self.s3_changes and state is State.NONE and self.entry_outcome(state) is REBUILT:
            parts.append("s3-changes")
        return "-".join(parts)


def case_params(cases: list[Case]) -> list[Any]:
    return [pytest.param(case, state, id=case.id_for(state)) for case in cases for state in State]


def run_case(
    case: Case, state: State, tmp_path: Path, wav: Path, monkeypatch: pytest.MonkeyPatch
) -> Observed:
    if case.configure is not None:
        case.configure(monkeypatch)
    ws = open_workspace(
        tmp_path / "ep",
        wav,
        state,
        with_words=case.words,
        arrange=case.arrange,
        prepare=case.prepare,
    )
    return observe(ws, case.run)


def _expected(case: Case, state: State, seen: Observed) -> CombinedTranscript | None:
    return seen.expected_rebuilt if case.outcome(state) is REBUILT else seen.entry


def _expected_texts(case: Case, state: State) -> tuple[str, ...] | None:
    if state is State.NONE and not case.words:
        return ()
    return case.texts


def assert_contract(case: Case, state: State, seen: Observed) -> None:
    expect = _expected(case, state, seen)
    assert seen.moved
    if case.outcome(state) is REBUILT:
        assert texts(seen.memory) == _expected_texts(case, state)
        if case.speakers is not None:
            assert seen.memory is not None
            assert tuple(u.speaker for u in seen.memory.utterances) == case.speakers
    assert_channels(seen, expect)


def combined_json_after(
    expect: CombinedTranscript | None, entry_json: dict[str, Any] | None
) -> dict[str, Any] | None:
    has_utterances = expect is not None and bool(expect.utterances)
    return json_of(expect) if has_utterances else entry_json


def assert_channels(seen: Observed, expect: CombinedTranscript | None) -> None:
    """``expect`` is what memory, the file, the after snapshot and a redo must all hold."""
    assert seen.memory == expect
    assert seen.saved == expect
    assert seen.snapshot == expect
    assert seen.combined_json == combined_json_after(expect, seen.entry_json)
    if seen.moved:
        assert seen.undo_memory == seen.entry
        assert seen.undo_saved == seen.entry
        assert seen.redo_memory == expect
        assert seen.redo_saved == expect
        assert seen.redo_json == seen.combined_json
