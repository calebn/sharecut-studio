"""Every host-gated route is Host/Origin-bound (#3751)."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from podcast_mcp.gui.middleware_host_binding import path_requires_host_binding
from podcast_mcp.gui.server import create_app

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_route_inventory", ROOT / "scripts" / "check_route_inventory.py"
)
assert _SPEC is not None and _SPEC.loader is not None
inventory = importlib.util.module_from_spec(_SPEC)
sys.modules["check_route_inventory"] = inventory
_SPEC.loader.exec_module(inventory)

EXEMPT: dict[tuple[str, str], str] = {}

NEW_PREFIXES = (
    "/api/feed",
    "/api/speaker",
    "/api/boundary",
    "/api/session-suggestion",
    "/api/pending-preview",
    "/api/range-audio",
    "/api/clips",
    "/api/tunnel",
)

FIX = "add the prefix to _PROTECTED_PREFIXES or add an EXEMPT reason"
EVIL_ORIGIN = {"Origin": "https://evil.example"}
EVIL_HOST = {"Host": "evil.example"}
SAME_ORIGIN = {"Origin": "http://127.0.0.1:8765"}

ROWS: list[dict[str, Any]] = inventory.live_rows()
HOST_ROWS = [r for r in ROWS if r["gate"] == "host"]
GUEST_ROWS = [r for r in ROWS if r["gate"] == "guest"]
NEW_ROWS = [
    r
    for r in HOST_ROWS
    if any(r["path"] == p or r["path"].startswith(p + "/") for p in NEW_PREFIXES)
]


def _id(row: dict[str, Any]) -> str:
    return f"{row['method']} {row['path']}"


def _url(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


@pytest.fixture(scope="module")
def client():
    with pytest.MonkeyPatch.context() as mp:
        mp.delenv("PODCAST_SESSION_AUTHZ", raising=False)
        yield TestClient(create_app())


@pytest.mark.parametrize("row", HOST_ROWS, ids=_id)
def test_every_host_route_is_host_bound(row: dict[str, Any]) -> None:
    key = (row["method"], row["path"])
    if key in EXEMPT:
        return
    assert path_requires_host_binding(row["path"]), f"{_id(row)} is unbound: {FIX}"


def test_exemptions_are_live_unprotected_and_justified() -> None:
    live = {(r["method"], r["path"]) for r in HOST_ROWS}
    for key, reason in EXEMPT.items():
        assert key in live, f"stale EXEMPT entry {key}: not a live host row"
        assert not path_requires_host_binding(key[1]), f"stale EXEMPT entry {key}: now protected"
        assert isinstance(reason, str) and len(reason.strip()) >= 20, f"EXEMPT {key} needs a reason"


@pytest.mark.parametrize("row", GUEST_ROWS, ids=_id)
def test_no_guest_route_is_host_bound(row: dict[str, Any]) -> None:
    assert not path_requires_host_binding(row["path"]), f"{_id(row)} is a guest route"


def test_the_new_prefixes_cover_nineteen_host_rows() -> None:
    assert len(NEW_ROWS) == 19


def _call(client: TestClient, row: dict[str, Any], headers: dict[str, str]):
    kwargs: dict[str, Any] = {"json": {}} if row["method"] == "POST" else {}
    return client.request(row["method"], _url(row["path"]), headers=headers, **kwargs)


@pytest.mark.parametrize("row", NEW_ROWS, ids=_id)
def test_forged_origin_is_forbidden(client: TestClient, row: dict[str, Any]) -> None:
    assert _call(client, row, EVIL_ORIGIN).status_code == 403


@pytest.mark.parametrize("row", NEW_ROWS, ids=_id)
def test_forged_host_is_rejected(client: TestClient, row: dict[str, Any]) -> None:
    assert _call(client, row, EVIL_HOST).status_code == 400


@pytest.mark.parametrize("row", NEW_ROWS, ids=_id)
@pytest.mark.parametrize("headers", [SAME_ORIGIN, {}], ids=["same-origin", "no-origin"])
def test_loopback_and_originless_requests_reach_the_handler(
    client: TestClient, row: dict[str, Any], headers: dict[str, str]
) -> None:
    assert _call(client, row, headers).status_code not in (400, 403)
