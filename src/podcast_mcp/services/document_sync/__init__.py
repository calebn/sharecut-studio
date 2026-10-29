from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document_sync.capabilities import (
        document_command_types_for_caps,
        edit_commands_allowed,
    )
    from podcast_mcp.services.document_sync.commands import (
        INTERACTIVE_COMMAND,
        PROGRAMMATIC_COMMAND,
        DocumentCommand,
        DocumentCommandType,
        TrustedCommandContext,
        command_context_for_role,
    )
    from podcast_mcp.services.document_sync.errors import DocumentConflictError
    from podcast_mcp.services.document_sync.external_apply import apply_external_document_edit
    from podcast_mcp.services.document_sync.host_submit import (
        host_command_result,
        submit_host_command_result,
        submit_host_document_command,
        submit_paste_segment,
    )
    from podcast_mcp.services.document_sync.payloads import (
        COMMENT_BODY_MAX,
        DEFAULT_SHORTEN_GAP_SEC,
        DEFAULT_STRIP_MIN_DURATION_SEC,
        DEFAULT_STRIP_OVER_VOICE_FLOOR_DB,
        DocumentCommandBody,
        TranscriptReplacementOptions,
        WordTimingTargetPayload,
        document_command_from_body,
        document_command_json_schema,
        parse_document_command,
        validate_payload,
    )
    from podcast_mcp.services.document_sync.projection_delta import list_delta
    from podcast_mcp.services.document_sync.projection_types import (
        VIEW_PROJECTION_QUERY_DESCRIPTION,
        ViewProjection,
        parse_view_projection,
    )
    from podcast_mcp.services.document_sync.service import (
        DocumentSyncService,
        after_agent_mutation,
        document_db_path,
        document_hub_key,
        document_poll_meta,
        document_server_seq_at,
        document_submit_lock,
        dump_projection_locked,
        host_document_event,
        notify_comments_changed,
        notify_document_changed,
    )
    from podcast_mcp.services.document_sync.snapshot_cache import file_certificate

__all__ = [
    "COMMENT_BODY_MAX",
    "DEFAULT_SHORTEN_GAP_SEC",
    "DEFAULT_STRIP_MIN_DURATION_SEC",
    "DEFAULT_STRIP_OVER_VOICE_FLOOR_DB",
    "INTERACTIVE_COMMAND",
    "PROGRAMMATIC_COMMAND",
    "VIEW_PROJECTION_QUERY_DESCRIPTION",
    "DocumentCommand",
    "DocumentCommandBody",
    "DocumentCommandType",
    "DocumentConflictError",
    "DocumentSyncService",
    "TranscriptReplacementOptions",
    "TrustedCommandContext",
    "ViewProjection",
    "WordTimingTargetPayload",
    "after_agent_mutation",
    "apply_external_document_edit",
    "command_context_for_role",
    "document_command_from_body",
    "document_command_json_schema",
    "document_command_types_for_caps",
    "document_db_path",
    "document_hub_key",
    "document_poll_meta",
    "document_server_seq_at",
    "document_submit_lock",
    "dump_projection_locked",
    "edit_commands_allowed",
    "file_certificate",
    "host_command_result",
    "host_document_event",
    "list_delta",
    "notify_comments_changed",
    "notify_document_changed",
    "parse_document_command",
    "parse_view_projection",
    "submit_host_command_result",
    "submit_host_document_command",
    "submit_paste_segment",
    "validate_payload",
]

_MODULE_BY_NAME = {
    "COMMENT_BODY_MAX": "payloads",
    "DEFAULT_SHORTEN_GAP_SEC": "payloads",
    "DEFAULT_STRIP_MIN_DURATION_SEC": "payloads",
    "DEFAULT_STRIP_OVER_VOICE_FLOOR_DB": "payloads",
    "DocumentCommand": "commands",
    "DocumentCommandBody": "payloads",
    "DocumentCommandType": "commands",
    "INTERACTIVE_COMMAND": "commands",
    "command_context_for_role": "commands",
    "PROGRAMMATIC_COMMAND": "commands",
    "TrustedCommandContext": "commands",
    "DocumentConflictError": "errors",
    "DocumentSyncService": "service",
    "TranscriptReplacementOptions": "payloads",
    "VIEW_PROJECTION_QUERY_DESCRIPTION": "projection_types",
    "ViewProjection": "projection_types",
    "WordTimingTargetPayload": "payloads",
    "after_agent_mutation": "service",
    "apply_external_document_edit": "external_apply",
    "document_command_from_body": "payloads",
    "document_command_json_schema": "payloads",
    "document_command_types_for_caps": "capabilities",
    "document_db_path": "service",
    "document_hub_key": "service",
    "document_poll_meta": "service",
    "document_server_seq_at": "service",
    "document_submit_lock": "service",
    "dump_projection_locked": "service",
    "edit_commands_allowed": "capabilities",
    "file_certificate": "snapshot_cache",
    "host_command_result": "host_submit",
    "host_document_event": "service",
    "list_delta": "projection_delta",
    "notify_comments_changed": "service",
    "notify_document_changed": "service",
    "parse_document_command": "payloads",
    "parse_view_projection": "projection_types",
    "submit_host_command_result": "host_submit",
    "submit_host_document_command": "host_submit",
    "submit_paste_segment": "host_submit",
    "validate_payload": "payloads",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
