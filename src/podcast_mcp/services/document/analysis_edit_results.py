"""Wire shapes of the bleed mute, handoff cut and transcript reconcile results (#1811)."""

from typing import Any, Literal, NotRequired

from typing_extensions import TypedDict

from podcast_mcp.services.document.analysis_report_results import ReconciliationStatus
from podcast_mcp.services.document.inaudible_snap_results import SilenceIslandWire

BleedReductionWire = Literal["mute", "attenuate"]


class AlignmentSkip(TypedDict):
    track_id: str
    reason: str


class AlignmentProposal(TypedDict):
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


class AlignmentPreview(TypedDict):
    proposed_count: int
    proposals: list[AlignmentProposal]
    skipped: list[AlignmentSkip]


class AlignmentShift(TypedDict):
    decision_id: str
    direct_track_id: str
    bleed_track_id: str
    source_id: str | None
    source_start: float
    source_end: float
    previous_timeline_start: float
    timeline_start: float
    offset_sec: float


class AlignmentApplied(TypedDict):
    applied_count: int
    alignments: list[AlignmentShift]
    skipped: list[AlignmentSkip]


class BleedMuteTarget(TypedDict):
    track_id: str
    stem_path: str
    window_start: float
    window_end: float
    interval_count: int
    word_count: int
    suppressed_words: int
    duration_sec: float
    attenuation_count: int
    attenuation_spans: list[tuple[float, float]]
    bleed_reduction: BleedReductionWire
    bleed_bed_db: float | None
    gate_reasons: list[str]
    room_tone_fill: dict[str, object] | None
    room_tone_fill_reason: str | None


class BleedReason(TypedDict):
    track_id: str
    reason: str


class BleedStemSkip(TypedDict):
    track_id: str
    reason: str
    expected_duration_sec: float | None
    stem_duration_sec: float | None


class BleedReviewInterval(TypedDict):
    start: float
    end: float


class BleedReviewClip(TypedDict):
    id: str
    track_id: str
    source_id: str | None
    source_start: float
    source_end: float
    timeline_start: float
    fade_in_ms: int
    fade_out_ms: int
    join_in_mode: str
    mute_regions: list[dict[str, Any]]
    off_speaker_mute_regions: NotRequired[list[dict[str, Any]]]
    bleed_restore: NotRequired[dict[str, Any]]
    fade_in_curve: NotRequired[str]
    fade_out_curve: NotRequired[str]
    gain_db: NotRequired[float]
    timing: NotRequired[dict[str, Any]]
    segment_ref: NotRequired[dict[str, Any]]


class BleedReviewTarget(TypedDict):
    kind: Literal["exact_range"]
    intervals: list[BleedReviewInterval]
    track_ids: list[str]
    clips: list[BleedReviewClip]
    media_seals: dict[str, str]


class BleedReviewCandidate(TypedDict):
    track_id: str
    peer_track_id: str
    timeline_start: float
    timeline_end: float
    source_id: str | None
    clip_id: str
    source_start: float
    source_end: float
    requires_review: bool
    target: BleedReviewTarget
    automatic_refusal_reasons: list[str]
    protection_basis: str


class BleedReviewExclusion(TypedDict):
    track_id: str
    start: float
    end: float
    reason: str


class _BleedMuteFields(TypedDict):
    candidate_count: int
    candidates: list[BleedMuteTarget]
    applied_count: int
    applied: list[BleedMuteTarget]
    skipped: list[BleedReason | BleedStemSkip]
    speaker_errors: list[str] | None
    review_candidate_count: int
    review_candidates: list[BleedReviewCandidate]
    review_exclusions: list[BleedReviewExclusion]
    review_exclusions_truncated: bool
    review_reasons: list[BleedReason]
    review_truncated: bool


class BleedMuteDryRun(_BleedMuteFields):
    dry_run: Literal[True]
    alignment: NotRequired[AlignmentPreview]


class BleedMuteApplied(_BleedMuteFields):
    dry_run: Literal[False]
    alignment: NotRequired[AlignmentApplied]


class ReconcileWordRow(TypedDict):
    track_id: str
    source_id: str | None
    word_index: int
    text: str
    start: float
    end: float
    audibility_status: str


class ReconcileSuppressRow(ReconcileWordRow):
    dominant_track: str | None
    reason: str | None


class ReconcileReattributeRow(ReconcileSuppressRow):
    attributed_to_track: str


class _ReconcileFields(TypedDict):
    suppress: list[ReconcileSuppressRow]
    suppress_count: int
    unsuppress: list[ReconcileWordRow]
    unsuppress_count: int
    reattribute: list[ReconcileReattributeRow]
    reattribute_count: int
    status_updates: int
    reconciliation: ReconciliationStatus


class ReconcileTranscriptPreview(_ReconcileFields):
    applied: Literal[False]


class ReconcileTranscriptResult(_ReconcileFields):
    applied: bool


class SuggestHandoffCut(TypedDict):
    track_id: str | None
    track_ids: list[str]
    timebase: Literal["timeline"]
    keep_left_end: float
    keep_right_start: float
    islands: list[SilenceIslandWire]
    out_island: SilenceIslandWire | None
    in_island: SilenceIslandWire | None
    cut_start: float | None
    cut_end: float | None
    retained_air_after_left_sec: float | None
    retained_air_before_right_sec: float | None
    use_inaudible_opt: Literal[False]
    ok: bool
    warnings: list[str]
    hint: str
