"""One registry of document commands: payload, handler, guest access and surface decisions.

Every document command type has exactly one ``CommandSpec``. Handler dispatch (``apply_command``),
payload validation (``payloads.validate_payload``) and the guest role sets in ``capabilities``
derive from it. An entry that names no decision for the GUI, MCP and CLI surfaces does not
construct, and a type with no entry fails at import.

- ``named(...)`` lists the sender or the tools that perform the edit (GUI source, MCP tool names,
  ``podcast ...`` commands). ``scripts/check_capabilities_manifest.py`` resolves each name.
- ``exempt(reason)`` records that the surface deliberately has no twin.
- ``gap(reason, ...)`` records a missing twin. The pinned list in
  ``tests/test_capabilities_manifest.py`` only shrinks.

This module sits above ``payloads`` and ``handlers`` and below ``capabilities`` and ``service``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, get_args

from pydantic import BaseModel

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import ReviewRole
from podcast_mcp.services.document_sync import payloads as p
from podcast_mcp.services.document_sync.commands import DocumentCommandType
from podcast_mcp.services.document_sync.handlers import (
    comments,
    edits,
    episode,
    feed,
    history,
    markers,
    session_suggestion,
    transcript,
)
from podcast_mcp.util.coded_error import CodedValueError

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]
Family = Literal["comments", "transcript", "structural"]


@dataclass(frozen=True)
class Named:
    """The surface performs the edit; ``names`` are what the checker resolves."""

    names: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.names or not all(n.strip() for n in self.names):
            raise CodedValueError(
                "a named surface decision needs at least one nonempty name",
                code="command_spec_invalid",
            )


@dataclass(frozen=True)
class Exempt:
    """The surface deliberately has no twin."""

    reason: str

    def __post_init__(self) -> None:
        if not self.reason.strip():
            raise CodedValueError(
                "an exempt surface decision needs a reason", code="command_spec_invalid"
            )


@dataclass(frozen=True)
class Gap:
    """The surface lacks a twin. ``names`` are twins that cover part of the edit (``partial``)."""

    reason: str
    names: tuple[str, ...] = ()
    partial: bool = False

    def __post_init__(self) -> None:
        if not self.reason.strip():
            raise CodedValueError(
                "a gap surface decision needs a reason", code="command_spec_invalid"
            )
        if self.partial and not self.names:
            raise CodedValueError(
                "a partial gap names the twin that covers part of the edit",
                code="command_spec_invalid",
            )


Decision = Named | Exempt | Gap


def named(*names: str) -> Named:
    return Named(names)


def exempt(reason: str) -> Exempt:
    return Exempt(reason)


def gap(reason: str, *names: str, partial: bool = False) -> Gap:
    return Gap(reason, names, partial)


@dataclass(frozen=True)
class CommandSpec:
    """Everything the document plane knows about one command type.

    ``guest`` is the least review role that may submit it; ``None`` means no share role runs it
    through the document gate. ``editor_applies`` is False for a command an Editor only
    proposes. ``host_only_reason`` marks a host-only command and says why. ``family`` groups
    commands that share a projection or a guest path.
    """

    payload: type[BaseModel]
    handler: Handler
    gui: Decision
    mcp: Decision
    cli: Decision
    guest: ReviewRole | None = None
    editor_applies: bool = True
    host_only_reason: str | None = None
    family: Family | None = None

    def __post_init__(self) -> None:
        if self.host_only_reason is not None and not self.host_only_reason.strip():
            raise CodedValueError("a host-only command needs a reason", code="command_spec_invalid")
        if self.host_only_reason and self.guest is not None:
            raise CodedValueError(
                "a host-only command has no guest role", code="command_spec_invalid"
            )
        if not self.editor_applies and self.guest is not ReviewRole.COMMENTER:
            raise CodedValueError(
                "only a Commenter-level command can be propose-only", code="command_spec_invalid"
            )
        grants = (
            self.guest is not None,
            self.host_only_reason is not None,
            self.family == "comments",
        )
        if sum(grants) != 1:
            raise CodedValueError(
                "a command needs exactly one of a guest role, a host-only reason or the comments family",
                code="command_spec_invalid",
            )
        if self.family == "comments" and self.guest is not None:
            raise CodedValueError(
                "comment commands take the comment path, not a document role",
                code="command_spec_invalid",
            )


GUI_SENT = named("gui/web/src")
NO_GUI_SENDER = exempt("the GUI sends no such command; agents and batch tools do")
UNAUDITED = gap("not audited: this type has no GUI sender, so its MCP and CLI twins are unrecorded")

COMMANDS: Mapping[str, CommandSpec] = MappingProxyType(
    {
        "AddComment": CommandSpec(
            payload=p.AddCommentPayload,
            handler=comments.add_comment,
            family="comments",
            gui=GUI_SENT,
            mcp=named("add_comment_tool"),
            cli=named("podcast comment add"),
        ),
        "UpdateComment": CommandSpec(
            payload=p.UpdateCommentPayload,
            handler=comments.update_comment,
            family="comments",
            gui=GUI_SENT,
            mcp=named("update_comment_tool"),
            cli=named("podcast comment update"),
        ),
        "ResolveComment": CommandSpec(
            payload=p.ResolveCommentPayload,
            handler=comments.resolve_comment,
            family="comments",
            gui=GUI_SENT,
            mcp=named("resolve_comment_tool"),
            cli=named("podcast comment resolve"),
        ),
        "DeleteComment": CommandSpec(
            payload=p.DeleteCommentPayload,
            handler=comments.delete_comment,
            family="comments",
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "AddReply": CommandSpec(
            payload=p.AddReplyPayload,
            handler=comments.add_reply,
            family="comments",
            gui=GUI_SENT,
            mcp=named("add_comment_reply_tool"),
            cli=named("podcast comment reply"),
        ),
        "SetActionDone": CommandSpec(
            payload=p.SetActionDonePayload,
            handler=comments.set_action_done,
            family="comments",
            gui=GUI_SENT,
            mcp=named("set_comment_action_done_tool"),
            cli=named("podcast comment done"),
        ),
        "AddAction": CommandSpec(
            payload=p.AddActionPayload,
            handler=comments.add_action,
            family="comments",
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "UndoHistory": CommandSpec(
            payload=p.UndoHistoryPayload,
            handler=history.undo_history,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("history_undo"),
            cli=named("podcast undo"),
        ),
        "RedoHistory": CommandSpec(
            payload=p.RedoHistoryPayload,
            handler=history.redo_history,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("history_redo"),
            cli=named("podcast redo"),
        ),
        "ApproveEdits": CommandSpec(
            payload=p.ApproveEditsPayload,
            handler=edits.approve_edits,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("approve_edits_tool"),
            cli=named("podcast edit approve"),
        ),
        "RejectEdits": CommandSpec(
            payload=p.RejectEditsPayload,
            handler=edits.reject_edits,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("reject_edits_tool"),
            cli=named("podcast edit reject"),
        ),
        "ApplySuggestedActions": CommandSpec(
            payload=p.ApplySuggestedActionsPayload,
            handler=edits.apply_suggested_actions,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("apply_suggested_actions_tool"),
            cli=named("podcast edit apply-suggested"),
        ),
        "UpdatePendingEdit": CommandSpec(
            payload=p.UpdatePendingEditPayload,
            handler=edits.update_pending_edit,
            guest=ReviewRole.COMMENTER,
            gui=GUI_SENT,
            mcp=named("update_pending_edit_tool"),
            cli=gap("Found by this contract: update_pending_edit_tool has no CLI twin"),
        ),
        "RestoreAppliedEdit": CommandSpec(
            payload=p.RestoreAppliedEditPayload,
            handler=edits.restore_applied_edit,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("revert_applied_edit_tool"),
            cli=named("podcast edit restore-edit"),
        ),
        "RestoreClipBleed": CommandSpec(
            payload=p.RestoreClipBleedPayload,
            handler=edits.restore_clip_bleed,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("restore_clip_bleed_tool"),
            cli=named("podcast edit restore-clip-bleed"),
        ),
        "SetClipFade": CommandSpec(
            payload=p.SetClipFadePayload,
            handler=edits.set_clip_fade,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("set_clip_fade_tool"),
            cli=gap("daw.edit.setClipFade has MCP only"),
        ),
        "TrimClipEdge": CommandSpec(
            payload=p.TrimClipEdgePayload,
            handler=edits.trim_clip_edge,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("trim_clip_edge_tool"),
            cli=named("podcast edit trim-clip"),
        ),
        "RollClipJoin": CommandSpec(
            payload=p.RollClipJoinPayload,
            handler=edits.roll_clip_join,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("roll_clip_join_tool"),
            cli=named("podcast edit roll-join"),
        ),
        "SetJoinMode": CommandSpec(
            payload=p.SetJoinModePayload,
            handler=edits.set_join_mode,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SetClipJoin": CommandSpec(
            payload=p.SetClipJoinPayload,
            handler=edits.set_clip_join,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("set_clip_join_tool"),
            cli=named("podcast edit set-clip-join"),
        ),
        "ApplyFadeRecommendations": CommandSpec(
            payload=p.ApplyFadeRecommendationsPayload,
            handler=edits.apply_fade_recommendations,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("apply_fade_recommendations_tool"),
            cli=gap(
                "No CLI applies fade recommendations; podcast edit recommend-fades only lists them"
            ),
        ),
        "ApplyFadeRecommendationList": CommandSpec(
            payload=p.ApplyFadeRecommendationListPayload,
            handler=edits.apply_fade_recommendation_list,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SetEffectBypass": CommandSpec(
            payload=p.SetEffectBypassPayload,
            handler=edits.set_effect_bypass,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("set_effect_bypass_tool"),
            cli=gap("Found by this contract: set_effect_bypass_tool has no CLI twin"),
        ),
        "AddEffect": CommandSpec(
            payload=p.AddEffectPayload,
            handler=edits.add_effect,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "ReconcileTranscript": CommandSpec(
            payload=p.ReconcileTranscriptPayload,
            handler=edits.reconcile_transcript,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SuppressBleed": CommandSpec(
            payload=p.SuppressBleedPayload,
            handler=edits.suppress_bleed,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SuppressLowAudibility": CommandSpec(
            payload=p.SuppressLowAudibilityPayload,
            handler=edits.suppress_low_audibility,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SetBleedAlignmentMode": CommandSpec(
            payload=p.SetBleedAlignmentModePayload,
            handler=edits.set_bleed_alignment_mode,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "RemoveEffect": CommandSpec(
            payload=p.RemoveEffectPayload,
            handler=edits.remove_effect,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "ReplaceTranscriptMatches": CommandSpec(
            payload=p.ReplaceTranscriptMatchesPayload,
            handler=transcript.replace_transcript_matches,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("find_replace_transcript_tool"),
            cli=named("podcast transcript find-replace"),
        ),
        "CorrectTranscriptWord": CommandSpec(
            payload=p.CorrectTranscriptWordPayload,
            handler=transcript.correct_transcript_word,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("correct_transcript_tool"),
            cli=named("podcast transcript correct"),
        ),
        "ApplyTranscriptCleanup": CommandSpec(
            payload=p.ApplyTranscriptCleanupPayload,
            handler=transcript.apply_transcript_cleanup,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "VerifyTranscript": CommandSpec(
            payload=p.VerifyTranscriptPayload,
            handler=transcript.verify_transcript,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "CorrectTranscriptPhrase": CommandSpec(
            payload=p.CorrectTranscriptPhrasePayload,
            handler=transcript.correct_transcript_phrase,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("correct_transcript_phrase_tool"),
            cli=named("podcast transcript correct-phrase"),
        ),
        "SetTranscriptWordSuppressed": CommandSpec(
            payload=p.SetTranscriptWordSuppressedPayload,
            handler=transcript.set_transcript_word_suppressed,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("set_word_suppressed_tool"),
            cli=named("podcast transcript suppress-word"),
        ),
        "SetTranscriptWordAutomatic": CommandSpec(
            payload=p.SetTranscriptWordAutomaticPayload,
            handler=transcript.set_transcript_word_automatic,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("set_word_automatic_tool"),
            cli=named("podcast transcript suppress-word --automatic"),
        ),
        "SetTranscriptWordsIgnored": CommandSpec(
            payload=p.SetTranscriptWordsIgnoredPayload,
            handler=transcript.set_transcript_words_ignored,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("set_words_ignored_tool"),
            cli=gap("daw.transcript.ignore has MCP only"),
        ),
        "SetTranscriptWordTiming": CommandSpec(
            payload=p.SetTranscriptWordTimingPayload,
            handler=transcript.set_transcript_word_timing,
            guest=ReviewRole.EDITOR,
            family="transcript",
            gui=GUI_SENT,
            mcp=named("set_word_timing_tool"),
            cli=named("podcast transcript set-word-timing"),
        ),
        "AddChapter": CommandSpec(
            payload=p.AddChapterPayload,
            handler=markers.add_chapter,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("add_chapter_tool"),
            cli=named("podcast edit add-chapter"),
        ),
        "UpdateChapter": CommandSpec(
            payload=p.UpdateChapterPayload,
            handler=markers.update_chapter,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=gap("retitling or moving a chapter has no agent twin"),
            cli=gap("retitling or moving a chapter has no agent twin"),
        ),
        "DeleteChapter": CommandSpec(
            payload=p.DeleteChapterPayload,
            handler=markers.delete_chapter,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("remove_chapter_tool"),
            cli=named("podcast edit remove-chapter"),
        ),
        "SetFeedField": CommandSpec(
            payload=p.SetFeedFieldPayload,
            handler=feed.set_feed_field,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("feed_set"),
            cli=named("podcast feed set"),
        ),
        "ClearFeedField": CommandSpec(
            payload=p.ClearFeedFieldPayload,
            handler=feed.clear_feed_field,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("feed_unset"),
            cli=named("podcast feed unset"),
        ),
        "AddSocialClip": CommandSpec(
            payload=p.AddSocialClipPayload,
            handler=markers.add_social_clip,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=gap(
                "a hand-placed social clip has no agent twin; propose_social_clips_tool only proposes"
            ),
            cli=gap(
                "a hand-placed social clip has no agent twin; propose_social_clips_tool only proposes"
            ),
        ),
        "UpdateSocialClip": CommandSpec(
            payload=p.UpdateSocialClipPayload,
            handler=markers.update_social_clip,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=gap("trimming a social clip has no agent twin"),
            cli=gap("trimming a social clip has no agent twin"),
        ),
        "UpdateSocialClipDetails": CommandSpec(
            payload=p.UpdateSocialClipDetailsPayload,
            handler=markers.update_social_clip_details,
            host_only_reason="approving a clip decides what exports, so a share link never retitles or approves one",
            gui=GUI_SENT,
            mcp=gap("editing a social clip's title and details has no agent twin"),
            cli=gap("editing a social clip's title and details has no agent twin"),
        ),
        "DeleteSocialClip": CommandSpec(
            payload=p.DeleteSocialClipPayload,
            handler=markers.delete_social_clip,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=gap(
                "no tool deletes a social clip; reject_social_clips_tool changes a proposal's state, not the clip"
            ),
            cli=gap(
                "no tool deletes a social clip; reject_social_clips_tool changes a proposal's state, not the clip"
            ),
        ),
        "SetEnvelope": CommandSpec(
            payload=p.SetEnvelopePayload,
            handler=markers.set_envelope,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("set_envelope"),
            cli=gap("daw.envelope.addPoint has MCP only"),
        ),
        "EditSelectedRange": CommandSpec(
            payload=p.EditSelectedRangePayload,
            handler=edits.edit_selected_range,
            guest=ReviewRole.COMMENTER,
            gui=GUI_SENT,
            mcp=named("propose_range_cut_tool", "propose_range_mute_tool"),
            cli=gap(
                "The GUI sends action cut or mute; the CLI covers cut only, so mute has no CLI (daw.range.mute)",
                "podcast edit propose-range-cut",
                partial=True,
            ),
        ),
        "SuggestPendingEdit": CommandSpec(
            payload=p.SuggestPendingEditPayload,
            handler=markers.suggest_pending_edit,
            guest=ReviewRole.COMMENTER,
            editor_applies=False,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "StageTimeRangeCut": CommandSpec(
            payload=p.StageTimeRangeCutPayload,
            handler=edits.stage_time_range_cut,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "StageTextMatchCut": CommandSpec(
            payload=p.StageTextMatchCutPayload,
            handler=edits.stage_text_match_cut,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "StageUtteranceCut": CommandSpec(
            payload=p.StageUtteranceCutPayload,
            handler=edits.stage_utterance_cut,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "StageWordsCut": CommandSpec(
            payload=p.StageWordsCutPayload,
            handler=edits.stage_words_cut,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "SplitAtTime": CommandSpec(
            payload=p.SplitAtTimePayload,
            handler=edits.split_at_time,
            guest=ReviewRole.COMMENTER,
            family="structural",
            gui=GUI_SENT,
            mcp=named("split_clip_tool"),
            cli=gap("daw.edit.split and daw.edit.bladeCut have MCP only"),
        ),
        "DeleteClip": CommandSpec(
            payload=p.DeleteClipPayload,
            handler=edits.delete_clip,
            guest=ReviewRole.COMMENTER,
            family="structural",
            gui=GUI_SENT,
            mcp=named("delete_clips_tool"),
            cli=named("podcast edit delete-clips"),
        ),
        "DuplicateSegment": CommandSpec(
            payload=p.DuplicateSegmentPayload,
            handler=edits.duplicate_segment,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("duplicate_segment_tool"),
            cli=gap(
                "No single CLI command duplicates a segment; copy-segment then paste-segment composes it"
            ),
        ),
        "MoveSegment": CommandSpec(
            payload=p.MoveSegmentPayload,
            handler=edits.move_segment,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("move_segment_tool"),
            cli=named("podcast edit move"),
        ),
        "InsertGap": CommandSpec(
            payload=p.InsertGapPayload,
            handler=edits.insert_gap,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "InsertSegment": CommandSpec(
            payload=p.InsertSegmentPayload,
            handler=edits.insert_segment,
            host_only_reason="reads the host's own segment library, which a share link never reaches",
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "FillRoomTone": CommandSpec(
            payload=p.FillRoomTonePayload,
            handler=edits.fill_room_tone,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("fill_with_room_tone_tool"),
            cli=gap("daw.range.fillRoomTone has MCP only"),
        ),
        "ApplyAutoEdits": CommandSpec(
            payload=p.ApplyAutoEditsPayload,
            handler=edits.apply_auto_edits,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "ProposeTighten": CommandSpec(
            payload=p.ProposeTightenPayload,
            handler=edits.propose_tighten,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "ApplyEditPlan": CommandSpec(
            payload=p.ApplyEditPlanPayload,
            handler=edits.apply_edit_plan,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "ShortenWordGaps": CommandSpec(
            payload=p.ShortenWordGapsPayload,
            handler=edits.shorten_word_gaps,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "StripSilence": CommandSpec(
            payload=p.StripSilencePayload,
            handler=edits.strip_silence,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "FadeJoins": CommandSpec(
            payload=p.FadeJoinsPayload,
            handler=edits.fade_joins,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "CrossfadeJoins": CommandSpec(
            payload=p.CrossfadeJoinsPayload,
            handler=edits.crossfade_joins,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "MoveByText": CommandSpec(
            payload=p.MoveByTextPayload,
            handler=edits.move_by_text,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "MoveClips": CommandSpec(
            payload=p.MoveClipsPayload,
            handler=edits.move_clips,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("move_clips_tool"),
            cli=named("podcast edit move-clips"),
        ),
        "PasteSegment": CommandSpec(
            payload=p.PasteSegmentPayload,
            handler=edits.paste_segment,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("paste_segment_tool"),
            cli=named("podcast edit paste-segment"),
        ),
        "CutRange": CommandSpec(
            payload=p.CutRangePayload,
            handler=edits.cut_range,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "RippleDeleteText": CommandSpec(
            payload=p.RippleDeleteTextPayload,
            handler=edits.ripple_delete_text,
            guest=ReviewRole.EDITOR,
            gui=NO_GUI_SENDER,
            mcp=UNAUDITED,
            cli=UNAUDITED,
        ),
        "RenameProject": CommandSpec(
            payload=p.RenameProjectPayload,
            handler=episode.rename_project,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=gap("the GUI rename shipped with no MCP or CLI tool"),
            cli=gap("the GUI rename shipped with no MCP or CLI tool"),
        ),
        "SetRecordSessionName": CommandSpec(
            payload=p.SetRecordSessionNamePayload,
            handler=episode.set_record_session_name,
            host_only_reason="naming a record session edits who the host recorded with",
            gui=GUI_SENT,
            mcp=gap("the record-session rename shipped with no MCP or CLI tool"),
            cli=gap("the record-session rename shipped with no MCP or CLI tool"),
        ),
        "AcceptSessionSuggestion": CommandSpec(
            payload=p.AcceptSessionSuggestionPayload,
            handler=session_suggestion.accept_session_suggestion,
            host_only_reason="placing a staged recording is the host's call",
            gui=GUI_SENT,
            mcp=named("accept_session_suggestion_tool"),
            cli=named("podcast review accept-session-suggestion"),
        ),
        "SkipSessionSuggestion": CommandSpec(
            payload=p.SkipSessionSuggestionPayload,
            handler=session_suggestion.skip_session_suggestion,
            host_only_reason="discarding a staged recording is the host's call",
            gui=GUI_SENT,
            mcp=named("skip_session_suggestion_tool"),
            cli=named("podcast review skip-session-suggestion"),
        ),
        "SelectSessionTake": CommandSpec(
            payload=p.SelectSessionTakePayload,
            handler=session_suggestion.select_session_take,
            host_only_reason="choosing a staged recording's take is the host's call",
            gui=GUI_SENT,
            mcp=named("select_session_take_tool"),
            cli=named("podcast review select-session-take"),
        ),
        "AddTrack": CommandSpec(
            payload=p.AddTrackPayload,
            handler=episode.add_track,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_add", "track_add_empty_tool"),
            cli=gap(
                "No CLI creates an empty track; podcast episode add-track imports media, which is a different edit (daw.track.add)"
            ),
        ),
        "SetTrackMedia": CommandSpec(
            payload=p.SetTrackMediaPayload,
            handler=episode.set_track_media,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_set_media_tool"),
            cli=gap("daw.media.import has MCP only"),
        ),
        "SetTrackMeta": CommandSpec(
            payload=p.SetTrackMetaPayload,
            handler=episode.set_track_meta,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_set_meta_tool"),
            cli=gap(
                "track_set_meta_tool calls EpisodeService directly and no CLI sets a track's label, role or speaker"
            ),
        ),
        "SetTrackFader": CommandSpec(
            payload=p.SetTrackFaderPayload,
            handler=episode.set_track_volume,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_set_volume_tool"),
            cli=named("podcast episode set-track-volume"),
        ),
        "SetTrackMute": CommandSpec(
            payload=p.SetTrackMutePayload,
            handler=episode.set_track_mute,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_set_mute_tool"),
            cli=named("podcast episode set-track-mute"),
        ),
        "RemoveTrack": CommandSpec(
            payload=p.RemoveTrackPayload,
            handler=episode.remove_track,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_remove_tool"),
            cli=gap("daw.track.remove has MCP only"),
        ),
        "ReorderTrack": CommandSpec(
            payload=p.ReorderTrackPayload,
            handler=episode.reorder_track,
            guest=ReviewRole.EDITOR,
            gui=GUI_SENT,
            mcp=named("track_reorder_tool"),
            cli=named("podcast episode reorder-track"),
        ),
    }
)


def _check_complete() -> None:
    types = set(get_args(DocumentCommandType))
    if set(COMMANDS) != types:
        raise RuntimeError(
            "document command registry out of sync with DocumentCommandType: "
            f"missing {sorted(types - set(COMMANDS))}, extra {sorted(set(COMMANDS) - types)}"
        )
    if set(p.PAYLOAD_MODELS) != set(COMMANDS):
        raise RuntimeError(
            "payload models out of sync with the document command registry: "
            f"payload without a spec {sorted(set(p.PAYLOAD_MODELS) - set(COMMANDS))}, "
            f"spec without a payload {sorted(set(COMMANDS) - set(p.PAYLOAD_MODELS))}"
        )
    wrong = sorted(t for t, s in COMMANDS.items() if p.PAYLOAD_MODELS.get(t) is not s.payload)
    if wrong:
        raise RuntimeError(f"registry payload differs from the payloads module for {wrong}")


_check_complete()


def commands_in_family(family: Family) -> frozenset[str]:
    return frozenset(t for t, s in COMMANDS.items() if s.family == family)


def gui_named_types() -> frozenset[str]:
    return frozenset(t for t, s in COMMANDS.items() if isinstance(s.gui, Named))


def apply_command(
    ws: ProjectWorkspace, command_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    spec = COMMANDS.get(command_type)
    if spec is None:
        raise CodedValueError(
            f"unknown document command: {command_type}", code="document_command_unknown"
        )
    return spec.handler(ws, payload)


def edit_surface_commands() -> Mapping[str, Mapping[str, Any]]:
    """The GUI-sent commands in the shape ``scripts/check_capabilities_manifest.py`` checks."""
    view: dict[str, dict[str, Any]] = {}
    for command_type in sorted(gui_named_types()):
        spec = COMMANDS[command_type]
        entry: dict[str, Any] = {"mcp": [], "cli": []}
        for surface in ("mcp", "cli"):
            decision = getattr(spec, surface)
            if isinstance(decision, Named | Gap):
                entry[surface] = list(decision.names)
            if isinstance(decision, Gap):
                entry["gap"] = {"reason": decision.reason}
                if decision.partial:
                    entry["gap"]["partial"] = True
            elif isinstance(decision, Exempt):
                entry["exempt"] = {"reason": decision.reason}
        view[command_type] = entry
    return view
