"""Which guest document commands each review-link role may run.

A share's capabilities resolve to a review role (``REVIEW_ROLE_CAPABILITIES``);
the role decides the command set. Viewers run none, Commenters suggest, and
Editors also apply and decide suggestions. A share that holds no role in full
runs none. ``policy`` asks these predicates whether a guest applies or proposes.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from podcast_mcp.engines.effect_filters import validate_effect_params
from podcast_mcp.services.collaboration import ReviewRole, review_role_for_capabilities
from podcast_mcp.util.coded_error import CodedPermissionError, CodedValueError

# Structural ops share one command type; policy chooses apply vs propose.
STRUCTURAL_COMMANDS: frozenset[str] = frozenset(
    {
        "SplitAtTime",
        "DeleteClip",
    }
)

# Editor apply set (Pass 1-2 and structural edits).
EDIT_COMMANDS: frozenset[str] = frozenset(
    {
        "EditSelectedRange",
        "ApproveEdits",
        "RejectEdits",
        "ApplySuggestedActions",
        "UpdatePendingEdit",
        "RestoreAppliedEdit",
        "SetClipFade",
        "TrimClipEdge",
        "RollClipJoin",
        "SetJoinMode",
        "SetClipJoin",
        "ApplyFadeRecommendations",
        "SetEffectBypass",
        "UndoHistory",
        "RedoHistory",
        "DuplicateSegment",
        "MoveSegment",
        "MoveClips",
        "PasteSegment",
        "FillRoomTone",
        "CutRange",
        "AddTrack",
        "SetTrackMedia",
        "SetTrackMeta",
        "SetTrackFader",
        "SetTrackMute",
        "RemoveTrack",
        "ReorderTrack",
        # Editors change volume envelopes as the host does (owner, #1051).
        "SetEnvelope",
        # Editors write the episode's podcast listing; show settings stay with the host.
        "SetFeedField",
        "ClearFeedField",
        "CorrectTranscriptWord",
        "CorrectTranscriptPhrase",
        "ReplaceTranscriptMatches",
        "ApplyTranscriptCleanup",
        "VerifyTranscript",
        "ReconcileTranscript",
        "SetTranscriptWordSuppressed",
        "SetTranscriptWordAutomatic",
        "SetTranscriptWordsIgnored",
        "SetTranscriptWordTiming",
        "AddChapter",
        "UpdateChapter",
        "DeleteChapter",
        "AddSocialClip",
        "UpdateSocialClip",
        "DeleteSocialClip",
        "AddEffect",
        "RemoveEffect",
        "SuppressBleed",
        "SuppressLowAudibility",
        "SetBleedAlignmentMode",
        "RestoreClipBleed",
        "StageTimeRangeCut",
        "StageTextMatchCut",
        "StageUtteranceCut",
        "StageWordsCut",
        "MoveByText",
        "RippleDeleteText",
        "InsertGap",
        "ApplyAutoEdits",
        "ProposeTighten",
        "ApplyEditPlan",
        "ShortenWordGaps",
        "StripSilence",
        "FadeJoins",
        "CrossfadeJoins",
        "ApplyFadeRecommendationList",
        "RenameProject",
        *STRUCTURAL_COMMANDS,
    }
)

COMMENT_COMMANDS: frozenset[str] = frozenset(
    {
        "AddComment",
        "UpdateComment",
        "ResolveComment",
        "DeleteComment",
        "AddReply",
        "SetActionDone",
        "AddAction",
    }
)

HOST_ONLY_DOCUMENT_COMMANDS: frozenset[str] = frozenset()

# Commenter suggest set: structural commands and selected ranges propose.
SUGGEST_COMMANDS: frozenset[str] = frozenset(
    {
        "EditSelectedRange",
        "SuggestPendingEdit",
        "UpdatePendingEdit",
        *STRUCTURAL_COMMANDS,
    }
)

ROLE_DOCUMENT_COMMANDS: Mapping[ReviewRole, frozenset[str]] = {
    ReviewRole.VIEWER: frozenset(),
    ReviewRole.COMMENTER: SUGGEST_COMMANDS,
    ReviewRole.EDITOR: EDIT_COMMANDS | SUGGEST_COMMANDS,
}


def document_command_types_for_caps(caps: list[str] | None) -> frozenset[str]:
    """Document command types allowed for a share's capability set.

    The same set applies on the browser and the guest MCP surface.
    """
    role = review_role_for_capabilities(caps)
    return ROLE_DOCUMENT_COMMANDS[role] if role is not None else frozenset()


def edit_commands_allowed(caps: list[str] | None) -> bool:
    """Whether the share is an Editor: it applies edits and decides suggestions.

    Edit-only side surfaces (render preview, media upload) follow this, so they
    match the commands the guest can run.
    """
    return document_command_types_for_caps(caps) >= EDIT_COMMANDS


def suggestions_allowed(caps: list[str] | None) -> bool:
    """Whether the share may propose edits (Commenter or Editor)."""
    return "SuggestPendingEdit" in document_command_types_for_caps(caps)


def authorize_document_command(
    caps: list[str] | None,
    command_type: str,
) -> None:
    """Raise PermissionError if *caps* do not allow *command_type*.

    ``caps is None`` means host / unrestricted (always allowed).
    """
    if caps is None:
        return
    if command_type in document_command_types_for_caps(caps):
        return
    raise CodedPermissionError(
        f"share capabilities do not allow document command: {command_type}",
        code="share_capability_required",
    )


def stamp_guest_payload(command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The payload a share's command runs with: a listing value it sets is marked as the guest's."""
    if command_type == "SetFeedField":
        return {**payload, "by": "guest"}
    return payload


