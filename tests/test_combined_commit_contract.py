"""Pin ``combined_transcript`` after each command that can rewrite it (#1849 S0).

Characterization only: every expectation is what unmodified ``develop`` does, measured by
running the command (``tests/combined_contract_helpers.py::observe``), not what the design
wants. Each command runs through its real entry point from three entry states.

* ``fresh``: combined equals ``merge_transcripts`` of the project.
* ``stale``: combined deliberately differs from the merge (a pipeline that paused at a gate,
  a legacy file, a canned seed).
* ``none``: combined is ``None`` and, for a command that works without words, the project has
  no transcripts at all. A command that edits words keeps its transcripts here, with a ``None``
  combined, because it cannot run without them.

For each, the stored value must agree in memory, in ``episode.sharecut``, in
``transcripts/combined.json``, in the after-history snapshot, and after undo then redo.

Two quirks of today's behavior are named in the ids, because the refactor must either keep or
knowingly change them:

* ``h1`` (normalizing rebuild): a command that moved no merge input still calls
  ``rebuild_combined``, which refreshes a stale combined and turns ``None`` into an empty
  transcript.
* ``h2`` (never rebuilds): a command that changes words but never calls ``rebuild_combined``
  leaves a stale or ``None`` combined as it was.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from combined_contract_helpers import (
    FRESH_TEXTS,
    Observed,
    Outcome,
    State,
    json_of,
    observe,
    open_workspace,
    texts,
)
from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.models import CombinedTranscript
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, TranscriptService

Command = Callable[[ProjectWorkspace], Any]

REBUILT, UNTOUCHED = Outcome.REBUILT, Outcome.UNTOUCHED


@dataclass(frozen=True)
class Case:
    """One command family: how to run it and what it leaves in each entry state."""

    name: str
    run: Command
    texts: tuple[str, ...]
    """The combined utterance texts after the command, from a ``fresh`` or ``stale`` entry."""
    stale: Outcome = REBUILT
    none: Outcome = REBUILT
    quirk: str = ""
    """``h1`` or ``h2`` when the outcome is one of the two named quirks of today's behavior."""
    words: bool = True
    """False when the command works on a project with no transcripts at all."""

    def id_for(self, state: State) -> str:
        outcome = {State.FRESH: REBUILT, State.STALE: self.stale, State.NONE: self.none}[state]
        quirk = f"-{self.quirk}" if self.quirk and state is not State.FRESH else ""
        return f"{self.name}-{state}-{outcome}{quirk}"


def _word_key(track_id: str, index: int) -> dict[str, Any]:
    return {"track_id": track_id, "word_index": index}


def _set_timing(ws: ProjectWorkspace) -> Any:
    target = WordTimingTarget("host", None, 1)
    service = TranscriptService(ws)
    token = service.word_timing_context(target)["expected_token"]
    return service.set_word_timing(target, token, 0.55, 0.95)


def _replace(ws: ProjectWorkspace) -> Any:
    service = TranscriptService(ws)
    token = service.preview_transcript_replacement("welcome", "greetings")["preview_token"]
    return service.replace_transcript_matches("welcome", "greetings", token)


WORD_CASES = [
    Case(
        "correct_word",
        lambda ws: TranscriptService(ws).correct_word("host", 0, "HELLO"),
        ("HELLO there friend", "welcome back", "thanks for having me"),
    ),
    Case(
        "correct_phrase",
        lambda ws: TranscriptService(ws).correct_phrase("host", 3, 4, "good day"),
        ("hello there friend", "good day", "thanks for having me"),
    ),
    Case(
        "suppress_word",
        lambda ws: TranscriptService(ws).set_word_suppressed("guest", 3, True),
        ("hello there friend", "welcome back", "thanks for having"),
    ),
    Case(
        "transcript_cleanup",
        lambda ws: TranscriptService(ws).apply_transcript_cleanup(
            "host", words=[{"word_index": 1, "text": "THERE"}]
        ),
        ("hello THERE friend", "welcome back", "thanks for having me"),
    ),
    Case(
        "word_timing",
        _set_timing,
        FRESH_TEXTS,
    ),
    Case(
        "replace_matches",
        _replace,
        ("hello there friend", "greetings back", "thanks for having me"),
    ),
    Case(
        "suppress_low_audibility_keys",
        lambda ws: AnalysisService(ws).suppress_low_audibility(word_keys=[_word_key("guest", 0)]),
        ("hello there friend", "welcome back", "for having me"),
    ),
    Case(
        "suppress_bleed_keys",
        lambda ws: AnalysisService(ws).suppress_bleed(word_keys=[_word_key("guest", 1)]),
        ("hello there friend", "welcome back", "thanks having me"),
    ),
    Case(
        "set_words_ignored",
        lambda ws: TranscriptService(ws).set_words_ignored("guest", 3, 3, True),
        FRESH_TEXTS,
        stale=UNTOUCHED,
        none=UNTOUCHED,
        quirk="h2",
    ),
]

ALL_CASES = [*WORD_CASES]


def _params(cases: list[Case]) -> list[Any]:
    return [pytest.param(case, state, id=case.id_for(state)) for case in cases for state in State]


def _entry_state(case: Case, state: State) -> dict[str, Any]:
    return {"with_words": case.words}


def _run(case: Case, state: State, tmp_path: Path, wav: Path) -> Observed:
    ws = open_workspace(tmp_path / "ep", wav, state, **_entry_state(case, state))
    return observe(ws, case.run)


def _expected(case: Case, state: State, seen: Observed) -> CombinedTranscript | None:
    outcome = {State.FRESH: REBUILT, State.STALE: case.stale, State.NONE: case.none}[state]
    return seen.expected_rebuilt if outcome is REBUILT else seen.entry


def _expected_texts(case: Case, state: State) -> tuple[str, ...] | None:
    if state is State.NONE and not case.words:
        return ()
    return case.texts


def assert_contract(case: Case, state: State, seen: Observed) -> None:
    expect = _expected(case, state, seen)
    outcome = {State.FRESH: REBUILT, State.STALE: case.stale, State.NONE: case.none}[state]
    if outcome is REBUILT:
        assert texts(seen.memory) == _expected_texts(case, state)
    assert seen.memory == expect
    assert seen.saved == expect
    assert seen.snapshot == expect
    # combined.json is written only for a non-empty combined and never removed.
    has_utterances = expect is not None and bool(expect.utterances)
    assert seen.combined_json == (json_of(expect) if has_utterances else seen.entry_json)
    if seen.moved:
        assert seen.undo_memory == seen.entry
        assert seen.undo_saved == seen.entry
        assert seen.redo_memory == expect
        assert seen.redo_saved == expect
        assert seen.redo_json == seen.combined_json


@pytest.mark.parametrize(("case", "state"), _params(ALL_CASES))
def test_combined_after_command(
    case: Case, state: State, tmp_path: Path, ten_second_silence_wav: Path
) -> None:
    assert_contract(case, state, _run(case, state, tmp_path, ten_second_silence_wav))
