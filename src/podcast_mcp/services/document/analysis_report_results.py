"""Wire shapes of the four analysis report results (#1811)."""

from typing import Any, Literal, NotRequired

from typing_extensions import TypedDict

GateRisk = Literal["none", "unknown", "moderate", "high"]


class ReconciliationStatus(TypedDict):
    stale: bool
    fingerprint: str
    last_reconciliation_hash: str | None
    reconciliation_stale_flag: bool


class CleanupPolicy(TypedDict):
    bleed_dominance_db: float
    bleed_ratio_warn_threshold: float
    ml_backend: str
    transcript_mode: str
    reconcile_on_render: bool


class FfmpegAstats(TypedDict):
    dc_offset: float | None
    peak_level_db: float | None
    rms_level_db: float | None
    crest_factor: float | None
    flat_factor: float | None
    peak_count: int | None
    noise_floor_db: float | None
    dynamic_range_db: float | None


HumEnergyRatios = TypedDict("HumEnergyRatios", {"50hz_ratio": float, "60hz_ratio": float})


class HumAnalyzed(TypedDict):
    hum_detected: bool
    dominant_frequency: str
    energy_ratios: HumEnergyRatios
    threshold_ratio: float
    recommendation: str | None


class HumSkipped(TypedDict):
    hum_detected: Literal[False]
    reason: str


MainsHum = HumAnalyzed | HumSkipped


class TrackHealth(FfmpegAstats):
    hum: MainsHum
    voice_db: float | None


class GateNoGate(TypedDict):
    track_id: str
    gate_present: Literal[False]
    risk: Literal["none"]
    issues: list[dict[str, Any]]
    advice: str


class GateNoiseReport(TypedDict):
    track_id: str
    gate_present: Literal[True]
    risk: GateRisk
    issues: list[dict[str, Any]]
    advice: str
    issue_count: NotRequired[int]
    gate_type: NotRequired[Literal["noise"]]


class GateTranscriptReport(TypedDict):
    track_id: str
    gate_present: Literal[True]
    gate_type: Literal["transcript"]
    risk: GateRisk
    issue_count: int
    issues: list[dict[str, Any]]
    analyzed_words: int
    advice: str


class GateCombinedReport(TypedDict):
    track_id: str
    gate_present: Literal[True]
    gate_type: Literal["combined"]
    risk: GateRisk
    issue_count: int
    issues: list[dict[str, Any]]
    components: list[GateNoiseReport | GateTranscriptReport]
    advice: str


GateOverreach = GateNoGate | GateNoiseReport | GateTranscriptReport | GateCombinedReport


class CleanupTrackRow(TypedDict):
    track_id: str
    effects: list[str]
    health: TrackHealth | None
    gate_analysis: GateOverreach
    low_audibility_count: int
    low_audibility_sample: list[dict[str, Any]]
    flagged_count: int
    bleed_count: int
    bleed_ratio: float | None
    flagged_sample: list[dict[str, Any]]
    fade_recommendations: list[dict[str, Any]]
    high_bleed_warning: NotRequired[str]
    suppression_recommendations: NotRequired[list[dict[str, Any]]]


class CleanupAnalysisReport(TypedDict):
    tracks: list[CleanupTrackRow]
    policy: CleanupPolicy
    reconciliation: ReconciliationStatus
    summary: str


class AudioDiagnosticsWindow(TypedDict):
    clock: Literal["timeline"]
    unit: Literal["sec"]
    start: float
    end: float


class AudioDiagnosticsReport(TypedDict):
    track_id: str
    astats: FfmpegAstats
    hum: MainsHum
    spectrogram_png: str
    waveform_png: str
    window: NotRequired[AudioDiagnosticsWindow]
