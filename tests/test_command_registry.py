"""Characterization of the document command tables: payload model, handler and guest role per type.

The snapshot was taken before the tables derived from the registry and must keep passing
unchanged.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, get_args

import pytest
from pydantic import BaseModel

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import ReviewRole
from podcast_mcp.services.document_sync import capabilities as caps
from podcast_mcp.services.document_sync import registry
from podcast_mcp.services.document_sync.commands import DocumentCommandType
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.registry import (
    COMMANDS,
    GUI_SENT,
    NO_GUI_SENDER,
    UNAUDITED,
    CommandSpec,
    Exempt,
    Gap,
    Named,
    apply_command,
    edit_surface_commands,
    exempt,
    gap,
    named,
)
from podcast_mcp.util.coded_error import CodedValueError
from script_loader import load_script

# type: (payload model, handler as module.function, guest access)
# guest access: host (host-only), comment (comment path, in no role set), commenter (proposes
# only), commenter+apply (proposes as Commenter, applies as Editor), editor (Editor applies).
SNAPSHOT: dict[str, tuple[str, str, str]] = {
    "AddComment": ("AddCommentPayload", "comments.add_comment", "comment"),
    "UpdateComment": ("UpdateCommentPayload", "comments.update_comment", "comment"),
    "ResolveComment": ("ResolveCommentPayload", "comments.resolve_comment", "comment"),
    "DeleteComment": ("DeleteCommentPayload", "comments.delete_comment", "comment"),
    "AddReply": ("AddReplyPayload", "comments.add_reply", "comment"),
    "SetActionDone": ("SetActionDonePayload", "comments.set_action_done", "comment"),
    "AddAction": ("AddActionPayload", "comments.add_action", "comment"),
    "UndoHistory": ("UndoHistoryPayload", "history.undo_history", "editor"),
    "RedoHistory": ("RedoHistoryPayload", "history.redo_history", "editor"),
    "ApproveEdits": ("ApproveEditsPayload", "edits.approve_edits", "editor"),
    "RejectEdits": ("RejectEditsPayload", "edits.reject_edits", "editor"),
    "ApplySuggestedActions": (
        "ApplySuggestedActionsPayload",
        "edits.apply_suggested_actions",
        "editor",
    ),
    "UpdatePendingEdit": (
        "UpdatePendingEditPayload",
        "edits.update_pending_edit",
        "commenter+apply",
    ),
    "RestoreAppliedEdit": ("RestoreAppliedEditPayload", "edits.restore_applied_edit", "editor"),
    "RestoreClipBleed": ("RestoreClipBleedPayload", "edits.restore_clip_bleed", "editor"),
    "SetClipFade": ("SetClipFadePayload", "edits.set_clip_fade", "editor"),
    "TrimClipEdge": ("TrimClipEdgePayload", "edits.trim_clip_edge", "editor"),
    "RollClipJoin": ("RollClipJoinPayload", "edits.roll_clip_join", "editor"),
    "SetJoinMode": ("SetJoinModePayload", "edits.set_join_mode", "editor"),
    "SetClipJoin": ("SetClipJoinPayload", "edits.set_clip_join", "editor"),
    "ApplyFadeRecommendations": (
        "ApplyFadeRecommendationsPayload",
        "edits.apply_fade_recommendations",
        "editor",
    ),
    "ApplyFadeRecommendationList": (
        "ApplyFadeRecommendationListPayload",
        "edits.apply_fade_recommendation_list",
        "editor",
    ),
    "SetEffectBypass": ("SetEffectBypassPayload", "edits.set_effect_bypass", "editor"),
    "AddEffect": ("AddEffectPayload", "edits.add_effect", "editor"),
    "ReconcileTranscript": ("ReconcileTranscriptPayload", "edits.reconcile_transcript", "editor"),
    "SuppressBleed": ("SuppressBleedPayload", "edits.suppress_bleed", "editor"),
    "SuppressLowAudibility": (
        "SuppressLowAudibilityPayload",
        "edits.suppress_low_audibility",
        "editor",
    ),
    "SetBleedAlignmentMode": (
        "SetBleedAlignmentModePayload",
        "edits.set_bleed_alignment_mode",
        "editor",
    ),
    "RemoveEffect": ("RemoveEffectPayload", "edits.remove_effect", "editor"),
    "ReplaceTranscriptMatches": (
        "ReplaceTranscriptMatchesPayload",
        "transcript.replace_transcript_matches",
        "editor",
    ),
    "CorrectTranscriptWord": (
        "CorrectTranscriptWordPayload",
        "transcript.correct_transcript_word",
        "editor",
    ),
    "ApplyTranscriptCleanup": (
        "ApplyTranscriptCleanupPayload",
        "transcript.apply_transcript_cleanup",
        "editor",
    ),
    "VerifyTranscript": ("VerifyTranscriptPayload", "transcript.verify_transcript", "editor"),
    "CorrectTranscriptPhrase": (
        "CorrectTranscriptPhrasePayload",
        "transcript.correct_transcript_phrase",
        "editor",
    ),
    "SetTranscriptWordSuppressed": (
        "SetTranscriptWordSuppressedPayload",
        "transcript.set_transcript_word_suppressed",
        "editor",
    ),
    "SetTranscriptWordAutomatic": (
        "SetTranscriptWordAutomaticPayload",
        "transcript.set_transcript_word_automatic",
        "editor",
    ),
    "SetTranscriptWordsIgnored": (
        "SetTranscriptWordsIgnoredPayload",
        "transcript.set_transcript_words_ignored",
        "editor",
    ),
    "SetTranscriptWordTiming": (
        "SetTranscriptWordTimingPayload",
        "transcript.set_transcript_word_timing",
        "editor",
    ),
    "AddChapter": ("AddChapterPayload", "markers.add_chapter", "editor"),
    "UpdateChapter": ("UpdateChapterPayload", "markers.update_chapter", "editor"),
    "DeleteChapter": ("DeleteChapterPayload", "markers.delete_chapter", "editor"),
    "SetFeedField": ("SetFeedFieldPayload", "feed.set_feed_field", "editor"),
    "ClearFeedField": ("ClearFeedFieldPayload", "feed.clear_feed_field", "editor"),
    "AddSocialClip": ("AddSocialClipPayload", "markers.add_social_clip", "editor"),
    "UpdateSocialClip": ("UpdateSocialClipPayload", "markers.update_social_clip", "editor"),
    "UpdateSocialClipDetails": (
        "UpdateSocialClipDetailsPayload",
        "markers.update_social_clip_details",
        "host",
    ),
    "DeleteSocialClip": ("DeleteSocialClipPayload", "markers.delete_social_clip", "editor"),
    "SetEnvelope": ("SetEnvelopePayload", "markers.set_envelope", "editor"),
    "EditSelectedRange": (
        "EditSelectedRangePayload",
        "edits.edit_selected_range",
        "commenter+apply",
    ),
    "SuggestPendingEdit": (
        "SuggestPendingEditPayload",
        "markers.suggest_pending_edit",
        "commenter",
    ),
    "StageTimeRangeCut": ("StageTimeRangeCutPayload", "edits.stage_time_range_cut", "editor"),
    "StageTextMatchCut": ("StageTextMatchCutPayload", "edits.stage_text_match_cut", "editor"),
    "StageUtteranceCut": ("StageUtteranceCutPayload", "edits.stage_utterance_cut", "editor"),
    "StageWordsCut": ("StageWordsCutPayload", "edits.stage_words_cut", "editor"),
    "SplitAtTime": ("SplitAtTimePayload", "edits.split_at_time", "commenter+apply"),
    "DeleteClip": ("DeleteClipPayload", "edits.delete_clip", "commenter+apply"),
    "DuplicateSegment": ("DuplicateSegmentPayload", "edits.duplicate_segment", "editor"),
    "MoveSegment": ("MoveSegmentPayload", "edits.move_segment", "editor"),
    "InsertGap": ("InsertGapPayload", "edits.insert_gap", "editor"),
    "InsertSegment": ("InsertSegmentPayload", "edits.insert_segment", "host"),
    "FillRoomTone": ("FillRoomTonePayload", "edits.fill_room_tone", "editor"),
    "ApplyAutoEdits": ("ApplyAutoEditsPayload", "edits.apply_auto_edits", "editor"),
    "ProposeTighten": ("ProposeTightenPayload", "edits.propose_tighten", "editor"),
    "ApplyEditPlan": ("ApplyEditPlanPayload", "edits.apply_edit_plan", "editor"),
    "ShortenWordGaps": ("ShortenWordGapsPayload", "edits.shorten_word_gaps", "editor"),
    "StripSilence": ("StripSilencePayload", "edits.strip_silence", "editor"),
    "FadeJoins": ("FadeJoinsPayload", "edits.fade_joins", "editor"),
    "CrossfadeJoins": ("CrossfadeJoinsPayload", "edits.crossfade_joins", "editor"),
    "MoveByText": ("MoveByTextPayload", "edits.move_by_text", "editor"),
    "MoveClips": ("MoveClipsPayload", "edits.move_clips", "editor"),
    "PasteSegment": ("PasteSegmentPayload", "edits.paste_segment", "editor"),
    "CutRange": ("CutRangePayload", "edits.cut_range", "editor"),
    "RippleDeleteText": ("RippleDeleteTextPayload", "edits.ripple_delete_text", "editor"),
    "RenameProject": ("RenameProjectPayload", "episode.rename_project", "editor"),
    "SetRecordSessionName": (
        "SetRecordSessionNamePayload",
        "episode.set_record_session_name",
        "host",
    ),
    "AcceptSessionSuggestion": (
        "AcceptSessionSuggestionPayload",
        "session_suggestion.accept_session_suggestion",
        "host",
    ),
    "SkipSessionSuggestion": (
        "SkipSessionSuggestionPayload",
        "session_suggestion.skip_session_suggestion",
        "host",
    ),
    "SelectSessionTake": (
        "SelectSessionTakePayload",
        "session_suggestion.select_session_take",
        "host",
    ),
    "AddTrack": ("AddTrackPayload", "episode.add_track", "editor"),
    "SetTrackMedia": ("SetTrackMediaPayload", "episode.set_track_media", "editor"),
    "SetTrackMeta": ("SetTrackMetaPayload", "episode.set_track_meta", "editor"),
    "SetTrackFader": ("SetTrackFaderPayload", "episode.set_track_volume", "editor"),
    "SetTrackMute": ("SetTrackMutePayload", "episode.set_track_mute", "editor"),
    "RemoveTrack": ("RemoveTrackPayload", "episode.remove_track", "editor"),
    "ReorderTrack": ("ReorderTrackPayload", "episode.reorder_track", "editor"),
}


def _handler_name(handler) -> str:
    return f"{handler.__module__.rsplit('.', 1)[1]}.{handler.__name__}"


def _access(command_type: str) -> str:
    if command_type in caps.HOST_ONLY_DOCUMENT_COMMANDS:
        return "host"
    if command_type in caps.COMMENT_COMMANDS:
        return "comment"
    suggest = command_type in caps.SUGGEST_COMMANDS
    apply = command_type in caps.EDIT_COMMANDS
    if suggest:
        return "commenter+apply" if apply else "commenter"
    return "editor" if apply else "none"


def test_snapshot_covers_every_command_type() -> None:
    assert set(SNAPSHOT) == set(get_args(DocumentCommandType))
    assert len(SNAPSHOT) == 85


@pytest.mark.parametrize("command_type", sorted(SNAPSHOT))
def test_command_type_payload_handler_and_access(command_type: str) -> None:
    payload, handler, access = SNAPSHOT[command_type]
    assert COMMANDS[command_type].payload.__name__ == payload
    assert _handler_name(COMMANDS[command_type].handler) == handler
    assert _access(command_type) == access


def test_role_sets_are_exactly_the_snapshot() -> None:
    by_access = {
        a: {t for t, (_, _, acc) in SNAPSHOT.items() if acc == a}
        for a in ("host", "comment", "commenter", "commenter+apply", "editor")
    }
    assert by_access["host"] == caps.HOST_ONLY_DOCUMENT_COMMANDS
    assert by_access["comment"] == caps.COMMENT_COMMANDS
    assert by_access["commenter"] | by_access["commenter+apply"] == caps.SUGGEST_COMMANDS
    assert by_access["commenter+apply"] | by_access["editor"] == caps.EDIT_COMMANDS
    assert {"SplitAtTime", "DeleteClip"} == caps.STRUCTURAL_COMMANDS
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.VIEWER] == frozenset()
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.COMMENTER] == caps.SUGGEST_COMMANDS
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.EDITOR] == (
        caps.EDIT_COMMANDS | caps.SUGGEST_COMMANDS
    )


UNAUDITED_TYPES = [
    "AddAction",
    "AddEffect",
    "ApplyAutoEdits",
    "ApplyEditPlan",
    "ApplyFadeRecommendationList",
    "ApplyTranscriptCleanup",
    "CrossfadeJoins",
    "CutRange",
    "DeleteComment",
    "FadeJoins",
    "InsertGap",
    "InsertSegment",
    "MoveByText",
    "ProposeTighten",
    "ReconcileTranscript",
    "RemoveEffect",
    "RippleDeleteText",
    "SetBleedAlignmentMode",
    "SetJoinMode",
    "ShortenWordGaps",
    "StageTextMatchCut",
    "StageTimeRangeCut",
    "StageUtteranceCut",
    "StageWordsCut",
    "StripSilence",
    "SuggestPendingEdit",
    "SuppressBleed",
    "SuppressLowAudibility",
    "VerifyTranscript",
]


def _checker():
    return load_script("check_capabilities_manifest")


def test_every_spec_decides_gui_mcp_and_cli() -> None:
    for command_type, spec in COMMANDS.items():
        for surface in ("gui", "mcp", "cli"):
            assert isinstance(getattr(spec, surface), Named | Exempt | Gap), (command_type, surface)


def test_a_spec_without_a_surface_decision_does_not_construct() -> None:
    base = COMMANDS["DeleteChapter"]
    with pytest.raises(TypeError):
        CommandSpec(payload=base.payload, handler=base.handler, gui=GUI_SENT, mcp=named("x"))  # type: ignore[call-arg]
    with pytest.raises(CodedValueError):
        named()
    with pytest.raises(CodedValueError):
        exempt("  ")
    with pytest.raises(CodedValueError):
        gap("")
    with pytest.raises(CodedValueError):
        gap("covers part", partial=True)


def test_a_host_only_spec_has_no_guest_role_and_a_propose_only_one_is_a_commenter() -> None:
    base = COMMANDS["DeleteChapter"]

    def spec(**role: Any) -> CommandSpec:
        return CommandSpec(
            payload=base.payload,
            handler=base.handler,
            gui=GUI_SENT,
            mcp=GUI_SENT,
            cli=GUI_SENT,
            **role,
        )

    with pytest.raises(CodedValueError):
        spec(guest=ReviewRole.EDITOR, host_only_reason="x")
    with pytest.raises(CodedValueError):
        spec(guest=ReviewRole.EDITOR, editor_applies=False)
    with pytest.raises(CodedValueError):
        spec(host_only_reason=" ")


def test_a_command_type_missing_from_the_registry_fails_the_completeness_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    short = {t: s for t, s in COMMANDS.items() if t != "RenameProject"}
    monkeypatch.setattr(registry, "COMMANDS", short)
    with pytest.raises(RuntimeError, match=r"missing .*RenameProject"):
        registry._check_complete()


def test_a_registry_payload_that_differs_from_payloads_fails_the_completeness_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    swapped = {**COMMANDS, "AddChapter": replace(COMMANDS["AddChapter"], payload=BaseModel)}
    monkeypatch.setattr(registry, "COMMANDS", swapped)
    with pytest.raises(RuntimeError, match="AddChapter"):
        registry._check_complete()


def test_the_registry_agrees_with_the_gui_sources_and_the_exported_schema() -> None:
    mod = _checker()
    schema_types = mod._schema_command_types()
    assert mod.registry_errors(mod.gui_document_command_types(schema_types), schema_types) == []


def test_the_registry_check_is_two_sided() -> None:
    mod = _checker()
    schema_types = mod._schema_command_types()
    gui = mod.gui_document_command_types(schema_types)
    assert mod.registry_errors(gui | {"AddEffect"}, schema_types) == [
        "registry: GUI sends AddEffect but its gui decision is not named(...)"
    ]
    assert mod.registry_errors(gui - {"AddChapter"}, schema_types) == [
        "registry: AddChapter gui is named(...) but no GUI source sends it; exempt it"
    ]
    assert mod.registry_errors(gui, schema_types - {"AddChapter"}) == [
        "registry: AddChapter is not a type in schemas/document-commands.schema.json"
    ]
    assert mod.registry_errors(gui, schema_types | {"Invented"}) == [
        "registry: Invented is in schemas/document-commands.schema.json but has no registry entry"
    ]


def test_types_the_gui_never_sends_are_unaudited_for_agents_and_that_list_only_shrinks() -> None:
    assert sorted(t for t, s in COMMANDS.items() if s.gui is NO_GUI_SENDER) == UNAUDITED_TYPES
    assert sorted(t for t, s in COMMANDS.items() if s.mcp is UNAUDITED) == UNAUDITED_TYPES
    assert sorted(t for t, s in COMMANDS.items() if s.cli is UNAUDITED) == UNAUDITED_TYPES


def test_the_edit_surface_view_lists_exactly_the_gui_sent_types() -> None:
    view = edit_surface_commands()
    assert set(view) == set(COMMANDS) - set(UNAUDITED_TYPES)
    assert view["AddTrack"]["cli"] == []
    assert view["AddTrack"]["gap"]["reason"].startswith("No CLI creates an empty track")
    assert view["EditSelectedRange"]["gap"]["partial"] is True
    assert view["EditSelectedRange"]["cli"] == ["podcast edit propose-range-cut"]


def test_an_unknown_command_type_is_refused_by_dispatch_and_validation(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(CodedValueError) as dispatch:
        apply_command(ws, "NotACommand", {})
    assert dispatch.value.code == "document_command_unknown"
    with pytest.raises(CodedValueError) as validate:
        validate_payload("NotACommand", {})
    assert validate.value.code == "document_command_unknown"
