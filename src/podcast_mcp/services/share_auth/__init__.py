"""Share identity: users, ACL, sessions, magic links, passkeys, agent credentials.

Used when a share is Restricted (or ``require_sign_in``). Link Commenter shares
stay anonymous. Web guest and share MCP share one capability set; Restricted MCP
requires a user-bound agent credential (not the coolname alone).
"""

from __future__ import annotations

from podcast_mcp.services.share_auth.access import (
    GENERAL_ACCESS_LINK,
    GENERAL_ACCESS_RESTRICTED,
    access_required,
    normalize_general_access,
)
from podcast_mcp.services.share_auth.store import ShareIdentityStore, get_identity_store

__all__ = [
    "GENERAL_ACCESS_LINK",
    "GENERAL_ACCESS_RESTRICTED",
    "ShareIdentityStore",
    "access_required",
    "get_identity_store",
    "normalize_general_access",
]
