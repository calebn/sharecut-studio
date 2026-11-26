"""Typed wire shapes for off-speaker mute preview and apply results."""

from typing import Literal, NotRequired, TypedDict


class OffSpeakerRegion(TypedDict):
    start: float
    end: float
    duration: float
    peer_tracks: list[str]
    audible_sec: float
    peak_db: float


class OffSpeakerJudgedWord(TypedDict):
    start: float
    end: float
    verdict: Literal["copy", "review", "own"]
    correlation: float
    level_over_peer_db: float | None
    over_copy_db: float | None
    text: NotRequired[str]
    source: NotRequired[list[float]]


class OffSpeakerKeptGapWord(TypedDict):
    text: str
    source: list[float]
    timeline: list[float]


class OffSpeakerKeptGap(TypedDict):
    start: float
    end: float
    reason: Literal[
        "own_word",
        "own_energy",
        "other_speaker_silent",
        "no_copy_evidence",
        "short_region",
    ]
    words: NotRequired[list[OffSpeakerKeptGapWord]]


class OffSpeakerHeld(TypedDict):
    start: float
    end: float
    reason: str
    detail: NotRequired[str]


class _OffSpeakerFields(TypedDict):
    track_id: str
    region_count: int
    muted_sec: float
    audible_muted_sec: float
    quiet_muted_sec: float
    own_word_overlap_sec: float
    kept_uncorrelated_sec: float
    leak_ratio_db: float | None
    kept_own_word_sec: float
    kept_own_energy_sec: float
    already_quiet_sec: float
    refusal: str | None
    still_audible_sec: float
    still_audible_copy_sec: float
    judged_words: list[OffSpeakerJudgedWord]
    kept_gaps: list[OffSpeakerKeptGap]
    regions: list[OffSpeakerRegion]


class OffSpeakerPreview(_OffSpeakerFields):
    dry_run: Literal[True]


class OffSpeakerSummary(_OffSpeakerFields):
    dry_run: Literal[False]


class OffSpeakerApplied(OffSpeakerSummary):
    applied_count: int
    applied_sec: float
    held_count: int
    held_sec: float
    held: list[OffSpeakerHeld]
