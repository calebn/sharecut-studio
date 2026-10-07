"""Which guest document commands each review-link role may run.

A share's capabilities resolve to a review role (``REVIEW_ROLE_CAPABILITIES``);
the role decides the command set. Viewers run none, Commenters suggest, and
Editors also apply and decide suggestions. A share that holds no role in full
runs none. ``policy`` asks these predicates whether a guest applies or proposes.
"""

from __future__ import annotations

from collections.abc import Mapping

from podcast_mcp.edits.share_capabilities import ReviewRole, review_role_for_capabilities
from podcast_mcp.util.coded_error import CodedPermissionError

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
        "CutRange",
        "AddTrack",
        "SetTrackMedia",
        "SetTrackMeta",
        "SetTrackFader",
        "SetTrackMute",
        "RemoveTrack",
        "ReorderTrack",
        *STRUCTURAL_COMMANDS,
    }
)

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
