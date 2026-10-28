"""Apply suggested actions holds a cut over an unsure word (#2518); the race in the approve guard."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

WORDS = [
    ("so", 0.5, 0.95),
    ("uncle", 3.0, 0.4),
    ("said", 3.5, 0.95),
    ("fine", 4.0, 0.95),
    ("well", 5.0, 0.69),
    ("okay", 5.5, 0.7),
]


def _fillers(*spans: tuple[str, float, float]):
    return [_cut(i, a, b, reason="filler:um", review_required=True) for i, a, b in spans]


CLEAN = ("clean", 4.0, 4.4)
UNSURE = ("uncle", 3.0, 3.2)
EDGE = ("edge", 3.3, 3.45)


def _open(tmp_path, *spans, gate=True):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=t, start=s, end=s + 0.3, confidence=c) for t, s, c in WORDS],
        )
    ]
    project.edit_decisions = _fillers(*(spans or (CLEAN, UNSURE, EDGE)))
    if gate:
        REFINE_GATE.mark_done(
            project, notes="Known synthetic transcript fixture; no real-project test"
        )
    return ProjectWorkspace.open(save_project(project))


def _steps(ws) -> int:
    return len(HistoryService(ProjectWorkspace.open(ws.path)).list_entries().entries)


def _pending(ws) -> list[str]:
    return sorted(e.id for e in load_project(ws.path).edit_decisions if not e.applied)


# --- the approve guard: a save between the check and the commit -----------------------------


def test_a_save_that_empties_the_approve_after_the_check_returns_zero_without_a_step(
    tmp_path, monkeypatch
):
    from podcast_mcp.services.document import edit as edit_module

    ws = _open(tmp_path, UNSURE, gate=False)
    real = edit_module.hold_unsure_cuts
    calls = {"n": 0}

    def late_save(project, ids, line, held):
        calls["n"] += 1
        if calls["n"] == 1:
            return ids  # the first look found the cut clean; a save lowered a word since
        return real(project, ids, line, held)

    monkeypatch.setattr(edit_module, "hold_unsure_cuts", late_save)
    held: list = []
    before, steps = ws.path.read_bytes(), _steps(ws)

    assert EditService(ws).approve(["uncle"], unsure_out=held) == 0

    assert [h.edit_id for h in held] == ["uncle"]
    assert ws.path.read_bytes() == before and _steps(ws) == steps
