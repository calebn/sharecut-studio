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
from podcast_mcp.models import (
    ArchivedTranscriptWord,
    Clip,
    CombinedTranscript,
    EditMode,
    EpisodeProject,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    AnalysisService,
    EditService,
    TimelineService,
    TranscriptService,
)
from podcast_mcp.services.document.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)

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
    arrange: Callable[[EpisodeProject], None] | None = None
    """Reshapes the entry project before it is saved."""

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


def _split_host(project: EpisodeProject) -> None:
    """Host lane as two adjoining clips, so a join can roll."""
    project.timeline.clips = [
        Clip(id="host-l", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="host-r", track_id="host", source_start=5.0, source_end=10.0, timeline_start=5.0),
        *(c for c in project.timeline.clips if c.track_id != "host"),
    ]


def _without_transcripts(project: EpisodeProject) -> None:
    project.transcripts = []


def _trim_out(source_sec: float, mode: EditMode) -> Command:
    def run(ws: ProjectWorkspace) -> Any:
        target = TrimBoundaryTarget(clip_id="host-1", edge="out", mode=mode)
        token = boundary_context(ws.project, target, defaults=ws.effective_config()).token
        return TimelineService(ws).trim_clip_edge(
            "host-1", "out", source_sec, mode=mode, expected_token=token
        )

    return run


def _guest_never_speaks(project: EpisodeProject) -> None:
    """A ripple cut asks before it cuts another lane's speech, so the guest has none."""
    project.transcripts[1].words = []


def _host_ends_before_welcome(project: EpisodeProject) -> None:
    """The host clip stops at 3.0 s and its last two words sit in the archive."""
    host = project.transcripts[0]
    archived = [
        ArchivedTranscriptWord(ordinal=3 + i, word=word) for i, word in enumerate(host.words[3:])
    ]
    host.archived_words = archived
    host.words = host.words[:3]
    project.timeline.clips[0].source_end = 3.0


def _roll(ws: ProjectWorkspace) -> Any:
    target = RollBoundaryTarget(left_clip_id="host-l", right_clip_id="host-r")
    token = boundary_context(ws.project, target, defaults=ws.effective_config()).token
    return TimelineService(ws).roll_clip_join("host-l", "host-r", 0.5, expected_token=token)


def _paste(ws: ProjectWorkspace) -> Any:
    service = TimelineService(ws)
    clipboard = service.copy_segment(1.0, 2.0, ["host"])
    return service.paste_segment(
        6.0, clipboard["duration"], clipboard["extracts"], mode=EditMode.RIPPLE
    )


TIMELINE_CASES = [
    Case(
        "ripple_delete_words",
        lambda ws: EditService(ws).cut_range(
            3.0, 4.0, mode=EditMode.RIPPLE, track_ids=["host"], use_inaudible_opt=False
        ),
        ("hello there friend", "thanks for having me"),
    ),
    Case(
        "gap_delete_words",
        lambda ws: EditService(ws).cut_range(
            3.0, 4.0, mode=EditMode.GAP, track_ids=["host"], use_inaudible_opt=False
        ),
        ("hello there friend", "thanks for having me"),
    ),
    Case(
        "gap_delete_lane_without_transcript",
        lambda ws: EditService(ws).cut_range(
            7.0, 8.0, mode=EditMode.GAP, track_ids=["host"], use_inaudible_opt=False
        ),
        (),
        arrange=_without_transcripts,
        quirk="h1",
    ),
    Case(
        "insert_gap",
        lambda ws: TimelineService(ws).insert_gap(2.0, 1.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case(
        "move_segment",
        lambda ws: TimelineService(ws).move_segment(1.0, 2.0, 6.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case(
        "duplicate_segment",
        lambda ws: TimelineService(ws).duplicate_segment(1.0, 2.0, 4.0),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case("paste_segment", _paste, FRESH_TEXTS, quirk="h1", words=False),
    Case(
        "trim_clip_edge_ripple_keeps_words",
        _trim_out(2.0, EditMode.RIPPLE),
        ("hello there friend", "welcome back"),
        arrange=_guest_never_speaks,
        quirk="h1",
    ),
    Case(
        "trim_clip_edge_gap_restores_words",
        _trim_out(4.0, EditMode.GAP),
        FRESH_TEXTS,
        arrange=_host_ends_before_welcome,
    ),
    Case(
        "move_clips",
        lambda ws: TimelineService(ws).move_clips(
            [{"clip_id": "guest-1", "track_id": "guest", "timeline_start": 1.0}]
        ),
        FRESH_TEXTS,
        quirk="h1",
        words=False,
    ),
    Case("roll_clip_join", _roll, FRESH_TEXTS, quirk="h1", words=False, arrange=_split_host),
]

ALL_CASES = [*WORD_CASES, *TIMELINE_CASES]


def _params(cases: list[Case]) -> list[Any]:
    return [pytest.param(case, state, id=case.id_for(state)) for case in cases for state in State]


def _run(case: Case, state: State, tmp_path: Path, wav: Path) -> Observed:
    ws = open_workspace(tmp_path / "ep", wav, state, with_words=case.words, arrange=case.arrange)
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
