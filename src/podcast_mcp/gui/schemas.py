from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

from podcast_mcp.feed.model import FeedEdit
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.models.feed import PinAuthor
from podcast_mcp.project.transcript_context import (
    VOCABULARY_MAX_ENTRIES,
    VOCABULARY_MAX_ENTRY_CHARS,
)
from podcast_mcp.services.document_sync import (
    COMMENT_BODY_MAX,
    DocumentCommandBody,
    TranscriptReplacementOptions,
    WordTimingTargetPayload,
)
from podcast_mcp.services.pipeline import STEP_NAMES

# Discriminated union — source of truth in document_sync.payloads.
DocumentCommandRequest = DocumentCommandBody


class GuestRequest(BaseModel):
    """Base for the guest request bodies that carry fields of their own: unknown fields are
    refused. Document commands use their typed payloads instead."""

    model_config = {"extra": "forbid"}


class PipelineRunRequest(BaseModel):
    path: str
    from_step: str | None = None
    only_step: str | None = None
    skip_steps: list[str] | None = None
    enabled_steps: list[str] | None = None
    unattended: bool | None = None
    config: dict | None = None
    use_working_set: bool = True
    # Run-only: re-run ASR over existing transcripts (never persisted).
    force_transcribe: bool = False
    # Run-only: re-time stored transcripts with the forced aligner from their ASR cache
    # (Studio Re-time words); never persisted.
    retime_words: bool = False
    # Run-only: the user confirmed replacing hand-edited transcripts (Studio Re-transcribe /
    # Re-time words); honoured only with force_transcribe or retime_words, even in Batch mode.
    # Never persisted.
    overwrite_edited: bool = False


class PipelineConfigPutRequest(BaseModel):
    path: str
    config: dict | None = None
    enabled_steps: list[str] | None = None
    unattended: bool | None = None
    reset: bool = False


class PipelineAnalyzeRequest(BaseModel):
    path: str
    apply: bool = False


class PipelineCancelRequest(BaseModel):
    job_id: str | None = None


class RenderPreviewRequest(BaseModel):
    path: str


class TranscriptRefineWaiveRequest(BaseModel):
    path: str
    reason: str = Field(min_length=1)


class TranscriptRefineDoneRequest(BaseModel):
    path: str
    notes: str | None = None
    expected_fingerprint: str | None = None


class TranscriptRefineStatusView(BaseModel):
    """The transcript check as the Review stage reads it."""

    status: Literal["pending", "done", "waived"]
    clear: bool
    stale: bool
    mode: Literal["require", "waive_unattended", "off"]
    fingerprint: str
    source: str | None = None
    notes: str = ""
    updated_at: str | None = None
    hint: str | None = None
    low_confidence_words: int
    low_confidence_threshold: float


class TranscriptVocabularyPutRequest(BaseModel):
    path: str
    terms: list[str] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    guest_names: list[str] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    base_revision: str | None


class BootstrapRunRequest(BaseModel):
    """Studio model downloads for Whisper, optional RNNoise, and the opt-in word aligner."""

    components: list[str] | None = None
    whisper_model: str | None = None
    force: bool = False


class BootstrapCancelRequest(BaseModel):
    job_id: str | None = None


class BounceRequestBody(BaseModel):
    model_config = {"extra": "forbid"}
    exact_range: ExactRangeTarget | None = None
    path: str
    track_ids: list[str] | None = None
    start_s: float | None = None
    end_s: float | None = None
    formats: list[str] | None = None


class SpeakerSplitRequest(BaseModel):
    """Studio's Split speakers: the count is the host's, never guessed (``SpeakerService``)."""

    model_config = {"extra": "forbid"}
    path: str
    track_id: str
    speaker_count: int = Field(ge=2, le=8)
    names: list[Annotated[str, Field(max_length=80)]] | None = Field(default=None, max_length=8)
    # Each named speaker's known-voice spans in SOURCE seconds, as the CLI and MCP take them.
    enrollment: (
        dict[
            Annotated[str, Field(max_length=80)],
            Annotated[list[tuple[float, float]], Field(min_length=1, max_length=16)],
        ]
        | None
    ) = Field(default=None, max_length=8)

    @field_validator("enrollment")
    @classmethod
    def _spans_run_forward(cls, value):
        for name, spans in (value or {}).items():
            for start, end in spans:
                if not (0 <= start < end < float("inf")):
                    raise ValueError(f"{name}: each span needs 0 <= start < end")
        return value


class SpeakerMoveLaneSpanRequest(BaseModel):
    """Move a timeline range from one speaker-split lane to a sibling (``SpeakerService``)."""

    model_config = {"extra": "forbid"}
    path: str
    from_lane: str
    to_lane: str
    timeline_start: float
    timeline_end: float


