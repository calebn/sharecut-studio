"""Capability allowlists for guest document commands on review shares."""

from __future__ import annotations

from podcast_mcp.edits.share_capabilities import CAP_EDIT, CAP_SUGGEST, has_capability
from podcast_mcp.services.document_sync.policy import STRUCTURAL_COMMANDS

# Pass 1-2 apply set (guest ``edit``).
EDIT_COMMANDS: frozenset[str] = frozenset(
    {
        "ApproveEdits",
        "RejectEdits",
        "UpdatePendingEdit",
        "RestoreAppliedEdit",
        "SetClipFade",
        "TrimClipEdge",
        "RollClipJoin",
        "SetJoinMode",
        "ApplyFadeRecommendations",
        "SetEffectBypass",
        "UndoHistory",
        "RedoHistory",
        "DuplicateSegment",
        "MoveSegment",
        "MoveClips",
        "PasteSegment",
        "RippleDeleteRange",
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

# Suggest-without-apply (guest ``suggest``) - structural commands propose.
SUGGEST_COMMANDS: frozenset[str] = frozenset(
    {
        "SuggestPendingEdit",
        "UpdatePendingEdit",
        *STRUCTURAL_COMMANDS,
    }
)


def document_command_types_for_caps(caps: list[str] | None) -> frozenset[str]:
    """Document command types allowed for a share's capability set."""
    out: set[str] = set()
    if has_capability(caps, CAP_EDIT):
        out |= set(EDIT_COMMANDS)
    if has_capability(caps, CAP_SUGGEST):
        out |= set(SUGGEST_COMMANDS)
    return frozenset(out)


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
    raise PermissionError(f"share capabilities do not allow document command: {command_type}")
