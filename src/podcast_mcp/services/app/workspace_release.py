"""Let go of everything this process holds open on one workspace's folder."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.engines.room_tone import forget_workspace_pools
from podcast_mcp.services.document import cross_process_bridge
from podcast_mcp.services.record import forget_workspace_runtime
from podcast_mcp.services.session_sync import drop_cached_stores_under, get_hub


def release_workspace(workspace: Path) -> None:
    """Close the handles, subscriptions and path-keyed caches of ``workspace`` (resolved).

    Run right after the folder is renamed, so a refusal before the rename leaves the open episode untouched:
    a cache keyed by the old path would otherwise outlive the move. Order matters: the watcher and the
    subscribers pin the stores, so they go first. Whatever is opened again later opens at the
    folder's new path.
    """
    key = str(workspace)
    cross_process_bridge().stop_workspace(key)
    get_hub().unsubscribe_workspace(key)
    forget_workspace_runtime(key)
    drop_cached_stores_under(workspace)
    forget_workspace_pools(workspace)