class ExportDeliverablesRequest(BaseModel):
    path: str
    formats: list[dict] | None = None


class FeedEditRequest(BaseModel):
    """One edit to the episode's podcast listing; the empty string unsets."""

    path: str
    edit: FeedEdit
    by: PinAuthor = "person"
    """Who the pin is stamped as. An undo sends the original author back."""


class FeedGuestEditRequest(GuestRequest):
    """One show-level edit from an Editor share; the share link names the episode."""

    edit: FeedEdit


class GuestPipelineRunRequest(GuestRequest):
    """Which steps an Editor share starts; the host's working-set config decides the rest."""

    from_step: str | None = None
    only_step: str | None = None
    skip_steps: list[str] | None = Field(default=None, max_length=len(STEP_NAMES))
    force_transcribe: bool = False
    retime_words: bool = False


class GuestExportRequest(GuestRequest):
    """Which deliverables an Editor share exports; each name is a format the host fixes."""

    formats: list[Literal["mp3", "flac", "m4a"]] | None = Field(
        default=None, min_length=1, max_length=3
    )

    @field_validator("formats")
    @classmethod
    def _distinct(cls, formats: list[str] | None) -> list[str] | None:
        if formats is not None and len(set(formats)) != len(formats):
            raise ValueError("formats must not repeat")
        return formats


GUEST_NOTE_MAX_CHARS = 500
GUEST_SEARCH_MAX_CHARS = 200
GUEST_SEARCH_MAX_WORDS = 20
TranscriptFormat = Literal["txt", "md", "srt", "vtt"]
DEFAULT_TRANSCRIPT_EXPORT_FORMATS: tuple[TranscriptFormat, ...] = ("md", "srt")
VocabularyEntry = Annotated[str, Field(max_length=VOCABULARY_MAX_ENTRY_CHARS)]


class GuestVocabularyPutRequest(GuestRequest):
    """Save the project's vocabulary from an Editor share; the share names the project."""

    terms: list[VocabularyEntry] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    guest_names: list[VocabularyEntry] = Field(max_length=VOCABULARY_MAX_ENTRIES)
    base_revision: str | None = Field(max_length=64)


class GuestRefineDoneRequest(GuestRequest):
    """Mark the transcript checked; the share, not the body, says who did it."""

    notes: str | None = Field(default=None, max_length=GUEST_NOTE_MAX_CHARS)
    expected_fingerprint: str | None = Field(default=None, max_length=64)


class GuestRefineWaiveRequest(GuestRequest):
    """Waive the transcript check; the share, not the body, says who did it."""

    reason: str = Field(min_length=1, max_length=GUEST_NOTE_MAX_CHARS)

    @field_validator("reason")
    @classmethod
    def _not_blank(cls, reason: str) -> str:
        if not reason.strip():
            raise ValueError("reason must not be blank")
        return reason


class GuestReplacementPreviewRequest(GuestRequest, TranscriptReplacementOptions):
    """Preview a find-and-replace on the share's transcript; the search is shorter than the host's."""

    search: str = Field(min_length=1, max_length=GUEST_SEARCH_MAX_CHARS)

    @field_validator("search")
    @classmethod
    def _few_words(cls, search: str) -> str:
        if len(search.split()) > GUEST_SEARCH_MAX_WORDS:
            raise ValueError("search has too many words")
        return search


class GuestWordTimingTarget(GuestRequest):
    track_id: str = Field(min_length=1, max_length=200)
    source_id: str | None = Field(..., min_length=1, max_length=200)
    word_index: int = Field(ge=0)


class GuestExpectedTimingWord(GuestRequest):
    text: str = Field(max_length=200)
    start: float = Field(allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)


class GuestWordTimingContextRequest(GuestRequest):
    target: GuestWordTimingTarget
    expected_word: GuestExpectedTimingWord


class GuestTranscriptExportRequest(GuestRequest):
    """Write or preview the share's transcript files; each name is a format the host fixes."""

    formats: list[TranscriptFormat] = Field(
        default=list(DEFAULT_TRANSCRIPT_EXPORT_FORMATS), min_length=1, max_length=4
    )
    dry_run: bool = False
    with_text: bool = False

    @field_validator("formats")
    @classmethod
    def _distinct(cls, formats: list[str]) -> list[str]:
        if len(set(formats)) != len(formats):
            raise ValueError("formats must not repeat")
        return formats


class FeedWriteRequest(BaseModel):
    """Write the episode's feed file."""

    path: str


class TranscriptExportRequest(BaseModel):
    path: str
    formats: list[str] = list(DEFAULT_TRANSCRIPT_EXPORT_FORMATS)
    dry_run: bool = False
    with_text: bool = False


