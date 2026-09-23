"""Share HTTP ↔ guest MCP twins stay paired; host manifest stays host-only."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import APIRouter, WebSocket

from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS
from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "export_docs_site_contract.py"


def _load_contract() -> ModuleType:
    return load_script("export_docs_site_contract")


def test_no_guest_resolve_tool() -> None:
    assert "guest_resolve" not in ALL_GUEST_TOOLS
    assert not any("resolve" in name for name in ALL_GUEST_TOOLS)


def test_guest_tools_have_handlers() -> None:
    missing = sorted(ALL_GUEST_TOOLS - set(TOOL_HANDLERS))
    extra = sorted(set(TOOL_HANDLERS) - ALL_GUEST_TOOLS)
    assert missing == []
    assert extra == []
    assert "guest_audition_context" in ALL_GUEST_TOOLS
    assert "guest_upload_media" in ALL_GUEST_TOOLS


def test_host_capabilities_manifest_has_no_guest_mcp_names() -> None:
    data = json.loads((ROOT / "contracts" / "capabilities.manifest.json").read_text())
    leaked: list[str] = []
    for cap in data.get("capabilities") or []:
        mcp = cap.get("surfaces", {}).get("mcp") or []
        if isinstance(mcp, str):
            mcp = [mcp]
        for name in mcp:
            if str(name).startswith("guest_"):
                leaked.append(f"{cap.get('id')}:{name}")
    assert leaked == []


def test_share_http_mcp_parity_check_passes() -> None:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_iter_websocket_paths_walks_included_routers() -> None:
    mod = _load_contract()
    inner = APIRouter()

    @inner.websocket("/api/rec/{token}/ws")
    async def rec_ws(websocket: WebSocket, token: str) -> None:
        await websocket.close()

    wrapper = SimpleNamespace(original_router=inner)
    assert "/api/rec/{token}/ws" in mod._iter_websocket_paths([wrapper])


def test_iter_app_routes_discovers_share_websockets() -> None:
    mod = _load_contract()
    routes = set(mod._iter_app_routes())
    assert ("WEBSOCKET", "/api/rec/{token}/ws") in routes
    assert ("WEBSOCKET", "/api/review/{token}/daw/ws") in routes
    assert ("WEBSOCKET", "/api/review/{token}/progress/ws") in routes
    assert not any(path in {"/api/session/ws", "/api/document/ws"} for _method, path in routes)


@pytest.mark.parametrize(
    "extra",
    [
        ("WEBSOCKET", "/api/rec/{token}/undocumented"),
        ("GET", "/api/review/{token}/undocumented"),
    ],
)
def test_missing_note_for_rec_or_review_route_fails(
    monkeypatch: pytest.MonkeyPatch, extra: tuple[str, str]
) -> None:
    mod = _load_contract()
    live = [*list(mod._ROUTE_NOTES), extra]
    monkeypatch.setattr(mod, "_iter_app_routes", lambda: live)
    errors = mod.check_share_http_mcp_parity()
    joined = "\n".join(errors)
    assert "missing curated notes" in joined
    assert extra[1] in joined
    assert extra not in mod._ROUTE_NOTES
