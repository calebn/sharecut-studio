"""MCP helper: notify document plane after agent project mutations."""

from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.services.document_sync import after_agent_mutation
from podcast_mcp.services.workspace import ProjectWorkspace

F = TypeVar("F", bound=Callable[..., Any])


def agent_mutated(project: str | Path | ProjectWorkspace) -> None:
    """Fan out a SHELL ProjectView to host Sharecut Studio tabs after MCP/CLI mutate."""
    after_agent_mutation(project)


def notify_after_mutation(fn: F) -> F:
    """Decorator for MCP tools whose first arg is ``project_path``."""

    @wraps(fn)
    def wrapper(project_path: str, *args: Any, **kwargs: Any):
        result = fn(project_path, *args, **kwargs)
        agent_mutated(project_path)
        return result

    return wrapper  # type: ignore[return-value]
