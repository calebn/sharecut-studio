#!/usr/bin/env python3
"""Keep ``contracts/route-inventory.json`` equal to the routes the real app mounts (#3123).

The inventory has one row per ``(method, path)`` of the app that ``create_app()`` builds with the
collaboration extension routers, the share UI routes and the account router the tests mount by
hand. Each row records the gate class of its handler:

* ``host``: the handler calls ``require_host``, directly or through a known helper.
* ``authz``: the handler calls ``require_authz`` or ``authorize_client``.
* ``guest``: a handler of a share-token router (``review_editor``, ``review_share``,
  ``record_share``, ``remote_mcp``) that names one of ``GUEST_CHECKS`` or depends on a
  registered ``guest_route`` twin. A guest-module handler with neither is ``unreviewed``.
* ``public``: named in ``PUBLIC_ROUTES`` with a reason.
* ``other``: every other route, with the reason from ``OTHER_REASONS`` or ``OVERRIDES``.

The class comes from the AST of the handler source, so a comment or a string that says
``require_host`` does not count. ``host_direct_baseline`` is a ratchet: the number of handlers that
call ``require_host`` themselves may only shrink. ``--write`` regenerates the file and lowers the
baseline, never raises it, and exits nonzero when it writes an unreviewed row. ``--check`` (the
default) fails on any difference. ``--base REF`` also fails when the baseline or the live count is
above the one recorded at REF, and caps ``--write`` at it.
"""

from __future__ import annotations

import argparse
import ast
import inspect
import json
import os
import subprocess
import sys
import tempfile
import textwrap
from collections.abc import Callable, Iterable, Iterator
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
UNREVIEWED = (
    "unreviewed: add the route to OVERRIDES or PUBLIC_ROUTES (the per-route reason tables) "
    "in scripts/check_route_inventory.py"
)

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

