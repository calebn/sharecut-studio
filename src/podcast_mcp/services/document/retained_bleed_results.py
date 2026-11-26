"""Typed results for retained-bleed alignment preview, apply and mode choice."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class RetainedBleedAlignmentProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    decision_id: str
    direct_track_id: str
    bleed_track_id: str
    clip_id: str
    source_id: str | None
    source_start: float
    source_end: float
    phrase_source_start: float
    phrase_source_end: float
    previous_timeline_start: float
    timeline_start: float
    offset_sec: float
    provenance: Literal["automatic", "requested_scoped_override"]
    validation_windows: int
    max_residual_ms: float
    reference_track_ids: list[str]
    media_key: str | None


class RetainedBleedAlignmentSkip(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    reason: str


class RetainedBleedAlignmentPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    proposed_count: int
    proposals: list[RetainedBleedAlignmentProposal]
    skipped: list[RetainedBleedAlignmentSkip]


class RetainedBleedAlignmentRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    decision_id: str
    direct_track_id: str
    bleed_track_id: str
    source_id: str | None
    source_start: float
    source_end: float
    previous_timeline_start: float
    timeline_start: float
    offset_sec: float


class RetainedBleedAlignmentApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    applied_count: int
    alignments: list[RetainedBleedAlignmentRow]
    skipped: list[RetainedBleedAlignmentSkip]


class RetainedBleedAlignmentModeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    start_s: float
    end_s: float
    id: str
    direct_track_id: str
    bleed_track_id: str
    source_id: str | None
    media_key: str | None
    mode: Literal["auto", "manual", "declined"]
    offset_sec: float
    previous_timeline_start: float
    timeline_start: float
    provenance: Literal["automatic", "requested_scoped_override"]
    evidence_revision: int


def retained_bleed_preview(out: Mapping[str, Any]) -> RetainedBleedAlignmentPreview:
    return RetainedBleedAlignmentPreview.model_validate(out)


def retained_bleed_applied(out: Mapping[str, Any]) -> RetainedBleedAlignmentApplied:
    return RetainedBleedAlignmentApplied.model_validate(out)


def retained_bleed_mode(out: Mapping[str, Any]) -> RetainedBleedAlignmentModeResult:
    return RetainedBleedAlignmentModeResult.model_validate(out)
