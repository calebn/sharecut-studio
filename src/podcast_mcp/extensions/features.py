"""Stable and experimental feature / slot IDs for Sharecut Studio Extensions."""

from __future__ import annotations

from typing import Final

# Stable slots (removing/renaming = FOSS major)
FEATURE_SHARE_ROUTES: Final = "share.routes"
FEATURE_SHARE_MCP_TOOLS: Final = "share.mcp_tools"
FEATURE_SHARE_CLI: Final = "share.cli"
FEATURE_SHARE_UI_MENU: Final = "share.ui.menu"
FEATURE_SHARE_UI_BANNER: Final = "share.ui.banner"
FEATURE_SHARE_UI_ROUTES: Final = "share.ui.routes"
FEATURE_TUNNEL_STATUS: Final = "tunnel.status"
FEATURE_ONLINE_ACCOUNT: Final = "online.account"

# Experimental reserved chrome slots
FEATURE_EXTENSION_MORE_0: Final = "extension.more.0"
FEATURE_EXTENSION_STATUS_0: Final = "extension.status.0"

STABLE_FEATURE_IDS: frozenset[str] = frozenset(
    {
        FEATURE_SHARE_ROUTES,
        FEATURE_SHARE_MCP_TOOLS,
        FEATURE_SHARE_CLI,
        FEATURE_SHARE_UI_MENU,
        FEATURE_SHARE_UI_BANNER,
        FEATURE_SHARE_UI_ROUTES,
        FEATURE_TUNNEL_STATUS,
        FEATURE_ONLINE_ACCOUNT,
    }
)

EXPERIMENTAL_FEATURE_IDS: frozenset[str] = frozenset(
    {
        FEATURE_EXTENSION_MORE_0,
        FEATURE_EXTENSION_STATUS_0,
    }
)

# Alias for typing / docs
FeatureId = str