GUEST_CHECKS = frozenset(
    {
        "_guest_call",
        "_check_token",
        "check_share_token",
        "require_share_cap",
        "require_share_edit",
        "_require_mcp_capability",
        "admit_guest_ws",
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
    ("GET", "/api/export/files/{file_id:path}"): (
        "require_host unless a per-file export ticket is given, which then stands in for it"
    ),
    ("HEAD", "/api/export/files/{file_id:path}"): (
        "require_host unless a per-file export ticket is given, which then stands in for it"
    ),
    ("GET", "/auth/providers"): "lists the sign-in providers; the caller has no session yet",
    (
        "GET",
        "/auth/me",
    ): "reads the session cookie or a Bearer session; 401 sign_in_required without one",
    ("POST", "/auth/logout"): "revokes the session cookie it is sent; a missing cookie is a no-op",
    ("GET", "/auth/login/{provider}"): "starts the OAuth redirect; the caller has no session yet",
    ("GET", "/auth/callback/{provider}"): "finishes the OAuth redirect and mints the session",
    ("POST", "/auth/password/register"): "creates the account and its session; no session yet",
    ("POST", "/auth/password/login"): "checks the password and mints the session; no session yet",
    ("POST", "/auth/magic-link"): (
        "sends no email; returns or prints the link only when PODCAST_MAGIC_LINK_PRINT=1 on a "
        "loopback peer that is not relayed; the caller has no session yet"
    ),
    ("GET", "/auth/magic-link/consume"): "the one-time token mints the session; no session yet",
    ("POST", "/auth/passkey/register/begin"): "needs the session cookie; 401 without one",
    ("POST", "/auth/passkey/register/finish"): "needs the session cookie; 401 without one",
    (
        "POST",
        "/auth/passkey/login/begin",
    ): "starts a passkey sign-in; the caller has no session yet",
    (
        "POST",
        "/auth/passkey/login/finish",
    ): "checks the passkey and mints the session; no session yet",
    (
        "POST",
        "/auth/agent-credential",
    ): "needs the session cookie and a share ACL entry for the user",
    ("GET", "/auth/login"): "static sign-in hint page; the caller has no session yet",
}
OTHER_REASONS: dict[str, str] = {
    "podcast_mcp.gui.routes.handoff": "own handoff-token check (_unauthorized)",
    "podcast_mcp.gui.host_mcp": "stateless host MCP transport; mounted on loopback binds only",
}


def _by_path(key: tuple[str, str]) -> tuple[str, str]:
    return key[1], key[0]


def referenced_names(function: Callable[..., Any]) -> frozenset[str]:
    """Names the handler source calls or refers to, nested definitions included.

    A reference counts as well as a call, so ``Depends(require_host)`` is seen, and an import alias
    resolves through the function's globals. A routine whose source cannot be read raises: the
    inventory must not guess a gate from nothing. Objects that are not routines (mounted ASGI apps)
    have no handler source and give an empty set.
    """
    target = inspect.unwrap(function)
    if not inspect.isroutine(target):
        return frozenset()
    tree = ast.parse(textwrap.dedent(inspect.getsource(target)))
    scope = getattr(target, "__globals__", {})
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
            names.add(getattr(scope.get(node.id), "__name__", node.id))
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
    return frozenset(names)


def dependency_callables(route: Any) -> Iterator[Callable[..., Any]]:
    """Every ``Depends`` callable of a route, nested dependencies included."""
    pending = list(getattr(getattr(route, "dependant", None), "dependencies", []))
    while pending:
        dependant = pending.pop()
        if dependant.call is not None:
            yield dependant.call
        pending.extend(dependant.dependencies)


def gate_of(
    method: str,
    path: str,
    handler: Callable[..., Any],
    dependencies: Iterable[Callable[..., Any]] = (),
) -> tuple[str, str | None]:
    """The gate class of a handler and, for ``public`` and ``other``, the reason.

    ``dependencies`` are the ``Depends`` callables of the route: their source counts as the
    handler's own.
    """
    key = (method, path)
    if key in OVERRIDES:
        return "other", OVERRIDES[key]
    dependencies = list(dependencies)
    names = referenced_names(handler).union(*map(referenced_names, dependencies))
    names |= {getattr(call, "__name__", "") for call in dependencies}
    module = getattr(handler, "__module__", type(handler).__module__)
    if HOST_CALL in names or names & HOST_HELPERS.keys():
        return "host", None
    if names & AUTHZ_CALLS:
        return "authz", None
    registered = any(hasattr(call, "guest_route_name") for call in dependencies)
    if module in GUEST_MODULES and (names & GUEST_CHECKS or registered):
        return "guest", None
    if key in PUBLIC_ROUTES:
        return "public", PUBLIC_ROUTES[key]
    return "other", OTHER_REASONS.get(module, UNREVIEWED)


def handler_id(handler: Callable[..., Any]) -> str:
    target = handler if hasattr(handler, "__qualname__") else type(handler)
    return f"{target.__module__}:{target.__qualname__}"


def _walk(
    routes: list[Any], prefix: str = "", gates: tuple[Callable[..., Any], ...] = ()
) -> Iterator[tuple[Any, str, tuple[Callable[..., Any], ...]]]:
    """Every leaf route with its mounted path and the include-time ``Depends`` callables above it.

    An ``include_router`` call carries a prefix and dependencies. The prefix reaches every child;
    the dependencies reach only ``APIRoute`` and ``APIWebSocketRoute`` children, not plain Starlette
    routes or mounts. Both are accumulated down the nested includes.
    """
    from fastapi.routing import APIRoute, APIWebSocketRoute

    for route in routes:
        included = getattr(route, "original_router", None)
        if included is None:
            applies = isinstance(route, (APIRoute, APIWebSocketRoute))
            yield route, prefix + route.path, gates if applies else ()
            continue
        context = route.include_context
        yield from _walk(
            list(included.routes),
            prefix + context.prefix,
            gates + tuple(depends.dependency for depends in context.dependencies),
        )


def _methods(route: Any) -> list[str]:
    declared = getattr(route, "methods", None)
    if declared is None:
        return [MOUNT] if hasattr(route, "app") and not hasattr(route, "endpoint") else [WEBSOCKET]
    return sorted(m for m in declared if m != "HEAD" or "GET" not in declared)


def build_app(*, bundle: bool = True, bind_host: str = "127.0.0.1") -> Any:
    """``create_app()`` with only the collaboration extension, plus the account router.

    ``bundle`` says whether the static SPA bundle exists; ``bind_host`` decides the host MCP mount.
    """
    pinned = {"PODCAST_EXTENSIONS": "collaboration", "PODCAST_GUI_OPENAPI": "1"}
    previous = {name: os.environ.get(name) for name in pinned}
    os.environ.update(pinned)
    try:
        from podcast_mcp.gui.routes import auth
        from podcast_mcp.gui.server import create_app

        with tempfile.TemporaryDirectory() as raw:
            static = Path(raw)
            if bundle:
                (static / "assets").mkdir()
                (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
            app = create_app(static_dir=static, bind_host=bind_host)
        app.include_router(auth.router)
        return app
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def variant_apps() -> Iterator[Any]:
    """The configurations the inventory is the union of: bundle present or absent, and a
    loopback or a LAN bind (only loopback mounts the host MCP transport)."""
    yield build_app()
    yield build_app(bundle=False)
    yield build_app(bind_host="0.0.0.0")


def _rows_of(app: Any) -> dict[tuple[str, str], dict[str, Any]]:
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for route, path, gates in _walk(list(app.routes)):
        handler: Callable[..., Any] = getattr(route, "endpoint", None) or route.app
        dependencies = [*dependency_callables(route), *gates]
        for method in _methods(route):
            key = (method, path)
            if key in rows:
                raise ValueError(f"{method} {path} is mounted twice")
            gate, reason = gate_of(method, path, handler, dependencies)
            row: dict[str, Any] = {
                "method": method,
                "path": path,
                "gate": gate,
                "handler": handler_id(handler),
            }
            if HOST_CALL in referenced_names(handler):
                row["host_direct"] = True
            if reason is not None:
                row["reason"] = reason
            rows[key] = row
    return rows


def live_rows(apps: Iterable[Any] | None = None) -> list[dict[str, Any]]:
    """One row per ``(method, path)`` mounted in any variant, sorted by path then method."""
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for app in variant_apps() if apps is None else apps:
        for key, row in _rows_of(app).items():
            rows.setdefault(key, row)
    return [rows[key] for key in sorted(rows, key=_by_path)]


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
    for method, path in sorted(mounted.keys() - recorded.keys(), key=_by_path):
        yield f"{method} {path} is mounted but has no row in the inventory. {WRITE_HINT}"
    for method, path in sorted(recorded.keys() - mounted.keys(), key=_by_path):
        yield f"{method} {path} has a row but no mounted route. {WRITE_HINT}"
    for key in sorted(mounted.keys() & recorded.keys(), key=_by_path):
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
            "only shrink: gate the route with a router-level dependency, "
            "include_router(router, dependencies=[Depends(host_gate)]), instead of calling "
            "require_host in the handler or raising the baseline."
        )
    elif direct < baseline:
        yield (
            f"{direct} handlers call require_host directly, baseline is {baseline}. "
            f"Lower it. {WRITE_HINT}"
        )


def base_baseline(ref: str) -> int | None:
    """``host_direct_baseline`` recorded at ``ref``, or None when the ref has no inventory yet."""
    shown = subprocess.run(
        ["git", "show", f"{ref}:{CONTRACT.relative_to(ROOT).as_posix()}"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    return int(json.loads(shown.stdout)["host_direct_baseline"]) if shown.returncode == 0 else None


def growth(base: int | None, direct: int, baseline: int) -> Iterator[str]:
    """Messages when the ratchet or the live count is above the baseline recorded at the base."""
    if base is None:
        return
    if baseline > base:
        yield f"host_direct_baseline is {baseline}, the base records {base}. It may only shrink."
    if direct > base:
        yield f"{direct} handlers call require_host directly, the base allows {base}."


def render(live: list[dict[str, Any]], baseline: int) -> str:
    payload = {
        "api_version": API_VERSION,
        "host_direct_baseline": baseline,
        "routes": live,
    }
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="fail on any difference (default)")
    mode.add_argument("--write", action="store_true", help="regenerate the contract")
    parser.add_argument("--base", help="git ref whose recorded baseline the count may not exceed")
    args = parser.parse_args(argv)
    live = live_rows()
    contract = load_contract()
    base = base_baseline(args.base) if args.base else None
    if args.write:
        direct = host_direct_count(live)
        ceilings = [int(contract["host_direct_baseline"])] if CONTRACT.is_file() else []
        baseline = min([direct, *ceilings, *([] if base is None else [base])])
        CONTRACT.write_text(render(live, baseline), encoding="utf-8")
        print(f"wrote {CONTRACT.relative_to(ROOT)}: {len(live)} routes, baseline {baseline}")
        if direct > baseline:
            print(
                f"{direct} handlers call require_host directly; the baseline stays at {baseline} "
                "and may not be raised.",
                file=sys.stderr,
            )
            return 1
        unreviewed = [r for r in live if r.get("reason") == UNREVIEWED]
        for row in unreviewed:
            print(
                f"{row['method']} {row['path']} was written to the inventory, {UNREVIEWED}.",
                file=sys.stderr,
            )
        return 1 if unreviewed else 0
    found = [
        *problems(live, contract),
        *growth(base, host_direct_count(live), int(contract["host_direct_baseline"])),
    ]
    if CONTRACT.is_file() and render(live, int(contract["host_direct_baseline"])) != (
        CONTRACT.read_text(encoding="utf-8")
    ):
        found.append(f"{CONTRACT.relative_to(ROOT)} is not the generated form. {WRITE_HINT}")
    for message in found:
        print(message, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
