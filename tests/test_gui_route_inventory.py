"""Every route the app mounts has a gate class in ``contracts/route-inventory.json`` (#3123)."""

from __future__ import annotations

import copy
import importlib
import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_route_inventory", ROOT / "scripts" / "check_route_inventory.py"
)
assert _SPEC is not None and _SPEC.loader is not None
inventory = importlib.util.module_from_spec(_SPEC)
sys.modules["check_route_inventory"] = inventory
_SPEC.loader.exec_module(inventory)

WRITE = "check_route_inventory.py --write"


@pytest.fixture(scope="module")
def live() -> list[dict[str, Any]]:
    return inventory.live_rows()


@pytest.fixture(scope="module")
def contract() -> dict[str, Any]:
    if not inventory.CONTRACT.is_file():
        pytest.fail(f"contracts/route-inventory.json is missing. Run scripts/{WRITE}.")
    return inventory.load_contract()


def _keys(rows: list[dict[str, Any]]) -> set[tuple[str, str]]:
    return {(r["method"], r["path"]) for r in rows}


def test_every_mounted_route_has_a_row(live, contract) -> None:
    missing = sorted(_keys(live) - _keys(contract["routes"]))
    assert not missing, f"mounted routes without a row: {missing}. Run scripts/{WRITE}."


def test_every_row_has_a_mounted_route(live, contract) -> None:
    stale = sorted(_keys(contract["routes"]) - _keys(live))
    assert not stale, f"rows without a mounted route: {stale}. Run scripts/{WRITE}."


def test_recorded_gate_classes_match_the_handlers(live, contract) -> None:
    recorded = {(r["method"], r["path"]): r["gate"] for r in contract["routes"]}
    drift = sorted(
        (r["method"], r["path"], recorded[(r["method"], r["path"])], r["gate"])
        for r in live
        if (r["method"], r["path"]) in recorded and recorded[(r["method"], r["path"])] != r["gate"]
    )
    assert not drift, f"(method, path, recorded, live): {drift}. Run scripts/{WRITE}."


def test_direct_require_host_handlers_only_shrink(live, contract) -> None:
    direct, baseline = inventory.host_direct_count(live), contract["host_direct_baseline"]
    assert direct <= baseline, (
        f"{direct} handlers call require_host directly, baseline is {baseline}. "
        "The count may only shrink; gate the route another way."
    )
    assert direct == baseline, (
        f"{direct} handlers call require_host directly, baseline is {baseline}. "
        f"Lower host_direct_baseline: run scripts/{WRITE}."
    )


def test_the_contract_is_the_generated_form(live, contract) -> None:
    rendered = inventory.render(live, contract["host_direct_baseline"])
    assert inventory.CONTRACT.read_text(encoding="utf-8") == rendered, (
        f"contracts/route-inventory.json is not the generated form. Run scripts/{WRITE}."
    )


def test_no_other_route_is_unreviewed(live) -> None:
    unreviewed = [r["path"] for r in live if r.get("reason") == inventory.UNREVIEWED]
    assert not unreviewed, f"add a reason to OTHER_REASONS for: {unreviewed}"


def test_the_inventory_covers_the_extension_and_share_ui_routes(live) -> None:
    keys = _keys(live)
    assert ("GET", "/api/review/{token}/project") in keys
    assert ("POST", "/api/review/{token}/daw/pipeline/run") in keys
    assert ("GET", "/api/rec/{token}/bootstrap") in keys
    assert ("GET", "/mcp/{token}") in keys
    assert ("POST", "/api/shares") in keys
    assert ("GET", "/auth/me") in keys
    assert ("GET", "/r/{token}") in keys
    assert {"WS"} == {m for m, p in keys if p.endswith("/ws")}
    assert inventory.WEBSOCKET in {r["method"] for r in live if r["path"] == "/api/host/ws"}


@pytest.mark.parametrize("helper", sorted(inventory.HOST_HELPERS))
def test_known_host_helpers_call_require_host(helper: str) -> None:
    module = importlib.import_module(inventory.HOST_HELPERS[helper])
    assert inventory.calls_require_host(getattr(module, helper))


def require_host(request): ...


def require_authz(request): ...


def _host_project(request): ...


def _plain(request): ...


def _direct(request):
    require_host(request)


def _helper(request):
    _host_project(request)


def _authorized(request):
    require_authz(request)


def _commented(request):
    """Mentions require_host(request) in a docstring only."""
    return "require_host(request)"


def test_gate_classes_come_from_the_handler_source() -> None:
    assert inventory.gate_of("GET", "/x", _direct) == ("host", None)
    assert inventory.gate_of("GET", "/x", _helper) == ("host", None)
    assert inventory.gate_of("GET", "/x", _authorized) == ("authz", None)
    assert inventory.gate_of("GET", "/x", _commented) == ("other", inventory.UNREVIEWED)
    assert inventory.gate_of("GET", "/x", _plain) == ("other", inventory.UNREVIEWED)
    assert inventory.calls_require_host(_direct)
    assert not inventory.calls_require_host(_helper)
    assert not inventory.calls_require_host(_commented)


def test_an_unlisted_route_a_stale_row_and_a_raised_baseline_each_fail(live) -> None:
    contract = {
        "host_direct_baseline": inventory.host_direct_count(live),
        "routes": copy.deepcopy(live),
    }
    assert list(inventory.problems(live, contract)) == []

    extra = [*live, {"method": "GET", "path": "/api/new", "gate": "host", "handler": "m:f"}]
    assert any(
        "/api/new is mounted but has no row" in m for m in inventory.problems(extra, contract)
    )

    shrunk = copy.deepcopy(contract)
    shrunk["routes"] = [r for r in shrunk["routes"] if r["path"] != "/api/health"]
    assert any(
        "/api/health is mounted but has no row" in m for m in inventory.problems(live, shrunk)
    )

    stale = copy.deepcopy(contract)
    stale["routes"].append({"method": "GET", "path": "/gone", "gate": "host", "handler": "m:f"})
    assert any("/gone has a row but no mounted route" in m for m in inventory.problems(live, stale))

    drifted = copy.deepcopy(contract)
    drifted["routes"][0]["gate"] = "public"
    assert any("records 'public'" in m for m in inventory.problems(live, drifted))

    lowered = copy.deepcopy(contract)
    lowered["host_direct_baseline"] -= 1
    messages = list(inventory.problems(live, lowered))
    assert any("may only shrink" in m for m in messages)

    raised = copy.deepcopy(contract)
    raised["host_direct_baseline"] += 1
    assert any("Lower it" in m for m in inventory.problems(live, raised))
