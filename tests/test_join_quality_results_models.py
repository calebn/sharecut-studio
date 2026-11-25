from __future__ import annotations

import pytest
from pydantic import ValidationError

from join_quality_fixtures import report_dict, row_dict, sweep_dict
from podcast_mcp.services.document.join_quality_results import (
    JoinDetectorRow,
    JoinQualityReport,
    JoinQualityRow,
    JoinQualitySweep,
    JoinRankerVerdict,
)

pytestmark = pytest.mark.unscoped_ok


def test_report_key_order_matches_the_engine():
    out = JoinQualityReport.model_validate(report_dict()).model_dump(mode="json")
    assert list(out) == list(report_dict())


def test_row_key_order_appends_gap_and_speech():
    out = JoinQualityRow.model_validate(row_dict()).model_dump(mode="json")
    assert list(out) == [*report_dict(), "source_gap_sec", "speech"]


def test_sweep_key_order():
    out = JoinQualitySweep.model_validate(sweep_dict()).model_dump(mode="json")
    assert list(out) == list(sweep_dict())


def test_null_ranker_and_natural_p95_keys_are_kept():
    out = JoinQualityReport.model_validate(report_dict()).model_dump(mode="json")
    assert out["ranker"] is None
    assert out["natural_p95"] is None


def test_ranker_and_detector_rows_round_trip():
    ranker = {"available": True, "fail_proba": 0.4, "threshold": 0.5, "n_train": 12}
    det = {"name": "click", "score": 0.2, "weight": 1.0, "detail": {"k": 1}}
    out = JoinQualityReport.model_validate(
        report_dict(ranker=ranker, detectors=[det], natural_p95=0.3)
    ).model_dump(mode="json")
    assert out["ranker"] == ranker
    assert out["detectors"] == [det]
    assert list(out["ranker"]) == list(ranker)
    assert list(out["detectors"][0]) == list(det)


@pytest.mark.parametrize(
    "model, data",
    [
        (JoinQualityReport, report_dict(extra=1)),
        (JoinQualityRow, row_dict(extra=1)),
        (JoinQualitySweep, sweep_dict(extra=1)),
        (JoinDetectorRow, {"name": "a", "score": 0.0, "weight": 1.0, "detail": {}, "x": 1}),
        (
            JoinRankerVerdict,
            {"available": True, "fail_proba": 0.1, "threshold": 0.5, "n_train": 1, "x": 1},
        ),
    ],
)
def test_extra_keys_are_rejected(model, data):
    with pytest.raises(ValidationError):
        model.model_validate(data)


def test_models_are_frozen():
    rep = JoinQualityReport.model_validate(report_dict())
    with pytest.raises(ValidationError):
        rep.risk = 0.5


def test_worst_row_equals_a_joins_row():
    r = row_dict(verdict="fail", risk=0.9)
    sw = JoinQualitySweep.model_validate(sweep_dict(join_count=1, fail_count=1, worst=r, joins=[r]))
    assert sw.worst == sw.joins[0]
    dumped = sw.model_dump(mode="json")
    assert dumped["worst"] == dumped["joins"][0]


@pytest.mark.parametrize(
    "field, value",
    [("verdict", "error"), ("mode", "other"), ("timebase", "clock")],
)
def test_literals_reject_other_values(field, value):
    with pytest.raises(ValidationError):
        JoinQualityReport.model_validate(report_dict(**{field: value}))
