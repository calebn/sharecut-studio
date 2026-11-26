"""Typed overlap-duplicate report returned by the analysis service."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict


class OverlapPair(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_a: str
    source_a: str | None
    word_index_a: int
    text_a: str
    start_a: float
    end_a: float
    status_a: str | None
    track_b: str
    source_b: str | None
    word_index_b: int
    text_b: str
    start_b: float
    end_b: float
    session_start_a: float
    session_start_b: float
    status_b: str | None
    overlap_sec: float
    text_match: bool
    rms_a_db: float | None
    rms_b_db: float | None


class OverlapDuplicateReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pair_count: int
    text_match_count: int
    pairs: list[OverlapPair]


def overlap_duplicate_report_result(out: Mapping[str, Any]) -> OverlapDuplicateReport:
    return OverlapDuplicateReport.model_validate(out)
