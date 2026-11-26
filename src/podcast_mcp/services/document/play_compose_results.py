"""Wire shapes of the audition context and prosody overlay reports (#1811).

``PlayService.audition_context`` and ``PlayService.prosody_overlay`` cast the dicts that
``edits/audition_context.py`` and ``edits/prosody_profile.py`` build; the producers keep
returning ``dict[str, Any]`` (``edits/`` does not import ``services/``). A ``NotRequired``
key is omitted, never ``None``, when its condition does not hold. Two mappings stay open
because their keys are not fixed by this report: ``HypothesisEvidence`` (per hypothesis
code, spread from the engines' ``to_dict``) and ``AuditionEffectWire.params`` (per effect).
The track-id keyed maps (``render_status.tracks``, ``speaker_roles``) are ``dict[str, Row]``.
"""

from typing import Any, Literal, NotRequired

from typing_extensions import TypedDict

from podcast_mcp.services.document.analysis_report_results import FfmpegAstats, MainsHum

AuditionDetail = Literal["summary", "full", "visual"]
AuditionLimit = Literal[
    "cannot_hear",
    "captions_are_transcript_not_audio",
    "needs_rerender",
    "echo_check_needs_fresh_stems",
    "whisper_word_times",
    "visuals_are_degradation_not_asr",
]
HypothesisCode = Literal[
    "stale_render",
    "stale_reconciliation",
    "edits_in_window",
    "acoustic_gap_filler",
    "suppressed_only_track",
    "clip_skew",
    "muted_track_speaking",
    "uneven_transcript_density",
    "hum_in_window",
    "clipping_in_window",
    "dsp_unavailable",
    "speech_crosses_cut",
    "retained_bleed_misalignment",
    "echo_risk",
]
HypothesisSeverity = Literal["warn", "info"]
HypothesisConfidence = Literal["measured", "heuristic"]
HypothesisAutonomy = Literal["auto_ok", "needs_approval", "present_only"]
HypothesisEvidence = dict[str, Any]
ProsodyBoundaryKind = Literal["word_gap", "segment_end"]
ProsodyEnergyTrend = Literal["falling", "rising", "flat"]


class TimelineWindowWire(TypedDict):
    clock: Literal["timeline"]
    unit: Literal["sec"]
    start: float
    end: float


class SourceRangeWire(TypedDict):
    clock: Literal["source"]
    unit: Literal["sec"]
    start: float
    end: float


class SourceSpanWire(TypedDict):
    clock: Literal["source"]
    start: float
    end: float


class TimelineSpanWire(TypedDict):
    start: float
    end: float


class ProsodyF0Wire(TypedDict):
    mean_hz: float
    median_hz: float
    sd_st: float
    range_st: float
    voiced_fraction: float


class ProsodyRateWire(TypedDict):
    syllable_count: int
    speech_rate: float
    articulation_rate: float


class ProsodyPausesWire(TypedDict):
    count: int
    total_sec: float


class ProsodyEnergyWire(TypedDict):
    mean_db: float
    sd_db: float
    slope_db_per_sec: float
    start_third_db: float
    mid_third_db: float
    end_third_db: float
    drop_db: float
    trend: ProsodyEnergyTrend


class ProsodyVoiceQualityWire(TypedDict):
    jitter_local: float
    shimmer_local: float
    hnr_db: float
    jitter_high: bool
    shimmer_high: bool
    hnr_low: bool


class ProsodyWindowWordWire(TypedDict):
    text: str
    start: float
    end: float
    score: float
    timeline_start: float


class ProsodyWindowBoundaryWire(TypedDict):
    time: float
    strength: float
    pause_sec: float
    lengthening: float
    pitch_reset: float
    kind: ProsodyBoundaryKind
    timeline_time: float


class ProsodyWindowSegmentWire(TypedDict):
    source_start: float
    source_end: float
    timeline_start: float | None
    timeline_end: float | None
    f0: ProsodyF0Wire
    rate: ProsodyRateWire
    pauses: ProsodyPausesWire
    energy: ProsodyEnergyWire
    voice_quality: ProsodyVoiceQualityWire
    prominent_words: list[ProsodyWindowWordWire]
    boundaries: list[ProsodyWindowBoundaryWire]
    line: str


