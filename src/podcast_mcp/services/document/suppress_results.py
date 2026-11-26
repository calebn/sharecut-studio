"""Wire shapes of the bleed and low-audibility suppression results."""

from typing import Literal

from typing_extensions import TypedDict


class SuppressBleedCandidate(TypedDict):
    track_id: str
    source_id: str | None
    word_index: int
    text: str
    start: float
    end: float
    audibility_status: str | None
    dominant_track: str | None
    already_suppressed: bool


class SuppressBleedPreview(TypedDict):
    dry_run: Literal[True]
    candidate_count: int
    candidates: list[SuppressBleedCandidate]


class SuppressBleedApplied(TypedDict):
    dry_run: Literal[False]
    applied: Literal[True]
    suppressed_count: int
    candidates: list[SuppressBleedCandidate]


class SuppressLowAudibilityResult(TypedDict):
    suppressed_count: int
