from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

import podcast_mcp.services.document as document
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import OverlapDuplicateReport
from podcast_mcp.services.document.overlap_results import (
    OverlapPair,
    overlap_duplicate_report_result,
)
from test_overlap_duplicates_wire import AUDIBILITY_TARGET, PAIR_KEYS, _scenario_match


def _pair() -> OverlapPair:
    return OverlapPair(
        track_a="a",
        source_a=None,
        word_index_a=0,
        text_a="hi",
        start_a=0.0,
        end_a=1.0,
        status_a=None,
        track_b="b",
        source_b="take2",
        word_index_b=1,
        text_b="hi",
        start_b=0.5,
        end_b=1.5,
        session_start_a=0.0,
        session_start_b=0.5,
        status_b="bleed",
        overlap_sec=0.5,
        text_match=True,
        rms_a_db=None,
        rms_b_db=-20.0,
    )


def _report() -> OverlapDuplicateReport:
    return OverlapDuplicateReport(pair_count=1, text_match_count=1, pairs=[_pair()])


def _engine_report(root) -> dict:
    project, rows = _scenario_match(root)
    ws = ProjectWorkspace.open(project)
    with patch(AUDIBILITY_TARGET, return_value=rows):
        return overlap_duplicate_report(ws.project, defaults=ws.effective_config())


def test_models_are_frozen() -> None:
    with pytest.raises(ValidationError):
        _pair().track_a = "x"
    with pytest.raises(ValidationError):
        _report().pair_count = 3


def test_models_forbid_extra_keys() -> None:
    with pytest.raises(ValidationError):
        OverlapDuplicateReport.model_validate({**_report().model_dump(), "extra": 1})
    with pytest.raises(ValidationError):
        OverlapPair.model_validate({**_pair().model_dump(), "extra": 1})


def test_dump_keeps_the_wire_key_order() -> None:
    dumped = _report().model_dump()
    assert list(dumped) == ["pair_count", "text_match_count", "pairs"]
    assert list(dumped["pairs"][0]) == PAIR_KEYS
    assert list(OverlapPair.model_fields) == PAIR_KEYS


def test_integral_values_dump_as_floats() -> None:
    pair = _pair().model_copy(update={"start_a": 0, "rms_b_db": -20})
    assert isinstance(OverlapPair.model_validate(pair.model_dump()).rms_b_db, float)


def test_model_keys_match_a_real_engine_report(minimal_project) -> None:
    out = _engine_report(minimal_project)
    assert out["pairs"]
    assert set(out) == set(OverlapDuplicateReport.model_fields)
    for pair in out["pairs"]:
        assert list(pair) == list(OverlapPair.model_fields)
    assert overlap_duplicate_report_result(out).model_dump() == out


def test_facade_exports_the_report() -> None:
    assert document.OverlapDuplicateReport is OverlapDuplicateReport
    assert "OverlapDuplicateReport" in document.__all__
