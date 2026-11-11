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
    "SetClipsFade": ("SetClipsFadePayload", "edits.set_clips_fade", "editor"),
    "SetClipGain": ("SetClipGainPayload", "edits.set_clip_gain", "editor"),
    "SetClipsGain": ("SetClipsGainPayload", "edits.set_clips_gain", "editor"),
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
    "ProposeSocialClips": (
        "ProposeSocialClipsPayload",
        "markers.propose_social_clips",
        "host",
    ),
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
    "ExtractRoomToneBed": ("ExtractRoomToneBedPayload", "edits.extract_room_tone_bed", "host"),
    "ClearExtractedRoomToneBed": (
        "ClearExtractedRoomToneBedPayload",
        "edits.clear_extracted_room_tone_bed",
        "host",
    ),
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
    assert len(SNAPSHOT) == 91


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


def test_a_spec_needs_exactly_one_of_a_guest_role_a_host_only_reason_or_the_comments_family() -> (
    None
):
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

    with pytest.raises(CodedValueError, match="exactly one"):
        spec()
    with pytest.raises(CodedValueError, match="exactly one"):
        spec(host_only_reason="x", family="comments")
    assert spec(guest=ReviewRole.EDITOR).guest is ReviewRole.EDITOR
    assert spec(host_only_reason="x").host_only_reason == "x"
    assert spec(family="comments").family == "comments"


def test_a_command_type_missing_from_the_registry_fails_the_completeness_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    short = {t: s for t, s in COMMANDS.items() if t != "RenameProject"}
    monkeypatch.setattr(registry, "COMMANDS", short)
    with pytest.raises(RuntimeError, match=r"missing .*RenameProject"):
        registry._check_complete()


def test_a_payload_model_without_a_registry_spec_fails_the_completeness_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        registry.p, "PAYLOAD_MODELS", {**registry.p.PAYLOAD_MODELS, "Invented": BaseModel}
    )
    with pytest.raises(RuntimeError, match=r"payload.*Invented"):
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


GENERIC_MCP = "submit_document_command_tool"
GENERIC_CLI = "podcast doc submit"

AUDITED_TWINS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "AddAction": (
        ("add_comment_action_tool", GENERIC_MCP),
        ("podcast comment add-action",),
    ),
    "AddEffect": (("add_effect_tool",), ("podcast doc submit",)),
    "RemoveEffect": (("remove_effect_tool",), ("podcast doc submit",)),
    "ApplyAutoEdits": (("apply_edits",), ("podcast apply-edits",)),
    "ProposeTighten": (("propose_edits",), ("podcast propose-edits",)),
    "ApplyEditPlan": (("apply_edit_plan_tool",), ("podcast doc submit",)),
    "ApplyFadeRecommendationList": (("apply_fade_recommendations_tool",), ("podcast doc submit",)),
    "ApplyTranscriptCleanup": (
        ("apply_transcript_cleanup_tool",),
        ("podcast transcript cleanup-batch",),
    ),
    "VerifyTranscript": (("verify_transcript_tool",), ("podcast doc submit",)),
    "ReconcileTranscript": (
        ("reconcile_transcript_tool",),
        ("podcast edit reconcile-transcript",),
    ),
    "SuppressBleed": (("apply_bleed_suppression_tool",), ("podcast edit suppress-bleed",)),
    "SuppressLowAudibility": (
        ("apply_low_audibility_suppression_tool",),
        ("podcast edit suppress-low-audibility",),
    ),
    "SetBleedAlignmentMode": (
        ("set_retained_bleed_alignment_mode_tool",),
        ("podcast edit bleed-alignment-choice",),
    ),
    "CutRange": (("ripple_delete_tool",), ("podcast edit ripple-delete",)),
    "RippleDeleteText": (("ripple_delete_text_tool",), ("podcast edit ripple-delete",)),
    "StageTimeRangeCut": (("cut_time_range_tool",), ("podcast edit cut-range",)),
    "StageTextMatchCut": (("cut_text_match_tool",), ("podcast edit cut-text",)),
    "StageUtteranceCut": (("cut_utterance_tool",), ("podcast edit cut-utterance",)),
    "StageWordsCut": (("cut_words_tool",), ("podcast doc submit",)),
    "StripSilence": (("strip_silence_tool",), ("podcast edit strip-silence",)),
    "ShortenWordGaps": (("shorten_gaps_tool",), ("podcast edit shorten-gaps",)),
    "FadeJoins": (("fade_joins_tool",), ("podcast edit fade-joins",)),
    "CrossfadeJoins": (("crossfade_joins_tool",), ("podcast edit crossfade-joins",)),
    "SetJoinMode": (("set_join_mode_tool",), ("podcast doc submit",)),
    "InsertGap": (("insert_gap_tool",), ("podcast edit insert-gap",)),
    "InsertSegment": (("segment_insert_tool",), ("podcast segment insert",)),
    "MoveByText": (("move_by_text_tool",), ("podcast edit move",)),
    "SuggestPendingEdit": (("submit_document_command_tool",), ("podcast doc submit",)),
}


@pytest.mark.parametrize("command_type", sorted(AUDITED_TWINS))
def test_an_audited_type_records_the_twins_that_submit_it(command_type: str) -> None:
    mcp, cli = AUDITED_TWINS[command_type]
    spec = COMMANDS[command_type]
    assert spec.gui is NO_GUI_SENDER
    for decision, names in ((spec.mcp, mcp), (spec.cli, cli)):
        assert decision == named(*names)


def test_a_comment_delete_is_sent_by_the_bar_and_keeps_its_agent_twins() -> None:
    spec = COMMANDS["DeleteComment"]
    assert spec.gui is GUI_SENT
    assert spec.mcp == named("delete_comment_tool", GENERIC_MCP)
    assert spec.cli == named("podcast comment delete")


