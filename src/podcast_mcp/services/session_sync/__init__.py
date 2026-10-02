from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.session_sync.authz import (
        AuthzDecision,
        ClientRole,
        authorize_client,
        authorize_host,
        authorize_share_token,
        ensure_non_loopback_session_auth,
        is_bind_loopback,
        is_loopback_host,
    )
    from podcast_mcp.services.session_sync.commands import (
        GUEST_CLIENT_ID_PREFIX,
        SyncCommand,
        TransportRole,
        normalize_presence_playhead,
        retry_command_id,
        sanitize_display_name,
    )
    from podcast_mcp.services.session_sync.hub import get_hub
    from podcast_mcp.services.session_sync.log import (
        ClientSequenceConflictError,
        StoreCachePin,
        SyncStore,
        cached_store,
        cached_sync_store,
        cached_sync_store_if_exists,
        cross_process_command,
        drop_cached_stores_for_tests,
        pin_cached_stores,
    )
    from podcast_mcp.services.session_sync.presence_delta import (
        ROSTER_REQUEST,
        is_own_presence_echo,
    )
    from podcast_mcp.services.session_sync.service import (
        SessionSyncService,
        best_effort_meta,
        meta_workspace_dir,
        read_session_state,
        resolve_meta_path,
        session_dir_for_workspace,
        session_meta,
        session_server_seq_at,
        sync_db_path,
        wire_session_event,
    )
    from podcast_mcp.services.session_sync.snapshot import wire_full_snapshot, wire_snapshot
    from podcast_mcp.services.session_sync.sqlite import connect_session_db
    from podcast_mcp.services.session_sync.viewer import (
        publish_agent_play,
        publish_viewer_snapshot,
    )

__all__ = [
    "GUEST_CLIENT_ID_PREFIX",
    "ROSTER_REQUEST",
    "AuthzDecision",
    "ClientRole",
    "ClientSequenceConflictError",
    "SessionSyncService",
    "StoreCachePin",
    "SyncCommand",
    "SyncStore",
    "TransportRole",
    "authorize_client",
    "authorize_host",
    "authorize_share_token",
    "best_effort_meta",
    "cached_store",
    "cached_sync_store",
    "cached_sync_store_if_exists",
    "connect_session_db",
    "cross_process_command",
    "drop_cached_stores_for_tests",
    "ensure_non_loopback_session_auth",
    "get_hub",
    "is_bind_loopback",
    "is_loopback_host",
    "is_own_presence_echo",
    "meta_workspace_dir",
    "normalize_presence_playhead",
    "pin_cached_stores",
    "publish_agent_play",
    "publish_viewer_snapshot",
    "read_session_state",
    "resolve_meta_path",
    "retry_command_id",
    "sanitize_display_name",
    "session_dir_for_workspace",
    "session_meta",
    "session_server_seq_at",
    "sync_db_path",
    "wire_full_snapshot",
    "wire_session_event",
    "wire_snapshot",
]

_MODULE_BY_NAME = {
    "AuthzDecision": "authz",
    "ClientRole": "authz",
    "ClientSequenceConflictError": "log",
    "GUEST_CLIENT_ID_PREFIX": "commands",
    "ROSTER_REQUEST": "presence_delta",
    "SessionSyncService": "service",
    "StoreCachePin": "log",
    "SyncCommand": "commands",
    "SyncStore": "log",
    "TransportRole": "commands",
    "authorize_client": "authz",
    "authorize_host": "authz",
    "authorize_share_token": "authz",
    "best_effort_meta": "service",
    "cached_store": "log",
    "cached_sync_store": "log",
    "cached_sync_store_if_exists": "log",
    "connect_session_db": "sqlite",
    "cross_process_command": "log",
    "drop_cached_stores_for_tests": "log",
    "pin_cached_stores": "log",
    "ensure_non_loopback_session_auth": "authz",
    "get_hub": "hub",
    "is_bind_loopback": "authz",
    "is_loopback_host": "authz",
    "is_own_presence_echo": "presence_delta",
    "meta_workspace_dir": "service",
    "normalize_presence_playhead": "commands",
    "publish_agent_play": "viewer",
    "publish_viewer_snapshot": "viewer",
    "read_session_state": "service",
    "resolve_meta_path": "service",
    "retry_command_id": "commands",
    "sanitize_display_name": "commands",
    "session_dir_for_workspace": "service",
    "session_meta": "service",
    "session_server_seq_at": "service",
    "sync_db_path": "service",
    "wire_snapshot": "snapshot",
    "wire_full_snapshot": "snapshot",
    "wire_session_event": "service",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
