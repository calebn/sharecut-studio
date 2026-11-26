"""Wire shapes of the staged-session results (#1811)."""

from typing import Literal

from typing_extensions import TypedDict

from podcast_mcp.services.document.edit_wire_results import RangeIntervalWire

SuggestionKind = Literal["insert", "replace"]
SuggestionStatus = Literal["pending", "skipped", "accepted"]


class InsertAnchorWire(TypedDict):
    kind: Literal["clip", "end"]
    at_sec: float
    track_id: str | None
    source_id: str | None
    source_sec: float | None
    side: Literal["before", "after"] | None
    offset_s: float


class StagedCommentWire(TypedDict):
    id: str
    body: str
    author: str
    recording_ms: int
    timeline_offset_s: float


class StagedTakeWire(TypedDict):
    take_index: int
    track_id: str
    track_label: str
    segment_index: int
    source_id: str
    offset_s: float
    duration_s: float
    comments: list[StagedCommentWire]


class StagedRoomToneWire(TypedDict):
    track_id: str
    track_label: str
    source_id: str
    path: str
    duration_s: float
    sample_rate: int
    channels: int


class SessionSuggestionWire(TypedDict):
    id: str
    kind: SuggestionKind
    session_id: str
    session_number: int
    at_sec: float | None
    anchor: InsertAnchorWire | None
    end_anchor: InsertAnchorWire | None
    from_sec: float | None
    to_sec: float | None
    track_ids: list[str]
    track_follows: dict[str, str]
    takes: list[StagedTakeWire]
    room_tone: list[StagedRoomToneWire]
    selected_take: int | None
    status: SuggestionStatus


class SelectTakeWire(TypedDict):
    suggestion: SessionSuggestionWire
    selected_take: int


class TakeTrackWire(TypedDict):
    track_id: str
    track_label: str
    duration_s: float
    segments: int


class TakeRefusalWire(TypedDict):
    code: str
    message: str


class SessionTakeRowWire(TypedDict):
    take_index: int
    duration_s: float
    tracks: list[TakeTrackWire]
    word_count: int | None
    speech_text: str | None
    chosen: bool
    default: bool
    acceptable: bool
    refusal: TakeRefusalWire | None


class SessionTakesWire(TypedDict):
    suggestion_id: str
    kind: SuggestionKind
    status: SuggestionStatus
    selectable: bool
    selected_take: int | None
    default_take: int | None
    takes: list[SessionTakeRowWire]


class PlacedClipWire(TypedDict):
    clip_id: str
    track_id: str
    source_id: str
    take_index: int
    segment_index: int
    timeline_start: float
    duration_s: float


class LandedCommentWire(TypedDict):
    id: str
    timeline_start: float


class AcceptInsertedWire(TypedDict):
    suggestion: SessionSuggestionWire
    at_sec: float
    span_s: float
    clips: list[PlacedClipWire]
    comments: list[LandedCommentWire]
    unmoved_track_ids: list[str]


class AcceptReplacedWire(TypedDict):
    suggestion: SessionSuggestionWire
    discarded_takes: list[int]
    discard_message: str | None
    at_sec: float
    from_sec: float
    to_sec: float
    removed_s: float
    span_s: float
    delta_s: float
    take_index: int
    clips: list[PlacedClipWire]
    comments: list[LandedCommentWire]
    comments_not_placed: int
    room_tone_not_placed: int
    clamped_comment_ids: list[str]
    retired_decision_ids: list[str]
    unmoved_track_ids: list[str]


class CutSpeechWordWire(TypedDict):
    text: str
    timeline_start: float
    timeline_end: float


class CutSpeechTrackWire(TypedDict):
    track_id: str
    speaker: str
    words: list[CutSpeechWordWire]
    sound_spans: list[RangeIntervalWire]


class CutSpeechWire(TypedDict):
    spans: list[RangeIntervalWire]
    tracks: list[CutSpeechTrackWire]


class CutSpeechConfirmationWire(TypedDict):
    status: Literal["needs_confirmation"]
    reason: Literal["cuts_other_speech"]
    message: str
    speech: CutSpeechWire


class AcceptHeldWire(TypedDict):
    operation: str
    unchanged: Literal[True]
    needs_confirmation: CutSpeechConfirmationWire
    apply_anyway: str


AcceptResult = AcceptInsertedWire | AcceptReplacedWire | AcceptHeldWire