class ViewerSessionSnapshot(BaseModel):
    """Partial DAW transport snapshot (compat POST → typed commands)."""

    playhead_sec: float | None = None
    is_playing: bool | None = None
    audition_mode: str | None = None
    region: dict[str, Any] | None = None
    source: str | None = None
    track_id: str | None = None
    query: str | None = None
    match_index: int | None = None
    selection: dict[str, Any] | None = None
    viewer_mute: dict[str, bool] | None = None
    solo_tracks: dict[str, bool] | None = None
    tier: str | None = None
    dry_run: bool | None = None
    wav: str | None = None
    compare_segments: list[dict[str, Any]] | None = None
    ack_command_id: str | None = None
    client_id: str | None = None
    label: str | None = None


class SessionCommandRequest(BaseModel):
    """Typed command submit - agent, viewer, and CLI use the same shape."""

    client_id: str
    client_seq: int
    role: str = "viewer"
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    command_id: str | None = None
    causation_id: str | None = None
    label: str | None = None


class TrackView(BaseModel):
    range_media_seal: str = ""
    timeline_empty: bool = False
    id: str
    label: str
    role: str
    speaker: str | None = None
    gain_db: float = 0.0
    balance_stale: bool | None = None
    balance_ungated: bool | None = None
    balance_measured_lufs: float | None = None
    fader_db: float = 0.0
    muted: bool = False
    duration_sec: float | None = None
    fx_count: int = 0
    stem_is_fresh: bool | None = None
    has_source_audio: bool = False
    media_path: str | None = None
    # Id of the speaker split this track is a lane of (editorial.speaker_splits), else null.
    speaker_split_id: str | None = None
    # Longest edge fade (ms) a clip on this track may take; null = uncapped. Display copy of
    # the cap set_clip_fade enforces at write time (same track_fade_max_ms resolver); every
    # TRACKS/CLIPS slice, including the one after each SetClipFade, rebuilds it.
    fade_max_ms: int | None = None


class ProjectView(BaseModel):
    project_path: str
    meta: dict[str, Any]
    timeline_duration_sec: float
    tracks: list[TrackView]
    clips: dict[str, Any]
    chapters: list[dict[str, Any]]
    pending_edits: list[dict[str, Any]]
    edit_boundaries: list[dict[str, Any]] = Field(default_factory=list)
    applied_edits: dict[str, Any]
    effects_by_track: dict[str, list[dict[str, Any]]]
    envelopes: list[dict[str, Any]]
    social_clips: list[dict[str, Any]] = Field(default_factory=list)
    comments: list[dict[str, Any]] = Field(default_factory=list)
    render_status: dict[str, Any]
    edit_impact: dict[str, Any]
    history: dict[str, Any]
    transcript: dict[str, Any] | None = None


class CommentCreateRequest(BaseModel):
    path: str
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str
    timeline_start: float
    timeline_end: float | None = None
    track_ids: list[str] = Field(default_factory=list)
    action_texts: list[str] = Field(default_factory=list)
    edit_decision_id: str | None = None


class CommentPatchRequest(BaseModel):
    path: str
    body: str | None = Field(default=None, max_length=COMMENT_BODY_MAX)
    resolved: bool | None = None
    by: str | None = None
    track_ids: list[str] | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None


class CommentActionDoneRequest(BaseModel):
    path: str
    done: bool = True
    by: str


class CommentReplyRequest(BaseModel):
    path: str
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str


GUEST_NAME_FIELD_MAX = 200


class ShareActionDoneRequest(GuestRequest):
    """Guest HTTP twin for MCP guest_set_action_done (no project path)."""

    done: bool = True
    by: str = Field(default="guest", max_length=GUEST_NAME_FIELD_MAX)


class ShareCreateRequest(BaseModel):
    path: str
    role: Literal["viewer", "commenter", "editor"] = "commenter"
    with_mcp: bool = False
    review_version_id: str | None = None
    freeze: bool = False


class ShareRevokeRequest(BaseModel):
    path: str


class RecordRoomCreateRequest(BaseModel):
    path: str
    expires_at: str | None = None
    target: dict[str, Any] | None = None
    land_first: bool = False


class RecordRoomRevokeRequest(BaseModel):
    path: str


class RecordInviteReplaceRequest(BaseModel):
    path: str


class TranscriptReplacementPreviewRequest(TranscriptReplacementOptions):
    path: str


class ExpectedTimingWord(BaseModel):
    text: str
    start: float = Field(allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)


class TranscriptWordTimingContextRequest(BaseModel):
    path: str
    target: WordTimingTargetPayload
    expected_word: ExpectedTimingWord
