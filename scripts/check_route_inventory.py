#!/usr/bin/env python3
"""Keep ``contracts/route-inventory.json`` equal to the routes the real app mounts (#3123).

The inventory has one row per ``(method, path)`` of the app that ``create_app()`` builds with the
collaboration extension routers, the share UI routes and the account router the tests mount by
hand. Each row records the gate class of its handler:

* ``host``: the handler calls ``require_host``, directly or through a known helper.
* ``authz``: the handler calls ``require_authz`` or ``authorize_client``.
* ``guest``: a share-token router (``review_editor``, ``review_share``, ``record_share``,
  ``remote_mcp``) whose own gate admits the guest.
* ``public``: named in ``PUBLIC_ROUTES`` with a reason.
* ``other``: every other route, with the reason from ``OTHER_REASONS`` or ``OVERRIDES``.

The class comes from the AST of the handler source, so a comment or a string that says
``require_host`` does not count. ``host_direct_baseline`` is a ratchet: the number of handlers that
call ``require_host`` themselves may only shrink. ``--write`` regenerates the file and lowers the
baseline, never raises it. ``--check`` (the default) fails on any difference.
"""

from __future__ import annotations

import ast
import inspect
import json
import os
import sys
import tempfile
import textwrap
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "route-inventory.json"
WRITE_HINT = (
    "Run scripts/check_route_inventory.py --write to regenerate contracts/route-inventory.json."
)
API_VERSION = 1
MOUNT = "MOUNT"
WEBSOCKET = "WS"
UNREVIEWED = "unreviewed: add a reason to OTHER_REASONS in scripts/check_route_inventory.py"

HOST_CALL = "require_host"
HOST_HELPERS: dict[str, str] = {
    "_host_project": "podcast_mcp.gui.routes.waveform",
    "_session_heard": "podcast_mcp.gui.routes.document",
}
AUTHZ_CALLS = frozenset({"require_authz", "authorize_client"})
GUEST_MODULES = frozenset(
    {
        "podcast_mcp.gui.routes.review_editor",
        "podcast_mcp.gui.routes.review_share",
        "podcast_mcp.gui.routes.record_share",
        "podcast_mcp.gui.routes.remote_mcp",
    }
)

PUBLIC_ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/api/health"): "liveness probe",
    ("GET", "/api/features"): "extension manifest the SPA reads before it has a session",
    ("GET", "/api/pipeline/steps"): "static list of step names",
    ("GET", "/favicon.svg"): "static bundle",
    ("GET", "/favicon.ico"): "static bundle",
    (MOUNT, "/assets"): "static bundle",
    ("GET", "/r/{token}"): "share SPA shell; the token only picks the page head",
    ("GET", "/rec/{token}"): "record SPA shell; the token only picks the page head",
    ("GET", "/docs"): "FastAPI interactive docs",
    ("GET", "/docs/oauth2-redirect"): "FastAPI interactive docs",
    ("GET", "/openapi.json"): "FastAPI schema",
    ("GET", "/redoc"): "FastAPI interactive docs",
}
OVERRIDES: dict[tuple[str, str], str] = {
    ("GET", "/"): "SPA shell; require_host runs only for the project-mismatch page",
}
OTHER_REASONS: dict[str, str] = {
    "podcast_mcp.gui.routes.auth": "account sign-in flow; the caller has no session yet",
    "podcast_mcp.gui.routes.handoff": "own handoff-token check (_unauthorized)",
    "podcast_mcp.gui.host_mcp": "stateless host MCP transport; mounted on loopback binds only",
}


def call_names(function: Callable[..., Any]) -> frozenset[str]:
    """Names of every function or method the handler source calls, nested definitions included."""
    try:
        source = textwrap.dedent(inspect.getsource(inspect.unwrap(function)))
    except (OSError, TypeError):
        return frozenset()
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return frozenset(names)


def calls_require_host(function: Callable[..., Any]) -> bool:
    return HOST_CALL in call_names(function)


def gate_of(method: str, path: str, handler: Callable[..., Any]) -> tuple[str, str | None]:
    """The gate class of a handler and, for ``public`` and ``other``, the reason."""
    key = (method, path)
    if key in OVERRIDES:
        return "other", OVERRIDES[key]
    names = call_names(handler)
    module = getattr(handler, "__module__", type(handler).__module__)
    if HOST_CALL in names or names & HOST_HELPERS.keys():
        return "host", None
    if names & AUTHZ_CALLS:
        return "authz", None
    if module in GUEST_MODULES:
        return "guest", None
    if key in PUBLIC_ROUTES:
        return "public", PUBLIC_ROUTES[key]
    return "other", OTHER_REASONS.get(module, UNREVIEWED)


def handler_id(handler: Callable[..., Any]) -> str:
    target = handler if hasattr(handler, "__qualname__") else type(handler)
    return f"{target.__module__}:{target.__qualname__}"


def _walk(routes: list[Any]) -> Iterator[Any]:
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _walk(list(included.routes))
        else:
            yield route


def _methods(route: Any) -> list[str]:
    declared = getattr(route, "methods", None)
    if declared is None:
        return [MOUNT] if hasattr(route, "app") and not hasattr(route, "endpoint") else [WEBSOCKET]
    return sorted(m for m in declared if m != "HEAD" or "GET" not in declared)