def authorize_document_payload(
    caps: list[str] | None,
    command_type: str,
    payload: dict[str, Any],
) -> None:
    """Raise PermissionError if *caps* may run *command_type* but not this payload shape.

    A room tone fill without a range (no ``start_sec``/``end_sec``) is host-only; a guest
    Editor fills an explicit range. A guest edits only this episode's listing values
    (an episode row a person may pin), never the show's (``channel.*``). An effect ``model`` param names a host file
    and is host-only. Effect params are checked against the effect's schema. ``caps is None``
    means host / unrestricted (always allowed).
    """
    if caps is None:
        return
    if command_type in {"SetFeedField", "ClearFeedField"}:
        from podcast_mcp.feed.fields import guest_pinnable, lookup

        key = payload.get("key")
        if isinstance(key, str) and lookup(key) is None:
            raise CodedValueError(f"{key} is not a listing field", code="feed_field_unknown")
        if not isinstance(key, str) or not guest_pinnable(key, "episode"):
            raise CodedPermissionError(
                "guests edit this episode's listing values, not the show's",
                code="share_capability_required",
            )
        if payload.get("by", "person") not in {"person", "guest"}:
            raise CodedPermissionError(
                "a share link edits as a person; only an agent session can set a value as an agent",
                code="share_capability_required",
            )
        return
    if command_type == "FillRoomTone" and (
        payload.get("start_sec") is None or payload.get("end_sec") is None
    ):
        raise CodedPermissionError(
            "a room tone fill without a range is host-only; guests fill a selected range",
            code="share_capability_required",
        )
    if command_type == "AddEffect" and not isinstance(payload.get("params") or {}, Mapping):
        raise CodedValueError("effect params must be an object", code="invalid_effect_params")
    if command_type == "AddEffect" and "model" in (payload.get("params") or {}):
        raise CodedPermissionError(
            "an effect model file is host-only; guests add the effect with its defaults",
            code="share_capability_required",
        )
    if command_type == "AddEffect" and payload.get("effect"):
        validate_effect_params(str(payload["effect"]), payload.get("params"))
