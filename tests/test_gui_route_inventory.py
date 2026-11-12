"""Every route the app mounts has a gate class in ``contracts/route-inventory.json`` (#3123)."""

from __future__ import annotations

import copy
import importlib
import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from script_loader import load_script

pytest.importorskip("fastapi")

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_route_inventory", ROOT / "scripts" / "check_route_inventory.py"
)
assert _SPEC is not None and _SPEC.loader is not None
inventory = importlib.util.module_from_spec(_SPEC)
sys.modules["check_route_inventory"] = inventory
_SPEC.loader.exec_module(inventory)

WRITE = "check_route_inventory.py --write"
branches = load_script("branches", register=True)


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


def _contract_of(live: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "host_direct_baseline": inventory.host_direct_count(live),
        "routes": copy.deepcopy(live),
    }


def test_the_contract_matches_the_mounted_routes(live, contract) -> None:
    assert list(inventory.problems(live, contract)) == [], f"Run scripts/{WRITE}."


def test_the_contract_is_the_generated_form(live, contract) -> None:
    rendered = inventory.render(live, contract["host_direct_baseline"])
    assert inventory.CONTRACT.read_text(encoding="utf-8") == rendered, (
        f"contracts/route-inventory.json is not the generated form. Run scripts/{WRITE}."
    )


def test_the_baseline_has_not_grown_since_the_origin_base(live, contract) -> None:
    base = f"origin/{branches.base()}"
    resolves = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
        cwd=ROOT,
        check=False,
        capture_output=True,
    )
    if resolves.returncode:
        pytest.skip(f"{base} is not available in this checkout")
    recorded = inventory.base_baseline(base)
    problems = inventory.growth(
        recorded, inventory.host_direct_count(live), contract["host_direct_baseline"]
    )
    assert list(problems) == []


def test_a_raised_baseline_with_a_new_direct_handler_fails_the_growth_check(live) -> None:
    base = inventory.host_direct_count(live)
    assert list(inventory.growth(None, base + 1, base + 1)) == []
    assert list(inventory.growth(base, base, base)) == []
    assert len(list(inventory.growth(base, base + 1, base + 1))) == 2


def test_no_other_route_is_unreviewed(live) -> None:
    unreviewed = [r["path"] for r in live if r.get("reason") == inventory.UNREVIEWED]
    assert not unreviewed, f"add a reason to OTHER_REASONS or OVERRIDES for: {unreviewed}"


def test_the_inventory_covers_the_extension_and_share_ui_routes(live) -> None:
    keys = _keys(live)
    assert ("GET", "/api/review/{token}/project") in keys
    assert ("POST", "/api/review/{token}/daw/pipeline/run") in keys
    assert ("GET", "/api/rec/{token}/bootstrap") in keys
    assert ("GET", "/mcp/{token}") in keys
    assert ("POST", "/api/shares") in keys
    assert ("GET", "/auth/me") in keys
    assert ("GET", "/r/{token}") in keys
    assert {inventory.WEBSOCKET} == {m for m, p in keys if p.endswith("/ws")}


def test_the_variants_each_mount_a_subset_of_the_inventory(live) -> None:
    for app in inventory.variant_apps():
        assert _keys(inventory.live_rows([app])) <= _keys(live)
    without_bundle = _keys(inventory.live_rows([inventory.build_app(bundle=False)]))
    assert (inventory.MOUNT, "/assets") not in without_bundle
    lan = _keys(inventory.live_rows([inventory.build_app(bind_host="0.0.0.0")]))
    assert ("POST", "/mcp") not in lan
    assert ("POST", "/mcp") in _keys(live)


def test_the_account_routes_that_need_a_session_say_so(live) -> None:
    reasons = {(r["method"], r["path"]): r.get("reason", "") for r in live}
    for path in ("/auth/passkey/register/begin", "/auth/passkey/register/finish", "/auth/logout"):
        assert "no session yet" not in reasons[("POST", path)]
    assert "no session yet" in reasons[("POST", "/auth/password/login")]


