"""Tests for join labels + numpy ranker."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.join_continuity import (
    DetectorHit,
    JoinContinuityReport,
)
from podcast_mcp.edits.join_labels import (
    export_training_table,
    load_labels,
    record_label,
)
from podcast_mcp.edits.join_ranker import (
    apply_ranker_to_report,
    save_ranker,
    train_join_ranker,
)
from podcast_mcp.models import load_project


def test_record_load_export_roundtrip(minimal_project: Path) -> None:
    project = load_project(minimal_project)
    record_label(
        project,
        track_id="host",
        join_sec=1.5,
        verdict="fail",
        features={"risk": 0.7, "detectors": {"click": 0.9}},
        note="unit",
    )
    record_label(
        project,
        track_id="host",
        join_sec=2.0,
        verdict="pass",
        features={"risk": 0.1, "detectors": {"click": 0.05}},
    )
    labels = load_labels(project)
    assert len(labels) == 2
    X, y, names = export_training_table(labels)
    assert X.shape[0] == 2
    assert "risk" in names
    assert set(y.tolist()) == {0.0, 1.0}


def test_train_ranker_fail_closed(minimal_project: Path, tmp_path: Path) -> None:
    project = load_project(minimal_project)
    for i in range(20):
        record_label(
            project,
            track_id="host",
            join_sec=float(i),
            verdict="fail" if i < 15 else "pass",
            features={
                "risk": 0.7 if i < 15 else 0.1,
                "detectors": {"click": 0.8 if i < 15 else 0.05},
            },
        )
    labels = load_labels(project)
    model = train_join_ranker(labels)
    assert model.false_pass_rate <= 0.05 + 1e-6
    out = tmp_path / "join_ranker.json"
    save_ranker(model, out)

    good = JoinContinuityReport(
        track_id="host",
        mode="t",
        join_sec=0.0,
        timebase="source",
        risk=0.1,
        invisibility=0.9,
        verdict="pass",
        reasons=[],
        detectors=[DetectorHit("click", 0.05, 1.0)],
        calibrated=False,
        natural_p95=None,
        side_sec=0.045,
        disclaimer="x",
    )
    bad = JoinContinuityReport(
        track_id="host",
        mode="t",
        join_sec=0.0,
        timebase="source",
        risk=0.7,
        invisibility=0.3,
        verdict="pass",  # wrongly pass - ranker should elevate
        reasons=[],
        detectors=[DetectorHit("click", 0.85, 1.0)],
        calibrated=False,
        natural_p95=None,
        side_sec=0.045,
        disclaimer="x",
    )
    elevated = apply_ranker_to_report(bad, model_path=out)
    assert elevated.verdict in ("review", "fail")
    assert elevated.risk >= bad.risk
    same = apply_ranker_to_report(good, model_path=out)
    # May stay pass if low proba
    assert same.risk >= good.risk
