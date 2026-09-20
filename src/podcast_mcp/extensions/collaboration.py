"""FOSS self-hosted collaboration extension."""

from __future__ import annotations

import logging

from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.features import (
    FEATURE_SHARE_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_TUNNEL_STATUS,
)
from podcast_mcp.extensions.registry import FeatureRegistry

logger = logging.getLogger(__name__)


class CollaborationExtension:
    """Compose self-hosted share, guest, record, and remote-MCP adapters."""

    api_version = HOST_API_VERSION
    name = "collaboration"

    def compatible(self, host_api_version: int) -> bool:
        return host_api_version >= 1 and self.api_version <= host_api_version

    def contribute(self, registry: FeatureRegistry) -> None:
        # CLI/MCP first: share mint must work without the optional ``gui`` extra.
        def _register_cli(typer_root: object) -> None:
            from podcast_mcp.cli import review as review_cli

            review_cli.register_share_cli_on_host(typer_root)

        registry.add_cli_registrar(_register_cli, source=self.name)

        def _register_mcp(mcp: object) -> None:
            from podcast_mcp.mcp.tools import review as review_tools

            review_tools.register_share(mcp)  # type: ignore[arg-type]

        registry.add_mcp_registrar(_register_mcp, source=self.name)

        try:
            self._contribute_gui(registry)
        except ImportError:
            logger.info(
                "collaboration: skipping GUI share mounts (gui extra / FastAPI unavailable)",
                exc_info=True,
            )

    def _contribute_gui(self, registry: FeatureRegistry) -> None:
        from podcast_mcp.gui.middleware_share_identity import ShareIdentityMiddleware
        from podcast_mcp.gui.routes import record_share, remote_mcp, review_share, shares

        registry.add_middleware(ShareIdentityMiddleware, source=self.name)
        for router in (
            review_share.router,
            record_share.router,
            remote_mcp.router,
            shares.router,
        ):
            registry.add_router(router, source=self.name, feature_id=None)
        registry.add(FEATURE_SHARE_ROUTES, source=self.name)
        registry.add(FEATURE_SHARE_UI_MENU, source=self.name)
        registry.add(FEATURE_SHARE_UI_BANNER, source=self.name)
        registry.add(FEATURE_TUNNEL_STATUS, source=self.name)

        def _review_spa(**kwargs: object) -> object:
            from podcast_mcp.services.share_page import (
                render_record_spa_html,
                render_share_spa_html,
                share_public_origin,
            )

            request = kwargs["request"]
            token = str(kwargs["token"])
            index_html = str(kwargs["index_html"])
            kind = str(kwargs.get("kind") or "review")
            origin = share_public_origin(str(request.base_url))  # type: ignore[attr-defined]
            if kind == "record":
                return render_record_spa_html(
                    token,
                    index_html=index_html,
                    public_origin=origin,
                )
            return render_share_spa_html(
                token,
                index_html=index_html,
                public_origin=origin,
            )

        registry.add_spa_hook(_review_spa, source=self.name)


def create() -> CollaborationExtension:
    return CollaborationExtension()
