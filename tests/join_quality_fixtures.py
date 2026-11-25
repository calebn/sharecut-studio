from __future__ import annotations

from typing import Any

from podcast_mcp.services.document.join_quality_results import (
    JoinQualityReport,
    JoinQualityRow,
    JoinQualitySweep,
)


def report_dict(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "track_id": "host",
        "mode": "existing_join",
        "join_sec": 1.0,
        "timebase": "timeline",
        "risk": 0.1,
        "invisibility": 0.9,
        "verdict": "pass",
        "reasons": [],
        "detectors": [],
        "calibrated": False,
        "natural_p95": None,
        "side_sec": 0.05,
        "disclaimer": "x",
        "ranker": None,
    }
    base.update(over)
    return base


def row_dict(**over: Any) -> dict[str, Any]:
    return {**report_dict(**over), "source_gap_sec": 0.0, "speech": []}


def sweep_dict(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "join_count": 0,
        "fail_count": 0,
        "review_count": 0,
        "pass_count": 0,
        "speech_cross_count": 0,
        "worst": None,
        "joins": [],
        "disclaimer": "x",
    }
    base.update(over)
    return base


def report(**over: Any) -> JoinQualityReport:
    return JoinQualityReport.model_validate(report_dict(**over))


def row(**over: Any) -> JoinQualityRow:
    return JoinQualityRow.model_validate(row_dict(**over))


def sweep(**over: Any) -> JoinQualitySweep:
    return JoinQualitySweep.model_validate(sweep_dict(**over))
