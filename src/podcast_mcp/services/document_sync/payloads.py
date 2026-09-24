"""Per-command Pydantic payloads for the document plane.

Source of truth for HTTP, WS, host MCP, and guest remote MCP. Export JSON Schema
via ``scripts/export_document_command_schema.py`` → ``schemas/document-commands.schema.json``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, TypeAdapter, field_validator, model_validator

from podcast_mcp.edits.comments import COMMENT_BODY_MAX
from podcast_mcp.models.episode import FADER_MAX_DB, FADER_MIN_DB, ClipJoinMode
from podcast_mcp.services.document_sync.commands import ClientRole, DocumentCommand
from podcast_mcp.util.text import has_meaningful_text

JoinInMode = Literal["fade", "crossfade", "cut"]


class EnvelopePoint(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1)
    time: float
    value: float


class ExpectedEnvelopePoint(EnvelopePoint):
    """A baseline point; unlike a new point, its identity is never implicit."""

    id: str = Field(min_length=1)


# Bounds the O(n) baseline comparison that runs under ``document_submit_lock``.
ENVELOPE_POINTS_MAX = 10_000


class PasteExtract(BaseModel):
    """Clipboard extract for PasteSegment (opaque dict-compatible fields)."""

    model_config = {"extra": "allow"}

    track_id: str | None = None
    source_start: float | None = None
    source_end: float | None = None


# --- Payloads -----------------------------------------------------------------


class AddCommentPayload(BaseModel):
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str
    timeline_start: float
    timeline_end: float | None = None
    track_ids: list[str] | None = None
    action_texts: list[str] | None = None
    edit_decision_id: str | None = None


class UpdateCommentPayload(BaseModel):
    comment_id: str
    body: str | None = Field(default=None, max_length=COMMENT_BODY_MAX)
    track_ids: list[str] | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None


class ResolveCommentPayload(BaseModel):
    comment_id: str
    by: str
    resolved: bool = True


class DeleteCommentPayload(BaseModel):
    comment_id: str


class AddReplyPayload(BaseModel):
    comment_id: str
    body: str = Field(max_length=COMMENT_BODY_MAX)
    author: str


class SetActionDonePayload(BaseModel):
    comment_id: str
    action_id: str
    by: str
    done: bool = True


class AddActionPayload(BaseModel):
    comment_id: str
    text: str


class UndoHistoryPayload(BaseModel):
    rerender: bool = False


class RedoHistoryPayload(BaseModel):
    rerender: bool = False


class ApproveEditsPayload(BaseModel):
    ids: list[str]


class RejectEditsPayload(BaseModel):
    ids: list[str]


class UpdatePendingEditPayload(BaseModel):
    id: str
    start: float
    end: float
    snap: bool = True
    track_ids: list[str] | None = None


class RestoreAppliedEditPayload(BaseModel):
    id: str


class SetClipFadePayload(BaseModel):
    clip_id: str
    fade_in_ms: int
    fade_out_ms: int


class TrimClipEdgePayload(BaseModel):
    clip_id: str
    edge: Literal["in", "out"]
    source_sec: float
    mode: Literal["ripple"] = "ripple"


class RollClipJoinPayload(BaseModel):
    left_clip_id: str
    right_clip_id: str
    delta_sec: float


class SetJoinModePayload(BaseModel):
    clip_id: str
    join_in_mode: JoinInMode | ClipJoinMode


class ApplyFadeRecommendationsPayload(BaseModel):
    track_id: str | None = None


class SetEffectBypassPayload(BaseModel):
    track_id: str
    effect_index: int
    bypass: bool


class CorrectTranscriptWordPayload(BaseModel):
    track_id: str
    word_index: int
    text: str = Field(
        min_length=1,
        description="Correction text containing at least one visible character.",
    )

    @field_validator("text")
    @classmethod
    def _text_contains_visible_content(cls, value: str) -> str:
        if not has_meaningful_text(value):
            raise ValueError("correction text must not be empty")
        return value


class CorrectTranscriptPhrasePayload(BaseModel):
    track_id: str
    start_word_index: int
    end_word_index: int
    text: str


class SetTranscriptWordSuppressedPayload(BaseModel):
    track_id: str
    word_index: int
    suppressed: bool


class AddChapterPayload(BaseModel):
    time: float
    title: str


class UpdateChapterPayload(BaseModel):
    old_time: float
    old_title: str
    time: float
    title: str


class DeleteChapterPayload(BaseModel):
    time: float
    title: str


class AddSocialClipPayload(BaseModel):
    track_id: str
    start: float
    end: float
    title: str | None = None


class UpdateSocialClipPayload(BaseModel):
    id: str
    start: float
    end: float


class DeleteSocialClipPayload(BaseModel):
    id: str


class SetEnvelopePayload(BaseModel):
    track_id: str
    points: list[EnvelopePoint] = Field(default_factory=list, max_length=ENVELOPE_POINTS_MAX)
    # Echo the server's current volume points verbatim (exact float compare).
    expected_points: list[ExpectedEnvelopePoint] = Field(max_length=ENVELOPE_POINTS_MAX)

    @field_validator("expected_points")
    @classmethod
    def _unique_expected_ids(
        cls, value: list[ExpectedEnvelopePoint]
    ) -> list[ExpectedEnvelopePoint]:
        ids = [point.id for point in value]
        if len(ids) != len(set(ids)):
            raise ValueError("expected_points IDs must be unique")
        return value


class SuggestPendingEditPayload(BaseModel):
    track_id: str
    start: float = Field(allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)
    reason: str | None = None
    edit_type: Literal["remove", "mute"] = "remove"

    @model_validator(mode="after")
    def _end_after_start(self) -> SuggestPendingEditPayload:
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


class SplitAtTimePayload(BaseModel):
    at_time: float
    track_ids: list[str] | None = None
    reason: str | None = None


class DeleteClipPayload(BaseModel):
    clip_id: str | None = None
    clip_ids: list[str] | None = None
    reason: str | None = None


class RippleDeleteClipPayload(BaseModel):
    clip_id: str | None = None
    clip_ids: list[str] | None = None
    reason: str | None = None


class DuplicateSegmentPayload(BaseModel):
    source_start: float
    source_end: float
    insert_at: float


class MoveSegmentPayload(BaseModel):
    source_start: float
    source_end: float
    insert_at: float


class ClipMoveItem(BaseModel):
    clip_id: str
    timeline_start: float
    track_id: str


class MoveClipsPayload(BaseModel):
    clips: list[ClipMoveItem] = Field(min_length=1)


class PasteSegmentPayload(BaseModel):
    insert_at: float
    duration: float
    extracts: list[PasteExtract | dict[str, Any]] = Field(default_factory=list)


class RippleDeleteRangePayload(BaseModel):
    start: float
    end: float


class AddTrackPayload(BaseModel):
    track_id: str | None = None
    label: str | None = None
    role: str | None = None
    speaker: str | None = None


class SetTrackMediaPayload(BaseModel):
    track_id: str
    rel_path: str


class SetTrackMetaPayload(BaseModel):
    track_id: str
    label: str | None = None
    role: str | None = None
    speaker: str | None = None


class SetTrackFaderPayload(BaseModel):
    track_id: str
    fader_db: float = Field(ge=FADER_MIN_DB, le=FADER_MAX_DB)


class SetTrackMutePayload(BaseModel):
    track_id: str
    muted: bool


class RemoveTrackPayload(BaseModel):
    track_id: str


class ReorderTrackPayload(BaseModel):
    track_id: str
    index: int


# --- Envelope (discriminated on type) -----------------------------------------


class DocumentCommandEnvelope(BaseModel):
    """Shared wire fields for host/guest document command POST and MCP submit."""

    client_id: str
    client_seq: int
    role: ClientRole = "viewer"
    command_id: str | None = None
    causation_id: str | None = None
    token: str | None = None
    structural_mode: str | None = None


class AddCommentCommand(DocumentCommandEnvelope):
    type: Literal["AddComment"] = "AddComment"
    payload: AddCommentPayload


class UpdateCommentCommand(DocumentCommandEnvelope):
    type: Literal["UpdateComment"] = "UpdateComment"
    payload: UpdateCommentPayload


class ResolveCommentCommand(DocumentCommandEnvelope):
    type: Literal["ResolveComment"] = "ResolveComment"
    payload: ResolveCommentPayload


class DeleteCommentCommand(DocumentCommandEnvelope):
    type: Literal["DeleteComment"] = "DeleteComment"
    payload: DeleteCommentPayload


class AddReplyCommand(DocumentCommandEnvelope):
    type: Literal["AddReply"] = "AddReply"
    payload: AddReplyPayload


class SetActionDoneCommand(DocumentCommandEnvelope):
    type: Literal["SetActionDone"] = "SetActionDone"
    payload: SetActionDonePayload


class AddActionCommand(DocumentCommandEnvelope):
    type: Literal["AddAction"] = "AddAction"
    payload: AddActionPayload


class UndoHistoryCommand(DocumentCommandEnvelope):
    type: Literal["UndoHistory"] = "UndoHistory"
    payload: UndoHistoryPayload = Field(default_factory=UndoHistoryPayload)


class RedoHistoryCommand(DocumentCommandEnvelope):
    type: Literal["RedoHistory"] = "RedoHistory"
    payload: RedoHistoryPayload = Field(default_factory=RedoHistoryPayload)


class ApproveEditsCommand(DocumentCommandEnvelope):
    type: Literal["ApproveEdits"] = "ApproveEdits"
    payload: ApproveEditsPayload


class RejectEditsCommand(DocumentCommandEnvelope):
    type: Literal["RejectEdits"] = "RejectEdits"
    payload: RejectEditsPayload


class UpdatePendingEditCommand(DocumentCommandEnvelope):
    type: Literal["UpdatePendingEdit"] = "UpdatePendingEdit"
    payload: UpdatePendingEditPayload


class RestoreAppliedEditCommand(DocumentCommandEnvelope):
    type: Literal["RestoreAppliedEdit"] = "RestoreAppliedEdit"
    payload: RestoreAppliedEditPayload


class SetClipFadeCommand(DocumentCommandEnvelope):
    type: Literal["SetClipFade"] = "SetClipFade"
    payload: SetClipFadePayload


class TrimClipEdgeCommand(DocumentCommandEnvelope):
    type: Literal["TrimClipEdge"] = "TrimClipEdge"
    payload: TrimClipEdgePayload


class RollClipJoinCommand(DocumentCommandEnvelope):
    type: Literal["RollClipJoin"] = "RollClipJoin"
    payload: RollClipJoinPayload


class SetJoinModeCommand(DocumentCommandEnvelope):
    type: Literal["SetJoinMode"] = "SetJoinMode"
    payload: SetJoinModePayload


class ApplyFadeRecommendationsCommand(DocumentCommandEnvelope):
    type: Literal["ApplyFadeRecommendations"] = "ApplyFadeRecommendations"
    payload: ApplyFadeRecommendationsPayload = Field(
        default_factory=ApplyFadeRecommendationsPayload
    )


class SetEffectBypassCommand(DocumentCommandEnvelope):
    type: Literal["SetEffectBypass"] = "SetEffectBypass"
    payload: SetEffectBypassPayload


class CorrectTranscriptWordCommand(DocumentCommandEnvelope):
    type: Literal["CorrectTranscriptWord"] = "CorrectTranscriptWord"
    payload: CorrectTranscriptWordPayload


class CorrectTranscriptPhraseCommand(DocumentCommandEnvelope):
    type: Literal["CorrectTranscriptPhrase"] = "CorrectTranscriptPhrase"
    payload: CorrectTranscriptPhrasePayload


class SetTranscriptWordSuppressedCommand(DocumentCommandEnvelope):
    type: Literal["SetTranscriptWordSuppressed"] = "SetTranscriptWordSuppressed"
    payload: SetTranscriptWordSuppressedPayload


class AddChapterCommand(DocumentCommandEnvelope):
    type: Literal["AddChapter"] = "AddChapter"
    payload: AddChapterPayload


class UpdateChapterCommand(DocumentCommandEnvelope):
    type: Literal["UpdateChapter"] = "UpdateChapter"
    payload: UpdateChapterPayload


class DeleteChapterCommand(DocumentCommandEnvelope):
    type: Literal["DeleteChapter"] = "DeleteChapter"
    payload: DeleteChapterPayload


class AddSocialClipCommand(DocumentCommandEnvelope):
    type: Literal["AddSocialClip"] = "AddSocialClip"
    payload: AddSocialClipPayload


class UpdateSocialClipCommand(DocumentCommandEnvelope):
    type: Literal["UpdateSocialClip"] = "UpdateSocialClip"
    payload: UpdateSocialClipPayload


class DeleteSocialClipCommand(DocumentCommandEnvelope):
    type: Literal["DeleteSocialClip"] = "DeleteSocialClip"
    payload: DeleteSocialClipPayload


class SetEnvelopeCommand(DocumentCommandEnvelope):
    type: Literal["SetEnvelope"] = "SetEnvelope"
    payload: SetEnvelopePayload


class SuggestPendingEditCommand(DocumentCommandEnvelope):
    type: Literal["SuggestPendingEdit"] = "SuggestPendingEdit"
    payload: SuggestPendingEditPayload


class SplitAtTimeCommand(DocumentCommandEnvelope):
    type: Literal["SplitAtTime"] = "SplitAtTime"
    payload: SplitAtTimePayload


class DeleteClipCommand(DocumentCommandEnvelope):
    type: Literal["DeleteClip"] = "DeleteClip"
    payload: DeleteClipPayload


class RippleDeleteClipCommand(DocumentCommandEnvelope):
    type: Literal["RippleDeleteClip"] = "RippleDeleteClip"
    payload: RippleDeleteClipPayload


class DuplicateSegmentCommand(DocumentCommandEnvelope):
    type: Literal["DuplicateSegment"] = "DuplicateSegment"
    payload: DuplicateSegmentPayload


class MoveSegmentCommand(DocumentCommandEnvelope):
    type: Literal["MoveSegment"] = "MoveSegment"
    payload: MoveSegmentPayload


class MoveClipsCommand(DocumentCommandEnvelope):
    type: Literal["MoveClips"] = "MoveClips"
    payload: MoveClipsPayload


class PasteSegmentCommand(DocumentCommandEnvelope):
    type: Literal["PasteSegment"] = "PasteSegment"
    payload: PasteSegmentPayload


class RippleDeleteRangeCommand(DocumentCommandEnvelope):
    type: Literal["RippleDeleteRange"] = "RippleDeleteRange"
    payload: RippleDeleteRangePayload


class AddTrackCommand(DocumentCommandEnvelope):
    type: Literal["AddTrack"] = "AddTrack"
    payload: AddTrackPayload = Field(default_factory=AddTrackPayload)


class SetTrackMediaCommand(DocumentCommandEnvelope):
    type: Literal["SetTrackMedia"] = "SetTrackMedia"
    payload: SetTrackMediaPayload


class SetTrackMetaCommand(DocumentCommandEnvelope):
    type: Literal["SetTrackMeta"] = "SetTrackMeta"
    payload: SetTrackMetaPayload


class SetTrackFaderCommand(DocumentCommandEnvelope):
    type: Literal["SetTrackFader"] = "SetTrackFader"
    payload: SetTrackFaderPayload


class SetTrackMuteCommand(DocumentCommandEnvelope):
    type: Literal["SetTrackMute"] = "SetTrackMute"
    payload: SetTrackMutePayload


class RemoveTrackCommand(DocumentCommandEnvelope):
    type: Literal["RemoveTrack"] = "RemoveTrack"
    payload: RemoveTrackPayload


class ReorderTrackCommand(DocumentCommandEnvelope):
    type: Literal["ReorderTrack"] = "ReorderTrack"
    payload: ReorderTrackPayload


DocumentCommandBody = Annotated[
    AddCommentCommand
    | UpdateCommentCommand
    | ResolveCommentCommand
    | DeleteCommentCommand
    | AddReplyCommand
    | SetActionDoneCommand
    | AddActionCommand
    | UndoHistoryCommand
    | RedoHistoryCommand
    | ApproveEditsCommand
    | RejectEditsCommand
    | UpdatePendingEditCommand
    | RestoreAppliedEditCommand
    | SetClipFadeCommand
    | TrimClipEdgeCommand
    | RollClipJoinCommand
    | SetJoinModeCommand
    | ApplyFadeRecommendationsCommand
    | SetEffectBypassCommand
    | CorrectTranscriptWordCommand
    | CorrectTranscriptPhraseCommand
    | SetTranscriptWordSuppressedCommand
    | AddChapterCommand
    | UpdateChapterCommand
    | DeleteChapterCommand
    | AddSocialClipCommand
    | UpdateSocialClipCommand
    | DeleteSocialClipCommand
    | SetEnvelopeCommand
    | SuggestPendingEditCommand
    | SplitAtTimeCommand
    | DeleteClipCommand
    | RippleDeleteClipCommand
    | DuplicateSegmentCommand
    | MoveSegmentCommand
    | MoveClipsCommand
    | PasteSegmentCommand
    | RippleDeleteRangeCommand
    | AddTrackCommand
    | SetTrackMediaCommand
    | SetTrackMetaCommand
    | SetTrackFaderCommand
    | SetTrackMuteCommand
    | RemoveTrackCommand
    | ReorderTrackCommand,
    Field(discriminator="type"),
]

DOCUMENT_COMMAND_ADAPTER: TypeAdapter[Any] = TypeAdapter(DocumentCommandBody)


def document_command_json_schema() -> dict[str, Any]:
    """JSON Schema for the discriminated document command body (MCP + check-in)."""
    return DOCUMENT_COMMAND_ADAPTER.json_schema()


def parse_document_command_body(data: dict[str, Any] | BaseModel) -> Any:
    """Validate wire data into a typed DocumentCommandBody instance."""
    if isinstance(data, BaseModel):
        return DOCUMENT_COMMAND_ADAPTER.validate_python(data.model_dump())
    return DOCUMENT_COMMAND_ADAPTER.validate_python(data)


def document_command_from_body(body: Any) -> DocumentCommand:
    """Convert a validated envelope into the internal DocumentCommand dataclass."""
    payload = body.payload.model_dump(mode="python")
    # PasteExtract / dict extracts → plain dicts for handlers.
    if "extracts" in payload and isinstance(payload["extracts"], list):
        payload["extracts"] = [
            e if isinstance(e, dict) else e.model_dump() if hasattr(e, "model_dump") else dict(e)
            for e in payload["extracts"]
        ]
    if "join_in_mode" in payload and hasattr(payload["join_in_mode"], "value"):
        payload["join_in_mode"] = payload["join_in_mode"].value
    return DocumentCommand(
        type=body.type,
        payload=payload,
        client_id=body.client_id,
        role=body.role,
        client_seq=body.client_seq,
        command_id=body.command_id or uuid4().hex,
        causation_id=body.causation_id,
    )


def parse_document_command(
    data: dict[str, Any],
    *,
    defaults: dict[str, Any] | None = None,
) -> DocumentCommand:
    """Validate *data* (merged with *defaults*) and return DocumentCommand."""
    merged = {**(defaults or {}), **data}
    if "payload" not in merged:
        merged["payload"] = {}
    if "client_id" not in merged:
        merged["client_id"] = "anonymous"
    if "client_seq" not in merged:
        merged["client_seq"] = 1
    body = parse_document_command_body(merged)
    return document_command_from_body(body)


# Payload-only adapters for host MCP helpers that already know the type.
_PAYLOAD_BY_TYPE: dict[str, type[BaseModel]] = {
    "AddComment": AddCommentPayload,
    "UpdateComment": UpdateCommentPayload,
    "ResolveComment": ResolveCommentPayload,
    "DeleteComment": DeleteCommentPayload,
    "AddReply": AddReplyPayload,
    "SetActionDone": SetActionDonePayload,
    "AddAction": AddActionPayload,
    "UndoHistory": UndoHistoryPayload,
    "RedoHistory": RedoHistoryPayload,
    "ApproveEdits": ApproveEditsPayload,
    "RejectEdits": RejectEditsPayload,
    "UpdatePendingEdit": UpdatePendingEditPayload,
    "RestoreAppliedEdit": RestoreAppliedEditPayload,
    "SetClipFade": SetClipFadePayload,
    "TrimClipEdge": TrimClipEdgePayload,
    "RollClipJoin": RollClipJoinPayload,
    "SetJoinMode": SetJoinModePayload,
    "ApplyFadeRecommendations": ApplyFadeRecommendationsPayload,
    "SetEffectBypass": SetEffectBypassPayload,
    "CorrectTranscriptWord": CorrectTranscriptWordPayload,
    "CorrectTranscriptPhrase": CorrectTranscriptPhrasePayload,
    "SetTranscriptWordSuppressed": SetTranscriptWordSuppressedPayload,
    "AddChapter": AddChapterPayload,
    "UpdateChapter": UpdateChapterPayload,
    "DeleteChapter": DeleteChapterPayload,
    "AddSocialClip": AddSocialClipPayload,
    "UpdateSocialClip": UpdateSocialClipPayload,
    "DeleteSocialClip": DeleteSocialClipPayload,
    "SetEnvelope": SetEnvelopePayload,
    "SuggestPendingEdit": SuggestPendingEditPayload,
    "SplitAtTime": SplitAtTimePayload,
    "DeleteClip": DeleteClipPayload,
    "RippleDeleteClip": RippleDeleteClipPayload,
    "DuplicateSegment": DuplicateSegmentPayload,
    "MoveSegment": MoveSegmentPayload,
    "MoveClips": MoveClipsPayload,
    "PasteSegment": PasteSegmentPayload,
    "RippleDeleteRange": RippleDeleteRangePayload,
    "AddTrack": AddTrackPayload,
    "SetTrackMedia": SetTrackMediaPayload,
    "SetTrackMeta": SetTrackMetaPayload,
    "SetTrackFader": SetTrackFaderPayload,
    "SetTrackMute": SetTrackMutePayload,
    "RemoveTrack": RemoveTrackPayload,
    "ReorderTrack": ReorderTrackPayload,
}


def validate_payload(command_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Validate a payload dict for a known command type; return dumped dict."""
    model = _PAYLOAD_BY_TYPE.get(command_type)
    if model is None:
        raise ValueError(f"unknown document command: {command_type}")
    validated = model.model_validate(payload or {})
    out = validated.model_dump(mode="python")
    if "extracts" in out and isinstance(out["extracts"], list):
        out["extracts"] = [
            e if isinstance(e, dict) else e.model_dump() if hasattr(e, "model_dump") else dict(e)
            for e in out["extracts"]
        ]
    if "join_in_mode" in out and hasattr(out["join_in_mode"], "value"):
        out["join_in_mode"] = out["join_in_mode"].value
    return out
