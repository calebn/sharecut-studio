"""Typed wire shapes for the inaudible-cut preview and the waveform snap window."""

from typing_extensions import TypedDict

from podcast_mcp.edits.inaudible_cuts import CutMode


class InaudibleCutPassthroughDetails(TypedDict):
    strategy: str


class InaudibleCutDetails(TypedDict):
    strategy: str
    search_window_ms: float
    max_shift_ms: float
    trailing_energy_extended: bool
    absorb_trailing_silence: bool


class InaudibleCutPreview(TypedDict):
    track_id: str
    timeline_mode: bool
    start: float
    end: float
    mode: CutMode
    shifted_start_ms: float
    shifted_end_ms: float
    confidence: float
    details: InaudibleCutDetails | InaudibleCutPassthroughDetails


class SilenceIslandWire(TypedDict):
    start: float
    end: float
    duration: float
    midpoint: float


class WaveformSnapWindow(TypedDict):
    track_id: str
    start: float
    end: float
    timeline_mode: bool
    preview: InaudibleCutPreview | None
    islands: list[SilenceIslandWire]
    ticks: list[float]