class ProsodyWindowFresh(TypedDict):
    status: Literal["fresh"]
    segments: list[ProsodyWindowSegmentWire]
    truncated: bool


class ProsodyWindowNotCached(TypedDict):
    status: Literal["missing", "stale"]
    hint: str


class ProsodyWindowUnavailable(TypedDict):
    status: Literal["unavailable"]
    error: str


ProsodyWindow = ProsodyWindowFresh | ProsodyWindowNotCached | ProsodyWindowUnavailable


class AuditionEffectWire(TypedDict):
    effect: str
    bypass: Literal[False]
    params: dict[str, Any]


class AuditionTrackWire(TypedDict):
    track_id: str
    kind: Literal["transcript_caption"]
    source_spans: list[SourceSpanWire]
    source_at_mid: float | None
    word_count: int
    text: str
    suppressed_only: bool
    effects: list[AuditionEffectWire]
    muted: bool
    word_aligner: str | None
    prosody: ProsodyWindow


class AuditionPlacementWire(TypedDict):
    clip_id: str
    source_id: str | None
    timeline: TimelineWindowWire
    source: SourceRangeWire


class AuditionAuxiliaryTrackWire(TypedDict):
    track_id: str
    role: Literal["music", "sfx"]
    muted: bool
    placements: list[AuditionPlacementWire]


class AuditionSkewPairWire(TypedDict):
    track_a: str
    track_b: str
    source_delta_sec: float
    skew_sec: float
    skewed: bool


class AuditionClipSkewWire(TypedDict):
    threshold_sec: float
    pairs: list[AuditionSkewPairWire]
    warnings: list[str]
    any_skewed: bool


class AuditionActionItemWire(TypedDict):
    id: str
    text: str
    done: bool


class AuditionCommentWire(TypedDict):
    id: str
    body: str
    author: str
    timeline_start: float
    timeline_end: float | None
    resolved: bool
    open_action_count: int
    track_ids: NotRequired[list[str]]
    action_items: NotRequired[list[AuditionActionItemWire]]


class AuditionHeldCheckWire(TypedDict):
    status: Literal["held"]
    reason: str


class AuditionCleanCheckWire(TypedDict):
    status: Literal["clean"]


AuditionAudioCheck = AuditionHeldCheckWire | AuditionCleanCheckWire


class AuditionPendingEditWire(TypedDict):
    id: str
    track_id: str
    reason: str | None
    review_required: bool
    cut_confidence: float | None
    timeline_start: float
    timeline_end: float
    source_start: NotRequired[float]
    source_end: NotRequired[float]
    boundary_mode: NotRequired[str | None]
    audio_check: NotRequired[AuditionAudioCheck]


class AuditionAppliedEditWire(TypedDict):
    id: str
    operation: str
    reason: str | None
    timeline_start: float
    timeline_end: float
    cut_confidence: float | None
    track_ids: NotRequired[list[str]]
    source_start: NotRequired[float | None]
    source_end: NotRequired[float | None]
    boundary_mode: NotRequired[str | None]


class AuditionEditsWire(TypedDict):
    pending: list[AuditionPendingEditWire]
    applied: list[AuditionAppliedEditWire]


class AuditionStemWire(TypedDict):
    stem_exists: bool
    stem_is_fresh: bool


class AuditionRenderStatusWire(TypedDict):
    needs_rerender: bool
    tracks: dict[str, AuditionStemWire]
    premix_exists: bool
    reconciliation_stale: bool


class HypothesisFixWire(TypedDict):
    skill: str | None
    autonomy: HypothesisAutonomy


class HypothesisNextWire(TypedDict):
    listen: str
    tools: list[str]
    fix: HypothesisFixWire


class AuditionHypothesisWire(TypedDict):
    code: HypothesisCode
    severity: HypothesisSeverity
    confidence: HypothesisConfidence
    tracks: list[str]
    window: TimelineWindowWire
    evidence: HypothesisEvidence
    meaning: str
    next: HypothesisNextWire