def test_no_audit_placeholder_is_left() -> None:
    assert not hasattr(registry, "UNAUDITED")
    for command_type, spec in COMMANDS.items():
        for decision in (spec.gui, spec.mcp, spec.cli):
            if isinstance(decision, Gap):
                assert "not audited" not in decision.reason, command_type


def test_a_social_clip_delete_has_an_mcp_twin_and_the_cli_reaches_it_generically() -> None:
    spec = COMMANDS["DeleteSocialClip"]
    assert spec.mcp == named("reject_social_clips_tool", GENERIC_MCP)
    assert spec.cli == named("podcast clips list", "podcast doc submit")


KEPT_GAPS = {"EditSelectedRange", "SetTrackMedia"}


def test_generic_reach_closes_every_gap_whose_only_problem_was_no_named_tool() -> None:
    remaining = {
        t
        for t, s in COMMANDS.items()
        if any(isinstance(getattr(s, x), Gap) for x in ("mcp", "cli"))
    }
    assert remaining == KEPT_GAPS


def test_a_type_that_names_the_generic_surface_is_one_the_generic_tool_accepts() -> None:
    for command_type, spec in COMMANDS.items():
        for decision, generic in ((spec.mcp, GENERIC_MCP), (spec.cli, GENERIC_CLI)):
            if isinstance(decision, Named | Gap) and generic in decision.names:
                assert spec.generic_refusal is None, command_type


@pytest.mark.parametrize(
    ("command_type", "mcp", "cli"),
    [
        ("SplitAtTime", ("split_clip_tool",), (GENERIC_CLI,)),
        ("RemoveTrack", ("track_remove_tool", GENERIC_MCP), (GENERIC_CLI,)),
        ("AddTrack", ("track_add_empty_tool", GENERIC_MCP), (GENERIC_CLI,)),
        ("SetTrackMeta", ("track_set_meta_tool", GENERIC_MCP), (GENERIC_CLI,)),
        ("SetClipFade", ("set_clip_fade_tool",), (GENERIC_CLI,)),
        ("SetClipsFade", ("set_clips_fade_tool",), (GENERIC_CLI,)),
        ("SetClipGain", ("set_clip_gain_tool",), (GENERIC_CLI,)),
        ("SetClipsGain", ("set_clips_gain_tool",), (GENERIC_CLI,)),
        ("SetEnvelope", ("set_envelope",), ("podcast edit list-envelope", GENERIC_CLI)),
        ("FillRoomTone", ("fill_with_room_tone_tool",), (GENERIC_CLI,)),
        ("SetTranscriptWordsIgnored", ("set_words_ignored_tool",), (GENERIC_CLI,)),
        ("RenameProject", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("SetRecordSessionName", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("UpdateChapter", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("AddSocialClip", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("UpdateSocialClip", (GENERIC_MCP,), ("podcast clips list", GENERIC_CLI)),
        ("SuggestPendingEdit", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("ApplyFadeRecommendations", (GENERIC_MCP,), (GENERIC_CLI,)),
        ("AddComment", ("add_comment_tool", GENERIC_MCP), ("podcast comment add", GENERIC_CLI)),
        (
            "DeleteChapter",
            ("remove_chapter_tool", GENERIC_MCP),
            ("podcast edit remove-chapter", GENERIC_CLI),
        ),
        (
            "UpdatePendingEdit",
            ("update_pending_edit_tool", GENERIC_MCP),
            (GENERIC_CLI,),
        ),
        (
            "UpdateSocialClipDetails",
            ("approve_social_clips_tool", GENERIC_MCP),
            ("podcast clips approve", "podcast clips list", GENERIC_CLI),
        ),
    ],
)
def test_a_closed_gap_names_the_generic_surface(
    command_type: str, mcp: tuple[str, ...], cli: tuple[str, ...]
) -> None:
    spec = COMMANDS[command_type]
    assert spec.mcp == named(*mcp)
    assert spec.cli == named(*cli)


def test_the_gaps_that_stay_say_what_the_generic_path_cannot_do() -> None:
    mute = COMMANDS["EditSelectedRange"].cli
    assert isinstance(mute, Gap) and mute.partial
    assert GENERIC_CLI in mute.names and "propos" in mute.reason
    media = COMMANDS["SetTrackMedia"].cli
    assert isinstance(media, Gap) and media.partial
    assert media.names == (GENERIC_CLI,) and "raw/" in media.reason


def test_add_track_names_only_the_tool_that_adds_an_empty_track_besides_the_generic_one() -> None:
    assert COMMANDS["AddTrack"].mcp == named("track_add_empty_tool", GENERIC_MCP)


def test_the_edit_surface_view_lists_every_type_so_the_checker_resolves_all_names() -> None:
    view = edit_surface_commands()
    assert set(view) == set(COMMANDS)
    assert view["AddTrack"]["cli"] == ["podcast doc submit"]
    assert view["SetEnvelope"]["cli"] == ["podcast edit list-envelope", "podcast doc submit"]
    assert "gap" not in view["AddTrack"]
    assert view["EditSelectedRange"]["gap"]["partial"] is True
    assert view["EditSelectedRange"]["cli"] == [
        "podcast edit propose-range-cut",
        "podcast doc submit",
    ]
    assert view["DeleteComment"]["mcp"] == ["delete_comment_tool", GENERIC_MCP]


def test_an_unknown_command_type_is_refused_by_dispatch_and_validation(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(CodedValueError) as dispatch:
        apply_command(ws, "NotACommand", {})
    assert dispatch.value.code == "document_command_unknown"
    with pytest.raises(CodedValueError) as validate:
        validate_payload("NotACommand", {})
    assert validate.value.code == "document_command_unknown"
