from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.session_sync.authz import (
        ensure_non_loopback_session_auth,
        is_bind_loopback,
    )
    from podcast_mcp.services.session_sync.service import SessionSyncService

__all__ = ["SessionSyncService", "ensure_non_loopback_session_auth", "is_bind_loopback"]

_MODULE_BY_NAME = {
    "SessionSyncService": "service",
    "ensure_non_loopback_session_auth": "authz",
    "is_bind_loopback": "authz",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
