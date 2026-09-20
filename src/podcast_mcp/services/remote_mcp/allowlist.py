"""Capability → guest MCP tool allowlists (parity with Sharecut Studio / document commands)."""

from __future__ import annotations

from podcast_mcp.edits.share_capabilities import (
    CAP_ACTION,
    CAP_COMMENT,
    CAP_EDIT,
    CAP_PLAY,
    CAP_REPLY,
    CAP_SUGGEST,
    CAP_VIEW,
    has_capability,
)

# Read / listen (ReviewApp-level summary without full Sharecut Studio).
PLAY_TOOLS: frozenset[str] = frozenset(
    {
        "guest_get_review_summary",
        "guest_audio_info",
        "guest_list_comments",
    }
)

# Full guest Sharecut Studio reads (requires ``view``).
VIEW_TOOLS: frozenset[str] = frozenset(
    {
        "guest_get_project",
        "guest_list_clips",
        "guest_list_pending_edits",
        "guest_list_applied_edits",
        "guest_search_transcript",
        "guest_render_status",
        "guest_list_comments",
        "guest_audio_info",
        "guest_get_session_presence",
    }
)

# Listen-first pending-preview HTTP twin (requires both ``play`` and ``view``).
PLAY_AND_VIEW_TOOLS: frozenset[str] = frozenset(
    {
        "guest_pending_preview",
        "guest_audition_context",
    }
)

COMMENT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_add_comment",
        "guest_add_reply",
        "guest_list_comments",
    }
)

ACTION_TOOLS: frozenset[str] = frozenset(
    {
        "guest_set_action_done",
    }
)

# Mutations go through the shared document-command allowlists.
SUGGEST_TOOLS: frozenset[str] = frozenset(
    {
        "guest_submit_document_command",
    }
)

EDIT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_submit_document_command",
        "guest_render_preview",
        "guest_upload_media",
    }
)

ALL_GUEST_TOOLS: frozenset[str] = (
    PLAY_TOOLS
    | VIEW_TOOLS
    | PLAY_AND_VIEW_TOOLS
    | COMMENT_TOOLS
    | ACTION_TOOLS
    | SUGGEST_TOOLS
    | EDIT_TOOLS
)


def tools_for_capabilities(caps: list[str] | None) -> frozenset[str]:
    """Return MCP tool names allowed for a share's capability set."""
    out: set[str] = set()
    if has_capability(caps, CAP_PLAY):
        out |= PLAY_TOOLS
    if has_capability(caps, CAP_VIEW):
        out |= VIEW_TOOLS
    if has_capability(caps, CAP_PLAY) and has_capability(caps, CAP_VIEW):
        out |= PLAY_AND_VIEW_TOOLS
    if has_capability(caps, CAP_COMMENT) or has_capability(caps, CAP_REPLY):
        out |= COMMENT_TOOLS
    if has_capability(caps, CAP_ACTION):
        out |= ACTION_TOOLS
    if has_capability(caps, CAP_SUGGEST):
        out |= SUGGEST_TOOLS
    if has_capability(caps, CAP_EDIT):
        out |= EDIT_TOOLS
    return frozenset(out)


def tool_allowed(caps: list[str] | None, tool_name: str) -> bool:
    return tool_name in tools_for_capabilities(caps)