def build_app() -> Any:
    """``create_app()`` with only the collaboration extension, plus the account router."""
    previous = os.environ.get("PODCAST_EXTENSIONS")
    os.environ["PODCAST_EXTENSIONS"] = "collaboration"
    try:
        from podcast_mcp.gui.routes import auth
        from podcast_mcp.gui.server import create_app

        with tempfile.TemporaryDirectory() as raw:
            static = Path(raw)
            (static / "assets").mkdir()
            (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
            app = create_app(static_dir=static)
        app.include_router(auth.router)
        return app
    finally:
        if previous is None:
            os.environ.pop("PODCAST_EXTENSIONS", None)
        else:
            os.environ["PODCAST_EXTENSIONS"] = previous


def live_rows(app: Any | None = None) -> list[dict[str, Any]]:
    """One row per mounted ``(method, path)``, sorted, from the routes ``app`` serves."""
    app = build_app() if app is None else app
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for route in _walk(list(app.routes)):
        handler: Callable[..., Any] = getattr(route, "endpoint", None) or route.app
        for method in _methods(route):
            gate, reason = gate_of(method, route.path, handler)
            row: dict[str, Any] = {
                "method": method,
                "path": route.path,
                "gate": gate,
                "handler": handler_id(handler),
            }
            if calls_require_host(handler):
                row["host_direct"] = True
            if reason is not None:
                row["reason"] = reason
            rows.setdefault((method, route.path), row)
    return [rows[key] for key in sorted(rows, key=lambda k: (k[1], k[0]))]


def host_direct_count(rows: list[dict[str, Any]]) -> int:
    """Handlers that call ``require_host`` themselves (a handler on two methods counts once)."""
    return len({row["handler"] for row in rows if row.get("host_direct")})


def load_contract(path: Path = CONTRACT) -> dict[str, Any]:
    if not path.is_file():
        return {"host_direct_baseline": 0, "routes": []}
    return json.loads(path.read_text(encoding="utf-8"))


def problems(live: list[dict[str, Any]], contract: dict[str, Any]) -> Iterator[str]:
    """One message per drift between the mounted routes and the recorded inventory."""
    recorded = {(r["method"], r["path"]): r for r in contract["routes"]}
    mounted = {(r["method"], r["path"]): r for r in live}
    for method, path in sorted(mounted.keys() - recorded.keys(), key=lambda k: (k[1], k[0])):
        yield f"{method} {path} is mounted but has no row in the inventory. {WRITE_HINT}"
    for method, path in sorted(recorded.keys() - mounted.keys(), key=lambda k: (k[1], k[0])):
        yield f"{method} {path} has a row but no mounted route. {WRITE_HINT}"
    for key in sorted(mounted.keys() & recorded.keys(), key=lambda k: (k[1], k[0])):
        if mounted[key]["gate"] != recorded[key]["gate"]:
            yield (
                f"{key[0]} {key[1]} is gated as {mounted[key]['gate']!r} but the inventory "
                f"records {recorded[key]['gate']!r}. {WRITE_HINT}"
            )
    for row in live:
        if row.get("reason") == UNREVIEWED:
            yield f"{row['method']} {row['path']} is an unreviewed 'other' route. {UNREVIEWED}."
    direct, baseline = host_direct_count(live), int(contract["host_direct_baseline"])
    if direct > baseline:
        yield (
            f"{direct} handlers call require_host directly, baseline is {baseline}. The count may "
            "only shrink: gate the new route another way instead of raising the baseline."
        )
    elif direct < baseline:
        yield (
            f"{direct} handlers call require_host directly, baseline is {baseline}. "
            f"Lower it. {WRITE_HINT}"
        )


def render(live: list[dict[str, Any]], baseline: int) -> str:
    payload = {
        "api_version": API_VERSION,
        "comment": (
            "Gate class of every route the app mounts (#3123). host_direct_baseline is a ratchet: "
            "the handlers that call require_host themselves may only shrink. Regenerate with "
            "scripts/check_route_inventory.py --write."
        ),
        "host_direct_baseline": baseline,
        "routes": live,
    }
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    live = live_rows()
    contract = load_contract()
    if "--write" in args:
        direct = host_direct_count(live)
        baseline = (
            min(direct, int(contract["host_direct_baseline"])) if CONTRACT.is_file() else direct
        )
        CONTRACT.write_text(render(live, baseline), encoding="utf-8")
        print(f"wrote {CONTRACT.relative_to(ROOT)}: {len(live)} routes, baseline {baseline}")
        if direct > baseline:
            print(
                f"{direct} handlers call require_host directly; the baseline stays at {baseline} "
                "and may not be raised.",
                file=sys.stderr,
            )
            return 1
        return 0
    found = list(problems(live, contract))
    if CONTRACT.is_file() and render(live, int(contract["host_direct_baseline"])) != (
        CONTRACT.read_text(encoding="utf-8")
    ):
        found.append(f"{CONTRACT.relative_to(ROOT)} is not the generated form. {WRITE_HINT}")
    for message in found:
        print(message, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
