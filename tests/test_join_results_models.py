from __future__ import annotations

import pytest
from pydantic import ValidationError

from join_quality_fixtures import report_dict
from podcast_mcp.services.document.join_results import JoinLabelResult, JoinTrainResult


def _label(**over):
    base = {"label": {"verdict": "pass"}, "played": False, "features": report_dict()}
    base.update(over)
    return base


def _train(**over):
    base = {"model": {"w": [1.0]}, "path": "/tmp/m.json", "n_labels": 3}
    base.update(over)
    return base


def test_label_result_roundtrip() -> None:
    out = JoinLabelResult(**_label())
    assert out.played is False
    assert out.model_dump() == _label()


def test_label_result_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        JoinLabelResult(**_label(extra=1))


@pytest.mark.parametrize("over", [{"played": "maybe"}, {"label": "x"}, {"features": [1]}])
def test_label_result_rejects_wrong_types(over) -> None:
    with pytest.raises(ValidationError):
        JoinLabelResult(**_label(**over))


def test_label_result_frozen() -> None:
    out = JoinLabelResult(**_label())
    with pytest.raises(ValidationError):
        out.played = True


def test_train_result_roundtrip() -> None:
    out = JoinTrainResult(**_train())
    assert out.n_labels == 3
    assert out.model_dump() == _train()


def test_train_result_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        JoinTrainResult(**_train(extra=1))


@pytest.mark.parametrize("over", [{"n_labels": "many"}, {"path": 5}, {"model": []}])
def test_train_result_rejects_wrong_types(over) -> None:
    with pytest.raises(ValidationError):
        JoinTrainResult(**_train(**over))


def test_train_result_frozen() -> None:
    out = JoinTrainResult(**_train())
    with pytest.raises(ValidationError):
        out.n_labels = 4
