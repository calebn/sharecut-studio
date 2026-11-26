"""Wire shapes of the applied-edit, revert, render status, impact and suggest results (#1811)."""

from typing import Any, Literal, NotRequired

from typing_extensions import TypedDict

from podcast_mcp.services.document.analysis_report_results import ReconciliationStatus


class RestoreConflictWire(TypedDict):
    code: str
    record_id: str
    message: str
    track_id: str | None
    blocked_by: list[str]


class RevertPlannedSummary(TypedDict):
    operation: str
    ids: list[str]
    affected_tracks: list[str]


class RevertRestoredSummary(TypedDict):
    operation: str
    ids: list[str]
    affected_tracks: list[str]
    track_ids: list[str]
    duration_sec: float
    clip_count: int
    timeline_duration_sec: float


class RevertConflictSummary(TypedDict):
    """The conflict result carries an empty summary."""


class RevertPlanned(TypedDict):
    status: Literal["planned"]
    conflicts: list[RestoreConflictWire]
    summary: RevertPlannedSummary


class RevertRestored(TypedDict):
    status: Literal["restored"]
    conflicts: list[RestoreConflictWire]
    summary: RevertRestoredSummary


class RevertConflict(TypedDict):
    status: Literal["conflict"]
    conflicts: list[RestoreConflictWire]
    summary: RevertConflictSummary


RevertResult = RevertPlanned | RevertRestored | RevertConflict


class RestoreStateWire(TypedDict):
    state: Literal["ready", "blocked", "history_only"]
    code: str | None
    message: str | None
    blocked_by: list[str]


class AppliedEditWire(TypedDict):
    id: str
    applied_at: str
    operation: str
    decision_ids: list[str]
    track_ids: list[str]
    source_start: float | None
    source_end: float | None
    timeline_start: float | None
    timeline_end: float | None
    reason: str | None
    crossfade_ms: int | None
    boundary_mode: str | None
    cut_confidence: float | None
    params: dict[str, Any]
    restore: RestoreStateWire


class AppliedEditsWithRestore(TypedDict):
    count: int
    records: list[AppliedEditWire]


class RenderInvalidationWire(TypedDict):
    id: str
    track_ids: list[str]
    timeline_start: float | None
    timeline_end: float | None
    reason: str
    at: str


class TrackRenderStatus(TypedDict):
    stem_path: str | None
    stem_exists: bool
    stem_is_fresh: bool
    render_hash: str
    stored_hash: str | None
    expected_duration_sec: float | None
    stem_duration_sec: float | None
    duration_mismatch: bool
    balance_stale: bool | None
    balance_ungated: bool | None
    balance_measured_lufs: float | None


class PremixStatus(TypedDict):
    path: str | None
    exists: bool
    stale_vs_stems: bool
    stale_vs_mix: bool
    is_stale: bool
    mtime_sec: NotRequired[float]
    size_bytes: NotRequired[int]


class RenderStatusReport(TypedDict):
    tracks: dict[str, TrackRenderStatus]
    premix: PremixStatus
    reconciliation: ReconciliationStatus
    invalidations: list[RenderInvalidationWire]
    needs_rerender: bool


class ImpactSegment(TypedDict):
    id: str
    track_id: str
    start: float
    end: float
    duration_sec: float
    reason: str | None
    applied: bool
    review_required: bool


class EditImpactReport(TypedDict):
    total_removed_sec: float
    by_track_sec: dict[str, float]
    applied_count: int
    pending_review_count: int
    segments: list[ImpactSegment]
    clip_count: int
    timeline_duration_sec: float
    gap_count: int


class RangeIntervalWire(TypedDict):
    start: float
    end: float


class SuggestedEdit(TypedDict):
    id: str
    track_id: str
    type: Literal["remove", "mute"]
    start: float
    end: float
    crossfade_ms: int
    reason: str | None
    author: str | None
    review_required: bool
    applied: bool
    cut_confidence: float | None
    boundary_mode: str | None
    replace_gap_sec: float | None
    next_burst_sec: float | None
    scope: str
    cut_speech: dict[str, Any] | None
    track_ids: list[str] | None
    timebase: str
    source_id: str | None
    source_timeline_span: RangeIntervalWire | None
    exact_range: dict[str, Any] | None
    proposal_origin: str
    boundary_intent: str
