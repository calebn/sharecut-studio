from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class JoinDetectorRow(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    score: float
    weight: float
    detail: dict[str, Any]


class JoinRankerVerdict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    available: bool
    fail_proba: float
    threshold: float
    n_train: int


class JoinQualityReport(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    track_id: str
    mode: Literal["existing_join", "proposed_cut"]
    join_sec: float
    timebase: Literal["timeline", "source"]
    risk: float
    invisibility: float
    verdict: Literal["pass", "review", "fail"]
    reasons: list[str]
    detectors: list[JoinDetectorRow]
    calibrated: bool
    natural_p95: float | None
    side_sec: float
    disclaimer: str
    ranker: JoinRankerVerdict | None


class JoinQualityRow(JoinQualityReport):
    source_gap_sec: float
    speech: list[dict[str, Any]]


class JoinQualitySweep(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    join_count: int
    fail_count: int
    review_count: int
    pass_count: int
    speech_cross_count: int
    worst: JoinQualityRow | None
    joins: list[JoinQualityRow]
    disclaimer: str
