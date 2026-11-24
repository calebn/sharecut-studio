"""Extension composition with a synthetic provider backend (#4385, part of #962).

The real provider cannot load in the public tree, so a stub extension stands in for it. It
contributes an account feature, an account router, a middleware class, a CLI command and an MCP
tool. The uniqueness assertions mirror ``tests/test_extension_matrix.py``. This does not replace
the private overlay check.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

import pytest
import typer
from fastapi import APIRouter
from starlette.middleware.base import BaseHTTPMiddleware

from podcast_mcp.extensions import loader
from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.features import (
    FEATURE_ONLINE_ACCOUNT,
    FEATURE_SHARE_CLI,
    FEATURE_SHARE_MCP_TOOLS,
    FEATURE_SHARE_REMOTE_MCP,
    FEATURE_SHARE_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_SHARE_UI_ROUTES,
    FEATURE_TUNNEL_STATUS,
)
from podcast_mcp.extensions.registry import FeatureRegistry

STUB_NAME = "stub_provider"
STUB_OPERATION_ID = "stub_account_me"
STUB_COMMAND = "stub-account"
STUB_TOOL = "stub_account_tool"

COLLABORATION_FEATURES = {
    FEATURE_SHARE_CLI,
    FEATURE_SHARE_MCP_TOOLS,
    FEATURE_SHARE_REMOTE_MCP,
    FEATURE_SHARE_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_SHARE_UI_ROUTES,
    FEATURE_TUNNEL_STATUS,
}
# add_cli_registrar / add_mcp_registrar record these ids for any source, so the stub carries them.
STUB_FEATURES = {FEATURE_ONLINE_ACCOUNT, FEATURE_SHARE_CLI, FEATURE_SHARE_MCP_TOOLS}


class StubAccountMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Any, call_next: Callable[..., Any]) -> Any:
        return await call_next(request)


class StubProvider:
    """Synthetic account provider: one feature, router, middleware, CLI command and MCP tool."""

    api_version = HOST_API_VERSION
    name = STUB_NAME
    extra_share_feature: str | None = None
    operation_id = STUB_OPERATION_ID

    def compatible(self, host_api_version: int) -> bool:
        return host_api_version >= 1 and self.api_version <= host_api_version

    def contribute(self, registry: FeatureRegistry) -> None:
        router = APIRouter()
        router.add_api_route(
            "/api/stub-account/me",
            lambda: {"account": "stub"},
            methods=["GET"],
            operation_id=self.operation_id,
        )
        registry.add_router(router, source=self.name, feature_id=FEATURE_ONLINE_ACCOUNT)
        registry.add_middleware(StubAccountMiddleware, source=self.name)

        def _cli(typer_root: Any) -> None:
            typer_root.command(STUB_COMMAND)(lambda: None)

        def _mcp(mcp: Any) -> None:
            mcp.add_tool(lambda: "stub", name=STUB_TOOL)

        registry.add_cli_registrar(_cli, source=self.name)
        registry.add_mcp_registrar(_mcp, source=self.name)
        if self.extra_share_feature is not None:
            registry.add(self.extra_share_feature, source=self.name)


class _StubEntryPoint:
    def __init__(self, provider: type[StubProvider]) -> None:
        self.name = STUB_NAME
        self._provider = provider

    def load(self) -> type[StubProvider]:
        return self._provider


def _install(
    monkeypatch: pytest.MonkeyPatch, extensions: str, provider: type[StubProvider]
) -> None:
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [_StubEntryPoint(provider)])
    monkeypatch.setenv("PODCAST_EXTENSIONS", extensions)


COMPOSITIONS = {
    "collaboration+stub": f"collaboration,{STUB_NAME}",
    "stub-alone": STUB_NAME,
}


@pytest.fixture(params=sorted(COMPOSITIONS))
def composition(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    _install(monkeypatch, COMPOSITIONS[request.param], StubProvider)
    return str(request.param)


def _expected_features(composition: str) -> set[str]:
    if composition == "stub-alone":
        return STUB_FEATURES
    return COLLABORATION_FEATURES | STUB_FEATURES


def test_each_feature_id_is_contributed_once_per_source(composition: str) -> None:
    registry = loader.load_extensions()
    ids = registry.feature_ids()
    assert set(ids) == _expected_features(composition)
    assert len(ids) == len(set(ids))
    for feature_id in ids:
        sources = [c.source for c in registry.get(feature_id)]
        assert len(sources) == len(set(sources)), feature_id
    assert [c.source for c in registry.get(FEATURE_ONLINE_ACCOUNT)] == [STUB_NAME]


def test_share_features_other_than_the_cli_and_mcp_slots_come_from_collaboration_only(
    composition: str,
) -> None:
    registry = loader.load_extensions()
    for feature_id in COLLABORATION_FEATURES - {FEATURE_SHARE_CLI, FEATURE_SHARE_MCP_TOOLS}:
        sources = [c.source for c in registry.get(feature_id)]
        assert sources == ([] if composition == "stub-alone" else ["collaboration"]), feature_id


def test_cli_and_mcp_registrars_record_their_share_slot_once_per_source(composition: str) -> None:
    """Pins today's behavior: a provider's CLI command or MCP tool also fills share.cli / share.mcp_tools."""
    registry = loader.load_extensions()
    # Entry points load before the built-in collaboration fallback, so the stub comes first.
    expected = [STUB_NAME] if composition == "stub-alone" else [STUB_NAME, "collaboration"]
    for feature_id in (FEATURE_SHARE_CLI, FEATURE_SHARE_MCP_TOOLS):
        assert [c.source for c in registry.get(feature_id)] == expected


def test_gui_registers_each_route_operation_and_middleware_once(composition: str) -> None:
    from podcast_mcp.gui.server import create_app

    app = create_app()
    paths = app.openapi()["paths"]
    operation_ids = [
        op["operationId"]
        for item in paths.values()
        for op in item.values()
        if isinstance(op, dict) and "operationId" in op
    ]
    assert sorted({o for o in operation_ids if operation_ids.count(o) > 1}) == []
    assert operation_ids.count(STUB_OPERATION_ID) == 1
    middleware = [m.cls for m in app.user_middleware]
    assert len(middleware) == len(set(middleware))
    assert StubAccountMiddleware in middleware
    assert any(p.startswith("/api/review/") for p in paths) is (composition != "stub-alone")


def test_mcp_registers_each_tool_once(composition: str, caplog: pytest.LogCaptureFixture) -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import register_all

    mcp = MCPServer("composition")
    with caplog.at_level(logging.WARNING):
        register_all(mcp)
    assert [r.getMessage() for r in caplog.records if "already exists" in r.getMessage()] == []
    names = [t.name for t in mcp._tool_manager.list_tools()]
    assert len(names) == len(set(names))
    assert names.count(STUB_TOOL) == 1
    assert ("create_review_share_tool" in names) is (composition != "stub-alone")


def test_cli_registers_each_command_once(composition: str) -> None:
    app = typer.Typer()
    # Fresh groups: the real review_app is module state that registrars would mutate.
    app.add_typer(typer.Typer(), name="review")
    loader.apply_cli_extensions(app)

    def walk(node: typer.Typer, path: str = "") -> list[str]:
        names = [c.name or getattr(c.callback, "__name__", "") for c in node.registered_commands]
        groups = {g.name: g.typer_instance for g in node.registered_groups}
        names += [str(n) for n in groups]
        found = [f"{path}/{n}" for n in names]
        for name, child in groups.items():
            if child is not None:
                found += walk(child, f"{path}/{name}")
        return found

    paths = walk(app)
    assert len(paths) == len(set(paths)), paths
    assert paths.count(f"/{STUB_COMMAND}") == 1


# --- the stub also contributes a share.* feature --------------------------------------------


class StubClaimingShareRoutes(StubProvider):
    extra_share_feature = FEATURE_SHARE_ROUTES


def test_loader_accepts_a_second_source_for_share_routes_without_warning_or_dedup(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Pins today's lenient behavior: the loader neither rejects nor warns on a duplicate feature id.

    Both contributions are kept, in load order (entry points first, then the built-in fallback); feature_ids() lists the id once.
    """
    _install(monkeypatch, f"collaboration,{STUB_NAME}", StubClaimingShareRoutes)
    with caplog.at_level(logging.WARNING):
        registry = loader.load_extensions()
    assert [r.getMessage() for r in caplog.records] == []
    assert [c.source for c in registry.get(FEATURE_SHARE_ROUTES)] == [STUB_NAME, "collaboration"]
    assert registry.feature_ids().count(FEATURE_SHARE_ROUTES) == 1
    assert set(registry.feature_ids()) == COLLABORATION_FEATURES | STUB_FEATURES


