"""Capability allowlists for guest document commands on review shares."""

from __future__ import annotations

from podcast_mcp.edits.share_capabilities import (
    CAP_EDIT,
    CAP_SUGGEST,
    CAP_VIEW,
    has_capability,
)
from podcast_mcp.services.document_sync.policy import STRUCTURAL_COMMANDS

# Pass 1-2 apply set (guest ``edit``).
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
        "EditSelectedRange",
        "SuggestPendingEdit",
        "UpdatePendingEdit",
        *STRUCTURAL_COMMANDS,
    }
)


def document_command_types_for_caps(caps: list[str] | None) -> frozenset[str]:
    """Document command types allowed for a share's capability set.

    Every document command needs ``view`` (the guest sees the timeline it edits),
    on the browser and the guest MCP surface alike.
    """
    out: set[str] = set()
    if not has_capability(caps, CAP_VIEW):
        return frozenset()
    if has_capability(caps, CAP_EDIT):
        out |= set(EDIT_COMMANDS)
    if has_capability(caps, CAP_SUGGEST):
        out |= set(SUGGEST_COMMANDS)
    return frozenset(out)


def edit_commands_allowed(caps: list[str] | None) -> bool:
    """Whether the gate allows every ``edit`` command (``view`` + ``edit``).

    Edit-only side surfaces (render preview, media upload) follow this, so they
    match the commands the guest can run.
    """
    return document_command_types_for_caps(caps) >= EDIT_COMMANDS


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