class AuditionListenWire(TypedDict):
    id: str
    why: str
    start: float
    end: float
    clock: Literal["timeline"]
    source: NotRequired[str]
    track_ids: NotRequired[list[str]]
    tier: NotRequired[Literal["processed"]]
    pair: NotRequired[list[str]]


class AuditionPlotWire(TypedDict):
    x0: float
    x1: float
    time_linear: Literal[True]
    freq: Literal["log"]
    read_for: Literal["degradation_not_asr"]


class AuditionVisualEventWire(TypedDict):
    kind: Literal["word", "comment", "pending_edit", "hypothesis"]
    t: float
    x: float
    track_id: str
    text: str | None
    id: NotRequired[str]
    t_end: NotRequired[float]
    x_end: NotRequired[float]


class AuditionVisualMeasuredWire(TypedDict):
    track_id: str
    window: TimelineWindowWire
    astats: FfmpegAstats
    hum: MainsHum
    spectrogram_png: str | None
    waveform_png: str | None
    plot: AuditionPlotWire
    events: list[AuditionVisualEventWire]
    annotate_error: NotRequired[str]


class AuditionVisualUnavailableWire(TypedDict):
    track_id: str
    dsp_unavailable: Literal[True]
    reason: str


AuditionVisualWire = AuditionVisualMeasuredWire | AuditionVisualUnavailableWire


class AuditionSpeakerRoleWire(TypedDict):
    role: Literal["own", "bleed", "uncertain"]
    match_identity: str | None
    margin: float
    best_home_track: str | None


class AuditionContextReport(TypedDict):
    schema: Literal["audition_context.v2"]
    window: TimelineWindowWire
    timeline_start: float
    timeline_end: float
    mid_sec: float
    detail: AuditionDetail
    tracks: list[AuditionTrackWire]
    auxiliary_tracks: list[AuditionAuxiliaryTrackWire]
    clip_skew: AuditionClipSkewWire
    comments: list[AuditionCommentWire]
    edits: AuditionEditsWire
    render_status: AuditionRenderStatusWire
    hypotheses: list[AuditionHypothesisWire]
    suggested_listen: list[AuditionListenWire]
    limits: list[AuditionLimit]
    warnings: list[str]
    summary: str
    prosody_notes: list[str]
    speaker_roles: NotRequired[dict[str, AuditionSpeakerRoleWire]]
    visuals: NotRequired[list[AuditionVisualWire]]


class ProsodyOverlayThirdWire(TypedDict):
    db: float
    spans: list[TimelineSpanWire]


class ProsodyOverlaySegmentWire(TypedDict):
    source_start: float
    source_end: float
    spans: list[TimelineSpanWire]
    energy_thirds: list[ProsodyOverlayThirdWire]
    trend: ProsodyEnergyTrend
    drop_db: float
    line: str


class ProsodyOverlayBoundaryWire(TypedDict):
    timeline_sec: float
    strength: float
    kind: ProsodyBoundaryKind
    pause_sec: float


class ProsodyOverlayWordWire(TypedDict):
    text: str
    score: float
    word_index: int | None
    timeline_sec: float | None


class ProsodyEnergyRangeWire(TypedDict):
    min: float
    max: float


class ProsodyOverlayFreshTrack(TypedDict):
    track_id: str
    status: Literal["fresh"]
    segments: list[ProsodyOverlaySegmentWire]
    boundaries: list[ProsodyOverlayBoundaryWire]
    prominent_words: list[ProsodyOverlayWordWire]
    energy_db: ProsodyEnergyRangeWire | None


class ProsodyOverlayHintedTrack(TypedDict):
    track_id: str
    status: Literal["stale", "missing", "unavailable"]
    hint: str
    segments: list[ProsodyOverlaySegmentWire]
    boundaries: list[ProsodyOverlayBoundaryWire]
    prominent_words: list[ProsodyOverlayWordWire]
    energy_db: ProsodyEnergyRangeWire | None


ProsodyOverlayTrack = ProsodyOverlayFreshTrack | ProsodyOverlayHintedTrack


class ProsodyOverlayReport(TypedDict):
    schema: Literal["prosody_overlay.v1"]
    tracks: list[ProsodyOverlayTrack]