def test_duplicate_share_routes_claim_does_not_duplicate_routes_or_middleware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The claim is only a registry entry; mounted routes and middleware stay unique."""
    from podcast_mcp.gui.server import create_app

    _install(monkeypatch, f"collaboration,{STUB_NAME}", StubClaimingShareRoutes)
    app = create_app()
    operation_ids = [
        op["operationId"]
        for item in app.openapi()["paths"].values()
        for op in item.values()
        if isinstance(op, dict) and "operationId" in op
    ]
    assert len(operation_ids) == len(set(operation_ids))
    middleware = [m.cls for m in app.user_middleware]
    assert len(middleware) == len(set(middleware))


def test_loader_skips_a_second_extension_with_the_same_name_first_wins(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Pins the one dedup the loader has: by extension name, with a warning, first wins."""

    class SecondProvider(StubProvider):
        operation_id = "second_account_me"

    monkeypatch.setattr(
        loader,
        "_iter_entry_points",
        lambda: [_StubEntryPoint(StubProvider), _StubEntryPoint(SecondProvider)],
    )
    monkeypatch.setenv("PODCAST_EXTENSIONS", STUB_NAME)
    with caplog.at_level(logging.WARNING):
        registry = loader.load_extensions()
    assert [r.getMessage() for r in caplog.records if "duplicate extension" in r.getMessage()] == [
        f"skip duplicate extension {STUB_NAME} from {STUB_NAME}; first registration wins"
    ]
    assert len(registry.routers) == 1
    assert [c.source for c in registry.get(FEATURE_ONLINE_ACCOUNT)] == [STUB_NAME]
