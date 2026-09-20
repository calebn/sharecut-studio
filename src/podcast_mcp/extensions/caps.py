"""Frozen capability names for extensions (FOSS contract artifact)."""

from __future__ import annotations

# Re-export stable cap strings shared by FOSS collaboration and provider policy.
from podcast_mcp.edits.share_capabilities import (  # noqa: F401
    ALL_CAPABILITIES,
    CAP_ACTION,
    CAP_COMMENT,
    CAP_EDIT,
    CAP_MCP,
    CAP_PLAY,
    CAP_REPLY,
    CAP_SUGGEST,
    CAP_VIEW,
    DEFAULT_CAPABILITIES,
)

HOST_OWNER_CAPABILITIES: list[str] = list(ALL_CAPABILITIES)
