"""Token-scoped context for capability-filtered remote MCP."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from podcast_mcp.services.share import open_share_workspace, share_allows_mcp
from podcast_mcp.services.workspace import ProjectWorkspace

_current: ContextVar[RemoteMcpContext | None] = ContextVar("remote_mcp_context", default=None)


@dataclass(frozen=True)
class RemoteMcpContext:
    """Bound share identity for a remote MCP session (project path is internal-only)."""

    token: str
    capabilities: list[str]
    workspace: ProjectWorkspace

    @property
    def project_path(self) -> str:
        """Host filesystem path - never expose to MCP clients."""
        return str(self.workspace.path)


def resolve_remote_mcp_context(token: str) -> RemoteMcpContext:
    """Resolve share → workspace; require ``mcp`` capability."""
    if not share_allows_mcp(token):
        raise PermissionError("share does not allow mcp")
    row, ws = open_share_workspace(token)
    caps = list(row.get("capabilities") or [])
    return RemoteMcpContext(token=token, capabilities=caps, workspace=ws)


def set_remote_mcp_context(ctx: RemoteMcpContext | None) -> None:
    _current.set(ctx)


def get_remote_mcp_context() -> RemoteMcpContext:
    ctx = _current.get()
    if ctx is None:
        raise RuntimeError("remote MCP context not set")
    return ctx


def clear_remote_mcp_context() -> None:
    _current.set(None)
