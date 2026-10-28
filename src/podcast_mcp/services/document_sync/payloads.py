"""Per-command Pydantic payloads for the document plane.

Source of truth for HTTP, WS, host MCP, and guest remote MCP. Export JSON Schema
via ``scripts/export_document_command_schema.py`` → ``schemas/document-commands.schema.json``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import (
    BaseModel,
    Field,
    SerializerFunctionWrapHandler,
    TypeAdapter,
    ValidationError,
    field_validator,
    model_serializer,
    model_validator,
)

from podcast_mcp.edits.bleed_restore_targets import BleedRestoreTarget
from podcast_mcp.edits.clip_fades import ClipFadeBaseline
from podcast_mcp.edits.comments import COMMENT_BODY_MAX
from podcast_mcp.edits.decisions import PendingEditBaseline
from podcast_mcp.models.episode import (
    FADER_MAX_DB,
    FADER_MIN_DB,
    ClipJoinMode,
    EditMode,
    ExactRangeTarget,
    RangeInterval,
)
from podcast_mcp.services.document_sync.commands import ClientRole, DocumentCommand
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.text import has_meaningful_text

JoinInMode = Literal["fade", "crossfade", "cut"]

EditModeField = Annotated[
    EditMode,
    Field(
        description=(
            "ripple: close or open the time on every dialogue track, so speakers stay "
            "in sync. gap: leave silence (or paste over) and move nothing else."
        )
    ),
]


class EnvelopePoint(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1)
    time: float = Field(ge=0, allow_inf_nan=False)
    value: float = Field(allow_inf_nan=False)


class ExpectedEnvelopePoint(EnvelopePoint):
    """A baseline point; unlike a new point, its identity is never implicit."""

    id: str = Field(min_length=1)


# Bounds the O(n) baseline comparison that runs inside the document transaction.
ENVELOPE_POINTS_MAX = 10_000
FADE_RECOMMENDATIONS_MAX = 10_000


class PasteExtract(BaseModel):
    """Clipboard extract for PasteSegment (opaque dict-compatible fields)."""

    model_config = {"extra": "allow"}

    track_id: str | None = None
    source_start: float | None = None
    source_end: float | None = None


# --- Payloads -----------------------------------------------------------------


class AddCommentPayload(BaseModel):
    timeline_spans: list[RangeInterval] | None = Field(default=None, max_length=1000)
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


class _HistoryMovePayload(BaseModel):
    rerender: bool = False
    expected_head_id: str = Field(
        min_length=1,
        max_length=64,
        description='The history head the client saw (history.head_id; "root" for a '
        "history with no entry yet). Required: the server refuses with 409 history_stale "
        "unless it is still the head, so a GUI or guest move never reverts an edit the "
        "client had not seen.",
    )


class UndoHistoryPayload(_HistoryMovePayload):
    pass


class RedoHistoryPayload(_HistoryMovePayload):
    pass


OVERRIDE_DESCRIPTION = (
    "Apply even if the automatic audio-quality and cut-position checks would hold this "
    "edit (a mid-word or harsh cut the owner wants anyway). Allowed for any caller that "
    "may run the command; the history entry and applied edits record who overrode and "
    "through which surface."
)


class ApproveEditsPayload(BaseModel):
    ids: list[str]
    hold_blocked: bool = Field(
        default=False,
        description=(
            "Approve all: a cut that cannot apply safely (another speaker is talking "
            "there, say) stays pending and is reported in `held`; every other edit "
            "applies. A cut that would cut other speech also stays pending: the reply "
            "is reported with its speech evidence. Trusted interactive intent or "
            "`override_audio_checks` overrides that acoustic hold. Without `hold_blocked`, one held cut refuses "
            "the whole batch."
        ),
    )
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )
    skip_unsure: bool = Field(
        default=False,
        description=(
            "Bulk guard: a pending cut that covers a transcript word below the unsure line "
            "(`analysis.unsure_word_confidence`) is not applied. It stays pending and is "
            "reported in `held` with reason `unsure_word`; every other edit applies as one "
            "history step. The server checks the saved words at approval time, not a list the "
            "client sends. The CLI and MCP approve-all send it; approving one cut by name does not. "
            "The Studio client does not send it yet. A guest's multi-edit approve always behaves "
            "as if it were true."
        ),
    )


class RejectEditsPayload(BaseModel):
    ids: list[str]


class ApplySuggestedActionsPayload(BaseModel):
    ids: list[str] | None = Field(
        default=None,
        description=(
            "Narrow the batch to these pending sounds (the Tighten list's filtered ids); "
            "omit for every pending tighten proposal."
        ),
    )
    overrides: dict[str, Literal["cut", "shorten", "lower", "leave"]] = Field(
        default_factory=dict,
        description="Decision id to the action to use instead of its suggested one.",
    )
    revise: bool = Field(
        default=False,
        description=(
            "Change sounds of the batch just applied: step back to before it (it must be the "
            "latest edit) and apply it again with `overrides` on top of its actions, as one "
            "undo step. Takes no `ids`."
        ),
    )
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )
    skip_unsure: bool = Field(
        default=False,
        description=(
            "Bulk guard: a cut or shorten over a transcript word below the unsure line "
            "(`analysis.unsure_word_confidence`) is not applied. It stays pending and is "
            "named in `held` and `held_unsure`; every other sound is applied as one history "
            "step, and when all are held nothing is saved. The server checks the saved words "
            "at apply time, not a list the client sends. The CLI and MCP send it for the "
            "all-suggested path and for several ids (not on revise); naming one id does not. The Studio "
            "client does not send it yet. Every guest apply behaves as if it were true."
        ),
    )


class UpdatePendingEditPayload(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    start: float
    end: float
    snap: bool = True
    track_ids: list[str] | None = None
    expected: PendingEditBaseline | None = Field(
        default=None,
        description=(
            "Saved pending-edit identity and bounds. A changed, applied, or removed target "
            "returns a 409 conflict without a mutation. Omit for an unconditional nudge."
        ),
    )
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )


class RestoreAppliedEditPayload(BaseModel):
    id: str


class RestoreClipBleedPayload(BaseModel):
    model_config = {"extra": "forbid"}

    target: BleedRestoreTarget


class SetClipFadePayload(BaseModel):
    clip_id: str
    fade_in_ms: int
    fade_out_ms: int
    expected: ClipFadeBaseline = Field(
        description="Both saved fades captured when the edit began. A changed pair "
        "returns clip_fade_changed without changing fades, history, or the journal."
    )


class TrimClipEdgePayload(BaseModel):
    clip_id: str
    edge: Literal["in", "out"]
    source_sec: float = Field(allow_inf_nan=False)
    mode: EditModeField
    expected_token: str = Field(min_length=1)
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )


class RollClipJoinPayload(BaseModel):
    left_clip_id: str
    right_clip_id: str
    delta_sec: float = Field(allow_inf_nan=False)
    expected_token: str = Field(min_length=1)


class SetJoinModePayload(BaseModel):
    clip_id: str
    join_in_mode: JoinInMode | ClipJoinMode


class SetClipJoinPayload(BaseModel):
    left_clip_id: str
    right_clip_id: str
    mode: JoinInMode | ClipJoinMode
    length_ms: int | None = Field(default=None, ge=0)


class ApplyFadeRecommendationsPayload(BaseModel):
    track_id: str | None = None


class ApplyFadeRecommendationListPayload(BaseModel):
    recommendations: list[dict[str, Any]] = Field(max_length=FADE_RECOMMENDATIONS_MAX)


class SetEffectBypassPayload(BaseModel):
    track_id: str
    effect_index: int
    bypass: bool


class AddEffectPayload(BaseModel):
    track_id: str
    preset: str | None = None
    effect: str | None = None
    params: dict[str, Any] | None = None


class RemoveEffectPayload(BaseModel):
    track_id: str
    effect: str | None = None


class ReconcileTranscriptPayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    start_sec: float | None = Field(default=None, allow_inf_nan=False)
    end_sec: float | None = Field(default=None, allow_inf_nan=False)
    dry_run: Literal[False] | None = Field(
        default=None,
        description=(
            "Omitted, the project's transcript mode decides what is applied. A preview is not "
            "a command: it never journals."
        ),
    )


class WordKeyItem(BaseModel):
    track_id: str
    source_id: str | None = None
    word_index: int = Field(ge=0)

    @model_serializer(mode="wrap")
    def _keep_source_id_absent(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        out = handler(self)
        if "source_id" not in self.model_fields_set:
            out.pop("source_id", None)
        return out


class SuppressBleedPayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    words: list[WordKeyItem] | None = Field(
        default=None, description="Limit to these word keys; omit for every bleed word in scope."
    )
    exclude_words: list[WordKeyItem] | None = None
    start_sec: float | None = None
    end_sec: float | None = None


class SuppressLowAudibilityPayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    words: list[WordKeyItem] | None = Field(
        default=None, description="Limit to these word keys; omit for every low-audibility word."
    )


class SetBleedAlignmentModePayload(BaseModel):
    decision_id: str
    mode: Literal["auto", "manual", "declined"]
    track_id: str | None = None
    start_sec: float | None = None
    end_sec: float | None = None
    override_placement_lock: bool = False


_EXPECTED_TEXT_DESCRIPTION = (
    "Optional stale-index guard: the word (or space-joined phrase) text the "
    "client saw at these indices. When it no longer matches (whitespace-collapsed, "
    "case-sensitive) or those indices no longer exist, the command is rejected with a 409 "
    "conflict and nothing changes. Omit to skip the check."
)


class TranscriptReplacementOptions(BaseModel):
    search: str = Field(min_length=1, max_length=500)
    replacement: str = Field(min_length=1, max_length=500)
    match_case: bool = False


class ReplaceTranscriptMatchesPayload(TranscriptReplacementOptions):
    preview_token: str = Field(pattern=r"^[0-9a-f]{64}$")


_SOURCE_ID_DESCRIPTION = (
    "The recording whose words word_index counts. Required on a track recorded as several "
    "takes (refused with word_source_required); optional on a track with one transcript."
)


class WordCorrectionItem(BaseModel):
    word_index: int
    text: str


class PhraseCorrectionItem(BaseModel):
    start_word_index: int
    end_word_index: int
    text: str


class ApplyTranscriptCleanupPayload(BaseModel):
    track_id: str
    words: list[WordCorrectionItem] | None = None
    phrases: list[PhraseCorrectionItem] | None = None


class VerifyTranscriptPayload(BaseModel):
    track_id: str
    corrections: list[WordCorrectionItem]


class CorrectTranscriptWordPayload(BaseModel):
    track_id: str
    source_id: str | None = Field(
        default=None,
        min_length=1,
        description=_SOURCE_ID_DESCRIPTION,
    )
    word_index: int
    text: str = Field(
        min_length=1,
        description="Correction text containing at least one visible character.",
    )
    expected_text: str | None = Field(
        default=None,
        description=_EXPECTED_TEXT_DESCRIPTION,
    )

    @field_validator("text")
    @classmethod
    def _text_contains_visible_content(cls, value: str) -> str:
        if not has_meaningful_text(value):
            raise ValueError("correction text must not be empty")
        return value


class CorrectTranscriptPhrasePayload(BaseModel):
    track_id: str
    source_id: str | None = Field(
        default=None,
        min_length=1,
        description=_SOURCE_ID_DESCRIPTION,
    )
    start_word_index: int
    end_word_index: int
    text: str
    expected_text: str | None = Field(
        default=None,
        description=_EXPECTED_TEXT_DESCRIPTION,
    )


class WordTimingTargetPayload(BaseModel):
    track_id: str = Field(min_length=1)
    source_id: str | None = Field(..., min_length=1)
    word_index: int = Field(ge=0)


class SetTranscriptWordTimingPayload(BaseModel):
    target: WordTimingTargetPayload
    expected_token: str = Field(min_length=1)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)


class SetTranscriptWordSuppressedPayload(BaseModel):
    track_id: str
    source_id: str | None = Field(
        default=None,
        min_length=1,
        description=_SOURCE_ID_DESCRIPTION,
    )
    word_index: int
    suppressed: bool
    expected_text: str | None = Field(
        default=None,
        description=_EXPECTED_TEXT_DESCRIPTION,
    )


class SetTranscriptWordAutomaticPayload(BaseModel):
    track_id: str
    source_id: str | None = Field(
        default=None,
        min_length=1,
        description=_SOURCE_ID_DESCRIPTION,
    )
    word_index: int
    expected_text: str | None = Field(
        default=None,
        description=_EXPECTED_TEXT_DESCRIPTION,
    )


class SetTranscriptWordsIgnoredPayload(BaseModel):
    track_id: str
    source_id: str | None = Field(
        default=None,
        min_length=1,
        description=_SOURCE_ID_DESCRIPTION,
    )
    start_word_index: int = Field(ge=0)
    end_word_index: int = Field(ge=0)
    ignored: bool
    expected_text: str | None = Field(
        default=None,
        description=_EXPECTED_TEXT_DESCRIPTION,
    )


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


class EditSelectedRangePayload(BaseModel):
    model_config = {"extra": "forbid"}

    action: Literal["cut", "mute"]
    target: ExactRangeTarget
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )


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


class StageTimeRangeCutPayload(BaseModel):
    track_id: str
    start: float = Field(allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)
    reason: str | None = None
    review_required: bool = True
    use_inaudible_opt: bool | None = None


class StageTextMatchCutPayload(BaseModel):
    query: str
    track_id: str | None = None
    speaker: str | None = None
    match_all: bool = False
    review_required: bool = True
    use_inaudible_opt: bool | None = None


class StageUtteranceCutPayload(BaseModel):
    utterance_index: int
    review_required: bool = True
    use_inaudible_opt: bool | None = None


class StageWordsCutPayload(BaseModel):
    track_id: str
    start_word_index: int
    end_word_index: int
    source_id: str | None = None
    review_required: bool = True
    use_inaudible_opt: bool | None = None


class SplitAtTimePayload(BaseModel):
    at_time: float
    track_ids: list[str] | None = None
    reason: str | None = None
    extra_at_times: list[float] | None = Field(
        default=None,
        description=(
            "More timeline times to split at in the same history step as at_time "
            "(the other edge of a selected range). A time with no clip to split is "
            "skipped when another time did split."
        ),
    )


class DeleteClipPayload(BaseModel):
    clip_id: str | None = None
    clip_ids: list[str] | None = None
    mode: EditModeField
    reason: str | None = None
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )


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
    mode: EditModeField


class InsertGapPayload(BaseModel):
    at_time: float = Field(allow_inf_nan=False)
    duration_sec: float = Field(default=1.0, allow_inf_nan=False)


class FillRoomTonePayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    start_sec: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    end_sec: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _range_is_a_forward_pair(self) -> FillRoomTonePayload:
        if self.track_id is None and self.speaker is None:
            raise ValueError("a room tone fill needs track_id or speaker")
        if (self.start_sec is None) != (self.end_sec is None):
            raise ValueError("start_sec and end_sec go together")
        if self.start_sec is not None and self.end_sec is not None:
            if self.track_id is None:
                raise ValueError("a range needs track_id")
            if self.end_sec <= self.start_sec:
                raise ValueError("end_sec must be after start_sec")
        return self


class ApplyAutoEditsPayload(BaseModel):
    pass


class FadeJoinsPayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    fade_ms: int | None = None
    dry_run: Literal[False] | None = Field(
        default=None, description="A preview is not a command: only false or omitted."
    )


class CrossfadeJoinsPayload(BaseModel):
    track_id: str | None = None
    speaker: str | None = None
    fade_ms: int | None = None
    dry_run: Literal[False] | None = Field(
        default=None, description="A preview is not a command: only false or omitted."
    )


class MoveByTextPayload(BaseModel):
    source_query: str
    destination_query: str
    position: str = "after"


class CutRangePayload(BaseModel):
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)
    mode: EditModeField
    use_inaudible_opt: bool | None = Field(
        default=None,
        description=(
            "Ripple only: snap the bounds to the quiet air around the cut. Omitted, the "
            "project's default applies; false keeps the bounds as given."
        ),
    )
    track_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Tracks whose material the cut means to remove. A ripple asks to confirm "
            "before cutting speech on any other track, so with none named it asks before "
            "cutting anyone's. A gap cut punches only these (every dialogue track when "
            "none are named)."
        ),
    )
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )

    @model_validator(mode="after")
    def _end_after_start(self) -> CutRangePayload:
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


class RippleDeleteTextPayload(BaseModel):
    query: str
    use_inaudible_opt: bool | None = None
    override_audio_checks: bool = Field(
        default=False,
        description=OVERRIDE_DESCRIPTION,
    )


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
    client_seq: int | None = Field(default=None, ge=1)  # omit for a server-assigned sequence
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
    payload: UndoHistoryPayload


class RedoHistoryCommand(DocumentCommandEnvelope):
    type: Literal["RedoHistory"] = "RedoHistory"
    payload: RedoHistoryPayload


class ApproveEditsCommand(DocumentCommandEnvelope):
    type: Literal["ApproveEdits"] = "ApproveEdits"
    payload: ApproveEditsPayload


class ApplySuggestedActionsCommand(DocumentCommandEnvelope):
    type: Literal["ApplySuggestedActions"] = "ApplySuggestedActions"
    payload: ApplySuggestedActionsPayload


class RejectEditsCommand(DocumentCommandEnvelope):
    type: Literal["RejectEdits"] = "RejectEdits"
    payload: RejectEditsPayload


class UpdatePendingEditCommand(DocumentCommandEnvelope):
    type: Literal["UpdatePendingEdit"] = "UpdatePendingEdit"
    payload: UpdatePendingEditPayload


class RestoreAppliedEditCommand(DocumentCommandEnvelope):
    type: Literal["RestoreAppliedEdit"] = "RestoreAppliedEdit"
    payload: RestoreAppliedEditPayload


class RestoreClipBleedCommand(DocumentCommandEnvelope):
    type: Literal["RestoreClipBleed"] = "RestoreClipBleed"
    payload: RestoreClipBleedPayload


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


class SetClipJoinCommand(DocumentCommandEnvelope):
    type: Literal["SetClipJoin"] = "SetClipJoin"
    payload: SetClipJoinPayload


class ApplyFadeRecommendationsCommand(DocumentCommandEnvelope):
    type: Literal["ApplyFadeRecommendations"] = "ApplyFadeRecommendations"
    payload: ApplyFadeRecommendationsPayload = Field(
        default_factory=ApplyFadeRecommendationsPayload
    )


class SetEffectBypassCommand(DocumentCommandEnvelope):
    type: Literal["SetEffectBypass"] = "SetEffectBypass"
    payload: SetEffectBypassPayload


class AddEffectCommand(DocumentCommandEnvelope):
    type: Literal["AddEffect"] = "AddEffect"
    payload: AddEffectPayload


class RemoveEffectCommand(DocumentCommandEnvelope):
    type: Literal["RemoveEffect"] = "RemoveEffect"
    payload: RemoveEffectPayload


class ApplyFadeRecommendationListCommand(DocumentCommandEnvelope):
    type: Literal["ApplyFadeRecommendationList"] = "ApplyFadeRecommendationList"
    payload: ApplyFadeRecommendationListPayload


class ReconcileTranscriptCommand(DocumentCommandEnvelope):
    type: Literal["ReconcileTranscript"] = "ReconcileTranscript"
    payload: ReconcileTranscriptPayload


class SuppressBleedCommand(DocumentCommandEnvelope):
    type: Literal["SuppressBleed"] = "SuppressBleed"
    payload: SuppressBleedPayload


class SuppressLowAudibilityCommand(DocumentCommandEnvelope):
    type: Literal["SuppressLowAudibility"] = "SuppressLowAudibility"
    payload: SuppressLowAudibilityPayload


class SetBleedAlignmentModeCommand(DocumentCommandEnvelope):
    type: Literal["SetBleedAlignmentMode"] = "SetBleedAlignmentMode"
    payload: SetBleedAlignmentModePayload


class ReplaceTranscriptMatchesCommand(DocumentCommandEnvelope):
    type: Literal["ReplaceTranscriptMatches"] = "ReplaceTranscriptMatches"
    payload: ReplaceTranscriptMatchesPayload


class ApplyTranscriptCleanupCommand(DocumentCommandEnvelope):
    type: Literal["ApplyTranscriptCleanup"] = "ApplyTranscriptCleanup"
    payload: ApplyTranscriptCleanupPayload


class VerifyTranscriptCommand(DocumentCommandEnvelope):
    type: Literal["VerifyTranscript"] = "VerifyTranscript"
    payload: VerifyTranscriptPayload


class CorrectTranscriptWordCommand(DocumentCommandEnvelope):
    type: Literal["CorrectTranscriptWord"] = "CorrectTranscriptWord"
    payload: CorrectTranscriptWordPayload


class CorrectTranscriptPhraseCommand(DocumentCommandEnvelope):
    type: Literal["CorrectTranscriptPhrase"] = "CorrectTranscriptPhrase"
    payload: CorrectTranscriptPhrasePayload


class SetTranscriptWordTimingCommand(DocumentCommandEnvelope):
    type: Literal["SetTranscriptWordTiming"] = "SetTranscriptWordTiming"
    payload: SetTranscriptWordTimingPayload


class SetTranscriptWordSuppressedCommand(DocumentCommandEnvelope):
    type: Literal["SetTranscriptWordSuppressed"] = "SetTranscriptWordSuppressed"
    payload: SetTranscriptWordSuppressedPayload


class SetTranscriptWordAutomaticCommand(DocumentCommandEnvelope):
    type: Literal["SetTranscriptWordAutomatic"] = "SetTranscriptWordAutomatic"
    payload: SetTranscriptWordAutomaticPayload


class SetTranscriptWordsIgnoredCommand(DocumentCommandEnvelope):
    type: Literal["SetTranscriptWordsIgnored"] = "SetTranscriptWordsIgnored"
    payload: SetTranscriptWordsIgnoredPayload


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


class EditSelectedRangeCommand(DocumentCommandEnvelope):
    type: Literal["EditSelectedRange"] = "EditSelectedRange"
    payload: EditSelectedRangePayload


class SuggestPendingEditCommand(DocumentCommandEnvelope):
    type: Literal["SuggestPendingEdit"] = "SuggestPendingEdit"
    payload: SuggestPendingEditPayload


class StageTimeRangeCutCommand(DocumentCommandEnvelope):
    type: Literal["StageTimeRangeCut"] = "StageTimeRangeCut"
    payload: StageTimeRangeCutPayload


class StageTextMatchCutCommand(DocumentCommandEnvelope):
    type: Literal["StageTextMatchCut"] = "StageTextMatchCut"
    payload: StageTextMatchCutPayload


class StageUtteranceCutCommand(DocumentCommandEnvelope):
    type: Literal["StageUtteranceCut"] = "StageUtteranceCut"
    payload: StageUtteranceCutPayload


class StageWordsCutCommand(DocumentCommandEnvelope):
    type: Literal["StageWordsCut"] = "StageWordsCut"
    payload: StageWordsCutPayload


class SplitAtTimeCommand(DocumentCommandEnvelope):
    type: Literal["SplitAtTime"] = "SplitAtTime"
    payload: SplitAtTimePayload


class DeleteClipCommand(DocumentCommandEnvelope):
    type: Literal["DeleteClip"] = "DeleteClip"
    payload: DeleteClipPayload


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


class InsertGapCommand(DocumentCommandEnvelope):
    type: Literal["InsertGap"] = "InsertGap"
    payload: InsertGapPayload


class FillRoomToneCommand(DocumentCommandEnvelope):
    type: Literal["FillRoomTone"] = "FillRoomTone"
    payload: FillRoomTonePayload


class ApplyAutoEditsCommand(DocumentCommandEnvelope):
    type: Literal["ApplyAutoEdits"] = "ApplyAutoEdits"
    payload: ApplyAutoEditsPayload = Field(default_factory=ApplyAutoEditsPayload)


class FadeJoinsCommand(DocumentCommandEnvelope):
    type: Literal["FadeJoins"] = "FadeJoins"
    payload: FadeJoinsPayload


class CrossfadeJoinsCommand(DocumentCommandEnvelope):
    type: Literal["CrossfadeJoins"] = "CrossfadeJoins"
    payload: CrossfadeJoinsPayload


class MoveByTextCommand(DocumentCommandEnvelope):
    type: Literal["MoveByText"] = "MoveByText"
    payload: MoveByTextPayload


class CutRangeCommand(DocumentCommandEnvelope):
    type: Literal["CutRange"] = "CutRange"
    payload: CutRangePayload


class RippleDeleteTextCommand(DocumentCommandEnvelope):
    type: Literal["RippleDeleteText"] = "RippleDeleteText"
    payload: RippleDeleteTextPayload


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
    | ApplySuggestedActionsCommand
    | UpdatePendingEditCommand
    | RestoreAppliedEditCommand
    | RestoreClipBleedCommand
    | SetClipFadeCommand
    | TrimClipEdgeCommand
    | RollClipJoinCommand
    | SetJoinModeCommand
    | SetClipJoinCommand
    | ApplyFadeRecommendationsCommand
    | ApplyFadeRecommendationListCommand
    | SetEffectBypassCommand
    | AddEffectCommand
    | ReconcileTranscriptCommand
    | SuppressBleedCommand
    | SuppressLowAudibilityCommand
    | SetBleedAlignmentModeCommand
    | RemoveEffectCommand
    | ReplaceTranscriptMatchesCommand
    | CorrectTranscriptWordCommand
    | ApplyTranscriptCleanupCommand
    | VerifyTranscriptCommand
    | CorrectTranscriptPhraseCommand
    | SetTranscriptWordSuppressedCommand
    | SetTranscriptWordAutomaticCommand
    | SetTranscriptWordsIgnoredCommand
    | SetTranscriptWordTimingCommand
    | AddChapterCommand
    | UpdateChapterCommand
    | DeleteChapterCommand
    | AddSocialClipCommand
    | UpdateSocialClipCommand
    | DeleteSocialClipCommand
    | SetEnvelopeCommand
    | EditSelectedRangeCommand
    | SuggestPendingEditCommand
    | StageTimeRangeCutCommand
    | StageTextMatchCutCommand
    | StageUtteranceCutCommand
    | StageWordsCutCommand
    | SplitAtTimeCommand
    | DeleteClipCommand
    | DuplicateSegmentCommand
    | MoveSegmentCommand
    | InsertGapCommand
    | FillRoomToneCommand
    | ApplyAutoEditsCommand
    | FadeJoinsCommand
    | CrossfadeJoinsCommand
    | MoveByTextCommand
    | MoveClipsCommand
    | PasteSegmentCommand
    | CutRangeCommand
    | RippleDeleteTextCommand
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
    for key in ("join_in_mode", "mode"):
        if key in payload and hasattr(payload[key], "value"):
            payload[key] = payload[key].value
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
    "ApplySuggestedActions": ApplySuggestedActionsPayload,
    "UpdatePendingEdit": UpdatePendingEditPayload,
    "RestoreAppliedEdit": RestoreAppliedEditPayload,
    "RestoreClipBleed": RestoreClipBleedPayload,
    "SetClipFade": SetClipFadePayload,
    "TrimClipEdge": TrimClipEdgePayload,
    "RollClipJoin": RollClipJoinPayload,
    "SetJoinMode": SetJoinModePayload,
    "SetClipJoin": SetClipJoinPayload,
    "ApplyFadeRecommendations": ApplyFadeRecommendationsPayload,
    "ApplyFadeRecommendationList": ApplyFadeRecommendationListPayload,
    "SetEffectBypass": SetEffectBypassPayload,
    "AddEffect": AddEffectPayload,
    "ReconcileTranscript": ReconcileTranscriptPayload,
    "SuppressBleed": SuppressBleedPayload,
    "SuppressLowAudibility": SuppressLowAudibilityPayload,
    "SetBleedAlignmentMode": SetBleedAlignmentModePayload,
    "RemoveEffect": RemoveEffectPayload,
    "ReplaceTranscriptMatches": ReplaceTranscriptMatchesPayload,
    "CorrectTranscriptWord": CorrectTranscriptWordPayload,
    "ApplyTranscriptCleanup": ApplyTranscriptCleanupPayload,
    "VerifyTranscript": VerifyTranscriptPayload,
    "CorrectTranscriptPhrase": CorrectTranscriptPhrasePayload,
    "SetTranscriptWordSuppressed": SetTranscriptWordSuppressedPayload,
    "SetTranscriptWordAutomatic": SetTranscriptWordAutomaticPayload,
    "SetTranscriptWordsIgnored": SetTranscriptWordsIgnoredPayload,
    "SetTranscriptWordTiming": SetTranscriptWordTimingPayload,
    "AddChapter": AddChapterPayload,
    "UpdateChapter": UpdateChapterPayload,
    "DeleteChapter": DeleteChapterPayload,
    "AddSocialClip": AddSocialClipPayload,
    "UpdateSocialClip": UpdateSocialClipPayload,
    "DeleteSocialClip": DeleteSocialClipPayload,
    "SetEnvelope": SetEnvelopePayload,
    "EditSelectedRange": EditSelectedRangePayload,
    "SuggestPendingEdit": SuggestPendingEditPayload,
    "StageTimeRangeCut": StageTimeRangeCutPayload,
    "StageTextMatchCut": StageTextMatchCutPayload,
    "StageUtteranceCut": StageUtteranceCutPayload,
    "StageWordsCut": StageWordsCutPayload,
    "SplitAtTime": SplitAtTimePayload,
    "DeleteClip": DeleteClipPayload,
    "DuplicateSegment": DuplicateSegmentPayload,
    "MoveSegment": MoveSegmentPayload,
    "InsertGap": InsertGapPayload,
    "FillRoomTone": FillRoomTonePayload,
    "ApplyAutoEdits": ApplyAutoEditsPayload,
    "FadeJoins": FadeJoinsPayload,
    "CrossfadeJoins": CrossfadeJoinsPayload,
    "MoveByText": MoveByTextPayload,
    "MoveClips": MoveClipsPayload,
    "PasteSegment": PasteSegmentPayload,
    "CutRange": CutRangePayload,
    "RippleDeleteText": RippleDeleteTextPayload,
    "AddTrack": AddTrackPayload,
    "SetTrackMedia": SetTrackMediaPayload,
    "SetTrackMeta": SetTrackMetaPayload,
    "SetTrackFader": SetTrackFaderPayload,
    "SetTrackMute": SetTrackMutePayload,
    "RemoveTrack": RemoveTrackPayload,
    "ReorderTrack": ReorderTrackPayload,
}


_CODED_PAYLOAD_TYPES = frozenset(
    {"SuppressBleed", "SuppressLowAudibility", "SetBleedAlignmentMode", "FillRoomTone"}
)


def _coded_payload_error(command_type: str, exc: ValidationError) -> CodedValueError:
    errors = exc.errors(include_input=False, include_url=False, include_context=False)
    if (
        command_type == "SetBleedAlignmentMode"
        and errors
        and all(err["loc"] == ("mode",) for err in errors)
    ):
        return CodedValueError(
            "alignment mode must be auto, manual, or declined", code="invalid_mode"
        )
    problems = "; ".join(
        f"{'.'.join(str(part) for part in err['loc']) or 'payload'}: {err['msg']}" for err in errors
    )
    return CodedValueError(f"{command_type}: {problems}", code="invalid_payload")


def validate_payload(command_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Validate a payload dict for a known command type; return dumped dict."""
    model = _PAYLOAD_BY_TYPE.get(command_type)
    if model is None:
        raise CodedValueError(
            f"unknown document command: {command_type}", code="document_command_unknown"
        )
    try:
        validated = model.model_validate(payload or {})
    except ValidationError as exc:
        if command_type not in _CODED_PAYLOAD_TYPES:
            raise
        raise _coded_payload_error(command_type, exc) from exc
    out = validated.model_dump(mode="python", exclude_none=command_type == "FillRoomTone")
    if "extracts" in out and isinstance(out["extracts"], list):
        out["extracts"] = [
            e if isinstance(e, dict) else e.model_dump() if hasattr(e, "model_dump") else dict(e)
            for e in out["extracts"]
        ]
    for key in ("join_in_mode", "mode"):
        if key in out and hasattr(out[key], "value"):
            out[key] = out[key].value
    return out
