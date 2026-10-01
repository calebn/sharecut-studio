from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.remote_mcp.allowlist import (
        ACTION_TOOLS,
        ALL_GUEST_TOOLS,
        COMMENT_TOOLS,
        EDIT_TOOLS,
        PLAY_AND_VIEW_TOOLS,
        PLAY_TOOLS,
        SUGGEST_TOOLS,
        VIEW_TOOLS,
        tools_for_capabilities,
    )
    from podcast_mcp.services.remote_mcp.context import (
        RemoteMcpContext,
        resolve_remote_mcp_context,
    )
    from podcast_mcp.services.remote_mcp.executor import run_guest_mcp_call
    from podcast_mcp.services.remote_mcp.limits import (
        check_host_bucket,
        classify_mcp_rpc,
        get_host_limiters,
        host_rate_limit_enabled,
        mcp_rate_limit_error,
        rate_limit_detail,
        ws_roster_request_allowed,
    )
    from podcast_mcp.services.remote_mcp.progress import (
        iter_mcp_sse,
        rpc_progress_token,
    )
    from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
    from podcast_mcp.services.remote_mcp.tools import (
        TOOL_HANDLERS,
        call_tool,
        list_tool_defs,
    )

__all__ = [
    "ACTION_TOOLS",
    "ALL_GUEST_TOOLS",
    "COMMENT_TOOLS",
    "EDIT_TOOLS",
    "PLAY_AND_VIEW_TOOLS",
    "PLAY_TOOLS",
    "SUGGEST_TOOLS",
    "TOOL_HANDLERS",
    "VIEW_TOOLS",
    "RemoteMcpContext",
    "call_tool",
    "check_host_bucket",
    "classify_mcp_rpc",
    "get_host_limiters",
    "handle_mcp_jsonrpc",
    "host_rate_limit_enabled",
    "iter_mcp_sse",
    "list_tool_defs",
    "mcp_rate_limit_error",
    "rate_limit_detail",
    "resolve_remote_mcp_context",
    "rpc_progress_token",
    "run_guest_mcp_call",
    "tools_for_capabilities",
    "ws_roster_request_allowed",
]

_MODULE_BY_NAME = {
    "ACTION_TOOLS": "allowlist",
    "ALL_GUEST_TOOLS": "allowlist",
    "COMMENT_TOOLS": "allowlist",
    "EDIT_TOOLS": "allowlist",
    "PLAY_AND_VIEW_TOOLS": "allowlist",
    "PLAY_TOOLS": "allowlist",
    "RemoteMcpContext": "context",
    "SUGGEST_TOOLS": "allowlist",
    "TOOL_HANDLERS": "tools",
    "VIEW_TOOLS": "allowlist",
    "call_tool": "tools",
    "check_host_bucket": "limits",
    "classify_mcp_rpc": "limits",
    "get_host_limiters": "limits",
    "handle_mcp_jsonrpc": "protocol",
    "host_rate_limit_enabled": "limits",
    "iter_mcp_sse": "progress",
    "list_tool_defs": "tools",
    "mcp_rate_limit_error": "limits",
    "rate_limit_detail": "limits",
    "resolve_remote_mcp_context": "context",
    "rpc_progress_token": "progress",
    "run_guest_mcp_call": "executor",
    "tools_for_capabilities": "allowlist",
    "ws_roster_request_allowed": "limits",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
