from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document_sync.capabilities import (
        document_command_types_for_caps,
        edit_commands_allowed,
    )
    from podcast_mcp.services.document_sync.commands import (
        DocumentCommand,
        DocumentCommandType,
    )
    from podcast_mcp.services.document_sync.errors import DocumentConflictError
    from podcast_mcp.services.document_sync.host_submit import (
        host_command_result,
        submit_host_document_command,
        submit_paste_segment,
    )
    from podcast_mcp.services.document_sync.payloads import (
        COMMENT_BODY_MAX,
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
    "VIEW_PROJECTION_QUERY_DESCRIPTION",
    "DocumentCommand",
    "DocumentCommandBody",
    "DocumentCommandType",
    "DocumentConflictError",
    "DocumentSyncService",
    "TranscriptReplacementOptions",
    "ViewProjection",
    "WordTimingTargetPayload",
    "after_agent_mutation",
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
    "submit_host_document_command",
    "submit_paste_segment",
    "validate_payload",
]

_MODULE_BY_NAME = {
    "COMMENT_BODY_MAX": "payloads",
    "DocumentCommand": "commands",
    "DocumentCommandBody": "payloads",
    "DocumentCommandType": "commands",
    "DocumentConflictError": "errors",
    "DocumentSyncService": "service",
    "TranscriptReplacementOptions": "payloads",
    "VIEW_PROJECTION_QUERY_DESCRIPTION": "projection_types",
    "ViewProjection": "projection_types",
    "WordTimingTargetPayload": "payloads",
    "after_agent_mutation": "service",
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
    "submit_host_document_command": "host_submit",
    "submit_paste_segment": "host_submit",
    "validate_payload": "payloads",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
