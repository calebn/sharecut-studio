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

from fastapi import APIRouter, Depends, FastAPI

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
    assert not unreviewed, f"add the route to OVERRIDES or PUBLIC_ROUTES: {unreviewed}"


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


def _depends(request, gate=Depends(require_host)): ...


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
    assert inventory.gate_of("GET", "/x", _depends) == ("host", None)
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


def _rows(app: Any) -> dict[tuple[str, str], dict[str, Any]]:
    return {(r["method"], r["path"]): r for r in inventory.live_rows([app])}


def test_include_router_prefix_and_dependencies_apply_to_every_child() -> None:
    inner = APIRouter(prefix="/inner")
    inner.get("/leaf")(_plain)
    outer = APIRouter(prefix="/outer")
    outer.get("/own")(_plain)
    outer.include_router(inner, prefix="/mid", dependencies=[Depends(require_authz)])
    app = FastAPI()
    app.include_router(outer, prefix="/api", dependencies=[Depends(require_host)])
    rows = _rows(app)
    assert rows[("GET", "/api/outer/own")]["gate"] == "host"
    assert rows[("GET", "/api/outer/mid/inner/leaf")]["gate"] == "host"
    assert ("GET", "/own") not in rows and ("GET", "/leaf") not in rows


def test_a_router_level_gate_is_a_gate_but_not_a_direct_call() -> None:
    gated = APIRouter(dependencies=[Depends(require_host)])
    gated.get("/one")(_plain)
    direct = APIRouter()
    direct.get("/two")(_direct)
    app = FastAPI()
    app.include_router(gated, prefix="/g")
    app.include_router(direct, prefix="/d")
    rows = _rows(app)
    assert rows[("GET", "/g/one")]["gate"] == "host"
    assert "host_direct" not in rows[("GET", "/g/one")]
    assert rows[("GET", "/d/two")]["host_direct"] is True
    assert inventory.host_direct_count(list(rows.values())) == 1


def test_an_include_without_a_gate_leaves_the_class_to_the_handler() -> None:
    inner = APIRouter()
    inner.get("/plain")(_plain)
    inner.get("/authz")(_authorized)
    app = FastAPI()
    app.include_router(inner, prefix="/p")
    rows = _rows(app)
    assert rows[("GET", "/p/plain")]["gate"] == "other"
    assert rows[("GET", "/p/authz")]["gate"] == "authz"


def test_an_include_time_gate_does_not_leak_to_a_sibling_include() -> None:
    gated, open_ = APIRouter(), APIRouter()
    gated.get("/a")(_plain)
    open_.get("/b")(_plain)
    app = FastAPI()
    app.include_router(gated, prefix="/x", dependencies=[Depends(require_host)])
    app.include_router(open_, prefix="/y")
    rows = _rows(app)
    assert rows[("GET", "/x/a")]["gate"] == "host"
    assert rows[("GET", "/y/b")]["gate"] == "other"


def test_include_time_gates_apply_only_to_api_routes() -> None:
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Mount, Route

    async def plain_endpoint(request):
        return PlainTextResponse("ok")

    router = APIRouter()
    router.get("/api")(_plain)
    router.routes.append(Route("/sroute", plain_endpoint))
    router.routes.append(Mount("/m", app=Starlette()))
    app = FastAPI()
    app.include_router(router, prefix="/g", dependencies=[Depends(require_host)])
    rows = _rows(app)
    assert rows[("GET", "/g/api")]["gate"] == "host"
    assert rows[("GET", "/g/sroute")]["gate"] == "other"
    assert rows[(inventory.MOUNT, "/g/m")]["gate"] == "other"


def test_a_mid_level_include_gate_reaches_the_leaf() -> None:
    inner = APIRouter()
    inner.get("/leaf")(_plain)
    outer = APIRouter()
    outer.include_router(inner, prefix="/mid", dependencies=[Depends(require_authz)])
    app = FastAPI()
    app.include_router(outer, prefix="/top")
    assert _rows(app)[("GET", "/top/mid/leaf")]["gate"] == "authz"


def test_write_exits_nonzero_when_it_emits_an_unreviewed_row(monkeypatch, tmp_path, capsys) -> None:
    row = {"method": "GET", "path": "/new", "gate": "other", "handler": "m:f"}
    monkeypatch.setattr(inventory, "ROOT", tmp_path)
    monkeypatch.setattr(inventory, "CONTRACT", tmp_path / "route-inventory.json")
    monkeypatch.setattr(inventory, "live_rows", lambda: [{**row, "reason": inventory.UNREVIEWED}])
    assert inventory.main(["--write"]) == 1
    err = capsys.readouterr().err
    assert "GET /new was written to the inventory, unreviewed: add the route to OVERRIDES" in err
    assert "unreviewed. unreviewed" not in err
    monkeypatch.setattr(inventory, "live_rows", lambda: [{**row, "reason": "reviewed"}])
    assert inventory.main(["--write"]) == 0