@pytest.mark.parametrize("helper", sorted(inventory.HOST_HELPERS))
def test_known_host_helpers_call_require_host(helper: str) -> None:
    module = importlib.import_module(inventory.HOST_HELPERS[helper])
    assert inventory.HOST_CALL in inventory.referenced_names(getattr(module, helper))


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


def _depends(request, gate=require_host):
    return gate


def _aliased(request):
    gate = require_host
    gate(request)


def _commented(request):
    """Mentions require_host(request) in a docstring only."""
    return "require_host(request)"


def test_gate_classes_come_from_the_handler_source() -> None:
    assert inventory.gate_of("GET", "/x", _direct) == ("host", None)
    assert inventory.gate_of("GET", "/x", _helper) == ("host", None)
    assert inventory.gate_of("GET", "/x", _authorized) == ("authz", None)
    assert inventory.gate_of("GET", "/x", _aliased) == ("host", None)
    assert inventory.gate_of("GET", "/x", _commented) == ("other", inventory.UNREVIEWED)
    assert inventory.gate_of("GET", "/x", _plain) == ("other", inventory.UNREVIEWED)
    assert inventory.HOST_CALL in inventory.referenced_names(_direct)
    assert inventory.HOST_CALL not in inventory.referenced_names(_helper)
    assert inventory.HOST_CALL not in inventory.referenced_names(_commented)


def test_a_dependency_on_a_gate_counts_and_unreadable_source_fails() -> None:
    assert inventory.gate_of("GET", "/x", _plain, [_direct]) == ("host", None)
    assert inventory.gate_of("GET", "/x", _plain, [_authorized]) == ("authz", None)
    namespace: dict[str, Any] = {}
    exec("def unreadable(request): ...", namespace)
    unreadable = namespace["unreadable"]
    with pytest.raises((OSError, TypeError)):
        inventory.referenced_names(unreadable)


def test_a_guest_module_handler_must_name_a_check() -> None:
    def _check_token(token): ...

    def named(token):
        _check_token(token)

    def bare(token): ...

    named.__module__ = bare.__module__ = "podcast_mcp.gui.routes.review_share"
    assert inventory.gate_of("GET", "/x", named) == ("guest", None)
    assert inventory.gate_of("GET", "/x", bare) == ("other", inventory.UNREVIEWED)


def test_a_duplicate_method_and_path_is_an_error() -> None:
    from fastapi import FastAPI

    app = FastAPI()
    app.get("/dup")(_plain)
    app.get("/dup")(_authorized)
    with pytest.raises(ValueError, match="mounted twice"):
        inventory.live_rows([app])


def test_each_drift_is_reported(live) -> None:
    contract = _contract_of(live)
    extra = [*live, {"method": "GET", "path": "/api/new", "gate": "host", "handler": "m:f"}]
    assert any(
        "/api/new is mounted but has no row" in m for m in inventory.problems(extra, contract)
    )

    health = next(r for r in contract["routes"] if r["path"] == "/api/health")
    shrunk = {**contract, "routes": [r for r in contract["routes"] if r is not health]}
    assert any(
        "/api/health is mounted but has no row" in m for m in inventory.problems(live, shrunk)
    )

    stale = copy.deepcopy(contract)
    stale["routes"].append({"method": "GET", "path": "/gone", "gate": "host", "handler": "m:f"})
    assert any("/gone has a row but no mounted route" in m for m in inventory.problems(live, stale))


def test_a_changed_gate_class_is_reported(live) -> None:
    drifted = _contract_of(live)
    health = next(r for r in drifted["routes"] if r["path"] == "/api/health")
    health["gate"] = "host"
    assert any("records 'host'" in m for m in inventory.problems(live, drifted))


def test_the_baseline_must_equal_the_count(live) -> None:
    lowered = _contract_of(live)
    lowered["host_direct_baseline"] -= 1
    assert any("may only shrink" in m for m in inventory.problems(live, lowered))

    raised = _contract_of(live)
    raised["host_direct_baseline"] += 1
    assert any("Lower it" in m for m in inventory.problems(live, raised))
