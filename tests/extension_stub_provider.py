"""Public stand-in for a provider extension, for the extension composition matrix.

The real provider is not in this repository. This stub contributes the same kinds
of surface an account provider does (a feature, a router, middleware, a CLI command
and an MCP tool) so `tests/test_extension_matrix.py` can load it next to
`collaboration` and check that nothing registers twice.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from starlette.middleware.base import BaseHTTPMiddleware

from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.features import FEATURE_ONLINE_ACCOUNT, FEATURE_SHARE_ROUTES
from podcast_mcp.extensions.registry import FeatureRegistry

STUB_NAME = "stub-account"
STUB_OPERATION_ID = "stub_account_status"
STUB_PATH = "/api/stub-account/status"
STUB_CLI_COMMAND = "stub-account"
STUB_MCP_TOOL = "stub_account_status_tool"

router = APIRouter()


@router.get(STUB_PATH, operation_id=STUB_OPERATION_ID)
def stub_account_status() -> dict[str, bool]:
    return {"signed_in": False}


class StubAccountMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Any, call_next: Any) -> Any:
        return await call_next(request)


def stub_account_status_tool() -> dict[str, bool]:
    """Report the stub provider's account state."""
    return {"signed_in": False}


def _stub_account_cmd() -> None:
    """Show the stub provider's account state."""


class StubAccountProvider:
    """Account provider stand-in. With ``claims_share`` it also contributes ``share.routes``."""

    api_version = HOST_API_VERSION
    name = STUB_NAME

    def __init__(self, *, claims_share: bool = False) -> None:
        self.claims_share = claims_share

    def compatible(self, host_api_version: int) -> bool:
        return host_api_version >= self.api_version

    def contribute(self, registry: FeatureRegistry) -> None:
        registry.add_middleware(StubAccountMiddleware, source=self.name)
        registry.add_router(router, source=self.name, feature_id=None)

        def _register_cli(typer_root: Any) -> None:
            typer_root.command(STUB_CLI_COMMAND)(_stub_account_cmd)

        def _register_mcp(mcp: Any) -> None:
            mcp.tool()(stub_account_status_tool)

        registry.add_cli_registrar(_register_cli, source=self.name, feature_id=None)
        registry.add_mcp_registrar(_register_mcp, source=self.name, feature_id=None)
        registry.add(FEATURE_ONLINE_ACCOUNT, source=self.name)
        if self.claims_share:
            registry.add(FEATURE_SHARE_ROUTES, source=self.name)


class StubEntryPoint:
    """Stands in for an installed ``podcast_mcp.extensions`` entry point."""

    name = STUB_NAME

    def __init__(self, *, claims_share: bool = False) -> None:
        self.claims_share = claims_share

    def load(self) -> Any:
        claims_share = self.claims_share
        return lambda: StubAccountProvider(claims_share=claims_share)
