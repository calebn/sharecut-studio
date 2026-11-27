from __future__ import annotations

import json

import pytest

from podcast_mcp.gui.assembler import build_project_view
from podcast_mcp.models import EditDecisionType, Transcript, TranscriptWord, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.unscoped_ok

WORDS = [
    ("so", 0.5, 0.95),
    ("uncle", 3.0, 0.4),
    ("said", 3.5, 0.95),
    ("fine", 4.0, 0.95),
    ("well", 5.0, 0.69),
    ("okay", 5.5, 0.7),
]

UNCLE = {"track_id": "host", "source_id": None, "word_index": 1, "text": "uncle", "confidence": 0.4}
WELL = {"track_id": "host", "source_id": None, "word_index": 4, "text": "well", "confidence": 0.69}
KEYS = ["track_id", "source_id", "word_index", "text", "confidence"]


def _open(tmp_path, cuts):
    project = _project(tmp_path)
    words = [TranscriptWord(text=t, start=s, end=s + 0.3, confidence=c) for t, s, c in WORDS]
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.edit_decisions = cuts
    return ProjectWorkspace.open(save_project(project))


def _cuts():
    return [
        _cut("clean", 4.0, 4.4, review_required=True),
        _cut("uncle", 3.0, 3.2, review_required=True),
        _cut("edge", 3.3, 3.45, review_required=True),
        _cut("both", 3.0, 5.4, review_required=True),
        _cut("unknown_track", 3.0, 3.2, review_required=True).model_copy(
            update={"track_id": "nobody"}
        ),
        _cut("timeline", 3.0, 3.2, review_required=True).model_copy(
            update={"timebase": "timeline"}
        ),
        _cut("split", 3.0, 3.2, review_required=True).model_copy(
            update={"type": EditDecisionType.SPLIT}
        ),
    ]


def _service(tmp_path):
    ws = _open(tmp_path, _cuts())
    return ws, TranscriptService(ws).unsure_words_for(ws.project.edit_decisions)


def test_each_cut_gets_its_unsure_words_in_word_order(tmp_path):
    _, out = _service(tmp_path)
    assert dict(out) == {
        "clean": [],
        "uncle": [UNCLE],
        "edge": [],
        "both": [UNCLE, WELL],
        "unknown_track": [],
        "timeline": [],
        "split": [],
    }


def test_the_edit_ids_keep_the_decision_order(tmp_path):
    _, out = _service(tmp_path)
    assert list(out) == ["clean", "uncle", "edge", "both", "unknown_track", "timeline", "split"]


def test_every_word_entry_has_the_five_keys_in_order_and_plain_types(tmp_path):
    _, out = _service(tmp_path)
    entry = out["both"][1]
    assert list(entry) == KEYS
    assert type(entry["word_index"]) is int
    assert type(entry["confidence"]) is float
    assert entry["source_id"] is None


def test_the_service_text_is_stable(tmp_path):
    _, out = _service(tmp_path)
    assert json.dumps(out["both"]) == (
        '[{"track_id": "host", "source_id": null, "word_index": 1, "text": "uncle", '
        '"confidence": 0.4}, {"track_id": "host", "source_id": null, "word_index": 4, '
        '"text": "well", "confidence": 0.69}]'
    )


def test_no_decisions_gives_an_empty_mapping(tmp_path):
    ws = _open(tmp_path, [])
    assert dict(TranscriptService(ws).unsure_words_for([])) == {}


def test_a_stricter_line_drops_the_words_above_it(tmp_path):
    ws = _open(tmp_path, _cuts())
    loose = {**ws.effective_config(), "analysis": {"unsure_word_confidence": 0.5}}
    ws.effective_config = lambda: loose
    out = TranscriptService(ws).unsure_words_for(ws.project.edit_decisions)
    assert out["both"] == [UNCLE]


def test_the_project_view_rows_carry_the_same_words_and_count(tmp_path):
    ws = _open(tmp_path, _cuts())
    rows = {e["id"]: e for e in build_project_view(ws).pending_edits}
    assert rows["both"]["unsure_words"] == [UNCLE, WELL]
    assert rows["both"]["unsure_count"] == 2
    assert rows["clean"]["unsure_words"] == []
    assert rows["clean"]["unsure_count"] == 0
    assert json.dumps(rows["uncle"]["unsure_words"]) == json.dumps([UNCLE])
