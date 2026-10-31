"""Capability → guest MCP tool allowlists (parity with ShareCut Studio / document commands)."""

from __future__ import annotations

from podcast_mcp.services.collaboration import (
    CAP_ACTION,
    CAP_COMMENT,
    CAP_PLAY,
    CAP_REPLY,
    CAP_VIEW,
    has_capability,
)
from podcast_mcp.services.document_sync import (
    document_command_types_for_caps,
    edit_commands_allowed,
)

# Read / listen (project summary without full ShareCut Studio).
PLAY_TOOLS: frozenset[str] = frozenset(
    {
        "guest_get_review_summary",
        "guest_audio_info",
        "guest_list_comments",
    }
)

# Full guest ShareCut Studio reads (requires ``view``).
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

# Offered whenever the document-command gate allows any command for the share.
DOCUMENT_COMMAND_TOOLS: frozenset[str] = frozenset(
    {
        "guest_submit_document_command",
    }
)

# Offered when the gate allows every ``edit`` command (``view`` + ``edit``).
EDIT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_render_preview",
        "guest_upload_media",
        "guest_render_preview_job",
    }
)

# Project work an Editor can start and follow over MCP: the twins of the ``/daw/pipeline``,
# ``/daw/export`` and ``/daw/speaker`` routes. Same gate as ``EDIT_TOOLS``. The ``/events``
# streams stay HTTP-only; the ``*_job`` tools poll.
PIPELINE_TOOLS: frozenset[str] = frozenset(
    {
        "guest_pipeline_run",
        "guest_pipeline_status",
        "guest_pipeline_job",
        "guest_pipeline_job_cancel",
    }
)
EXPORT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_export_start",
        "guest_export_status",
        "guest_export_job",
        "guest_export_job_cancel",
    }
)
SPEAKER_TOOLS: frozenset[str] = frozenset(
    {
        "guest_speaker_split",
        "guest_speaker_status",
        "guest_speaker_job",
        "guest_speaker_job_cancel",
        "guest_speaker_move_lane_span",
    }
)
# The twins of the ``/daw/transcript`` routes: vocabulary, the transcript check, replacement and
# word-timing reads, and the transcript export.
TRANSCRIPT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_transcript_vocabulary_get",
        "guest_transcript_vocabulary_put",
        "guest_transcript_refine_status",
        "guest_transcript_refine_done",
        "guest_transcript_refine_waive",
        "guest_transcript_replacement_preview",
        "guest_transcript_word_timing_context",
        "guest_transcript_export",
        "guest_transcript_exports",
    }
)
EDITOR_PROJECT_TOOLS: frozenset[str] = (
    PIPELINE_TOOLS | EXPORT_TOOLS | SPEAKER_TOOLS | TRANSCRIPT_TOOLS
)
# What the host reads of the edit state: the twins of the ``/daw/edit-impact`` and
# ``/daw/social-clips`` routes. Read only.
EDITOR_INSIGHT_TOOLS: frozenset[str] = frozenset(
    {
        "guest_edit_impact",
        "guest_social_clips",
    }
)

ALL_GUEST_TOOLS: frozenset[str] = (
    PLAY_TOOLS
    | VIEW_TOOLS
    | PLAY_AND_VIEW_TOOLS
    | COMMENT_TOOLS
    | ACTION_TOOLS
    | DOCUMENT_COMMAND_TOOLS
    | EDIT_TOOLS
    | EDITOR_PROJECT_TOOLS
    | EDITOR_INSIGHT_TOOLS
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
    if document_command_types_for_caps(caps):
        out |= DOCUMENT_COMMAND_TOOLS
    if edit_commands_allowed(caps):
        out |= EDIT_TOOLS | EDITOR_PROJECT_TOOLS | EDITOR_INSIGHT_TOOLS
    return frozenset(out)


def tool_allowed(caps: list[str] | None, tool_name: str) -> bool:
    return tool_name in tools_for_capabilities(caps)
