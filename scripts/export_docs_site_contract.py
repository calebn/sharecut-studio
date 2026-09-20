#!/usr/bin/env python3
"""Export / check docs-site contract artifacts beyond the document-command schema.

Writes:
  - share-http route table (markers in docs-site/pages/share-http.md)
  - remote-mcp tool matrix (markers in docs-site/pages/remote-mcp.md)
  - docs-site/schemas/guest-share.openapi.json (guest HTTP paths only)

Usage:
  python scripts/export_docs_site_contract.py
  python scripts/export_docs_site_contract.py --check
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SHARE_PAGE = ROOT / "docs-site" / "pages" / "share-http.md"
REMOTE_PAGE = ROOT / "docs-site" / "pages" / "remote-mcp.md"
GUEST_OPENAPI = ROOT / "docs-site" / "schemas" / "guest-share.openapi.json"

SHARE_BEGIN = "<!-- share-http-routes:generated -->"
SHARE_END = "<!-- /share-http-routes:generated -->"
REMOTE_BEGIN = "<!-- remote-mcp-tools:generated -->"
REMOTE_END = "<!-- /remote-mcp-tools:generated -->"

# Curated notes keyed by (METHOD, path) after normalizing {token} paths.
# Keep in sync with gui/routes/review_share.py and gui/routes/record_share.py
# (+ remote MCP mounts). Every /api/rec/ and /api/review/ HTTP or WS route
# must have a note — schema-check fails without one.
_ROUTE_NOTES: dict[tuple[str, str], tuple[str, str]] = {
    ("GET", "/api/review/{token}/project"): ("view", "Legacy ReviewApp project JSON"),
    ("GET", "/api/review/{token}/features"): ("view", "Extension / feature manifest"),
    ("GET", "/api/review/{token}/audio"): ("play", "ReviewApp frozen mix"),
    ("GET", "/api/review/{token}/daw/project"): ("view", "Sanitized ProjectView (no host paths)"),
    ("GET", "/api/review/{token}/daw/meta"): ("view", "mtime/size for poll reload"),
    ("GET", "/api/review/{token}/daw/peaks/{track_id}"): ("view", "Uint8 overview waveform"),
    ("GET", "/api/review/{token}/daw/waveform-snap"): (
        "suggest or edit",
        "Windowed snap ticks; view-only gets wash only",
    ),
    ("GET", "/api/review/{token}/daw/audio"): (
        "play",
        "Whitelist: premix, stem, processed, review",
    ),
    ("GET", "/api/review/{token}/daw/pending-preview"): (
        "play + view",
        "Listen-first Current/Suggested/A/B WAV (not host speakers)",
    ),
    ("GET", "/api/review/{token}/daw/pending-preview-image"): (
        "play + view",
        "Waveform or spectrogram of the listen-first extract",
    ),
    ("GET", "/api/review/{token}/daw/audition-context"): (
        "play + view",
        "Windowed captions + PNG URLs (agent hear channel v1)",
    ),
    ("GET", "/api/review/{token}/daw/audition-context-image"): (
        "play + view",
        "Waveform or spectrogram of a timeline window",
    ),
    ("GET", "/api/review/{token}/daw/proxy/manifest"): ("play", "Proxy chunk manifest"),
    ("GET", "/api/review/{token}/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}"): (
        "play",
        "Content-addressed proxy media",
    ),
    ("POST", "/api/review/{token}/daw/render-preview"): (
        "edit",
        "Rebuild stems/premix (opt-in PODCAST_GUEST_RENDER)",
    ),
    ("POST", "/api/review/{token}/daw/document/command"): (
        "view + command allowlist",
        "Typed body — see Document commands",
    ),
    ("POST", "/api/review/{token}/daw/media/upload"): ("edit", "Chunked audio into host raw/"),
    ("POST", "/api/review/{token}/comments"): ("comment", "Timeline comment (REST)"),
    ("POST", "/api/review/{token}/comments/{comment_id}/replies"): ("reply", "Reply (REST)"),
    ("POST", "/api/review/{token}/comments/{comment_id}/actions/{action_id}/done"): (
        "action",
        "HTTP twin for MCP guest_set_action_done",
    ),
    ("WEBSOCKET", "/api/review/{token}/daw/ws"): (
        "view",
        "Receive-only session+document fanout (progress plane too)",
    ),
    ("WEBSOCKET", "/api/review/{token}/progress/ws"): (
        "token",
        "Guest-initiated progress plane for ReviewApp (no view cap, no host paths)",
    ),
    ("GET", "/api/rec/{token}/bootstrap"): (
        "kind=record",
        "Record lobby bootstrap JSON (no review mix)",
    ),
    ("GET", "/api/rec/{token}/features"): (
        "kind=record",
        "Extension / feature manifest",
    ),
    ("GET", "/api/rec/{token}/upload"): (
        "join",
        "Record keeper chunk ACK status (own participant)",
    ),
    ("POST", "/api/rec/{token}/upload"): (
        "join",
        "Record keeper chunk upload (sha256 + resume)",
    ),
    ("DELETE", "/api/rec/{token}/upload"): (
        "join",
        "Revoke an ACK'd room-tone bed (kind=room_tone)",
    ),
    ("WEBSOCKET", "/api/rec/{token}/ws"): (
        "monitor",
        "Record room / live comments / WebRTC signal",
    ),
}

# Named guest MCP twin, or ``http-only:`` reason (Sharecut Studio-only / no named MCP).
_ROUTE_AGENT: dict[tuple[str, str], str] = {
    ("GET", "/api/review/{token}/project"): "guest_get_review_summary",
    ("GET", "/api/review/{token}/features"): "http-only: extension manifest for Sharecut Studio",
    ("GET", "/api/review/{token}/audio"): "guest_audio_info",
    ("GET", "/api/review/{token}/daw/project"): "guest_get_project",
    ("GET", "/api/review/{token}/daw/meta"): "http-only: poll mtime for Sharecut Studio reload",
    ("GET", "/api/review/{token}/daw/peaks/{track_id}"): (
        "http-only: Sharecut Studio peaks; agents use guest_audition_context"
    ),
    ("GET", "/api/review/{token}/daw/waveform-snap"): (
        "http-only: Sharecut Studio snap ticks; not a named MCP tool"
    ),
    ("GET", "/api/review/{token}/daw/audio"): "guest_audio_info",
    ("GET", "/api/review/{token}/daw/pending-preview"): "guest_pending_preview",
    ("GET", "/api/review/{token}/daw/pending-preview-image"): "guest_pending_preview",
    ("GET", "/api/review/{token}/daw/audition-context"): "guest_audition_context",
    ("GET", "/api/review/{token}/daw/audition-context-image"): "guest_audition_context",
    ("GET", "/api/review/{token}/daw/proxy/manifest"): (
        "http-only: Sharecut Studio proxy chunks; not a named MCP tool"
    ),
    ("GET", "/api/review/{token}/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}"): (
        "http-only: Sharecut Studio proxy chunks; not a named MCP tool"
    ),
    ("POST", "/api/review/{token}/daw/render-preview"): "guest_render_preview",
    ("POST", "/api/review/{token}/daw/document/command"): "guest_submit_document_command",
    ("POST", "/api/review/{token}/daw/media/upload"): "guest_upload_media",
    ("POST", "/api/review/{token}/comments"): "guest_add_comment",
    ("POST", "/api/review/{token}/comments/{comment_id}/replies"): "guest_add_reply",
    ("POST", "/api/review/{token}/comments/{comment_id}/actions/{action_id}/done"): (
        "guest_set_action_done"
    ),
    ("WEBSOCKET", "/api/review/{token}/daw/ws"): (
        "http-only: playhead/presence; agents do not need guest session WS"
    ),
    ("WEBSOCKET", "/api/review/{token}/progress/ws"): (
        "http-only: guest progress chip; MCP uses notifications/progress when progressToken is set"
    ),
    ("GET", "/api/rec/{token}/bootstrap"): (
        "http-only: record lobby JSON; no MCP until later recording PRs"
    ),
    ("GET", "/api/rec/{token}/features"): "http-only: extension manifest for record shell",
    ("GET", "/api/rec/{token}/upload"): "http-only: record keeper upload status",
    ("POST", "/api/rec/{token}/upload"): "http-only: record keeper chunk upload; no MCP yet",
    ("DELETE", "/api/rec/{token}/upload"): ("http-only: revoke ACK'd room-tone bed; no MCP yet"),
    ("WEBSOCKET", "/api/rec/{token}/ws"): (
        "http-only: record room / live comments / WebRTC signal; no MCP by design "
        "(docs/host-online-relay.md § record caps)"
    ),
}

# Guest MCP tools that wrap GET daw/project or live session roster (no extra HTTP).
_PROJECT_VIEW_TOOLS = frozenset(
    {
        "guest_list_clips",
        "guest_list_pending_edits",
        "guest_list_applied_edits",
        "guest_search_transcript",
        "guest_render_status",
        "guest_list_comments",
        "guest_get_session_presence",
    }
)


def _is_guest_surface_path(path: str) -> bool:
    return (
        "/api/review/{token}" in path
        or "/api/rec/{token}" in path
        or path.startswith("/mcp/{token}")
    )


def _is_share_http_ws_path(path: str) -> bool:
    """Review and record guest HTTP/WS surfaces that require curated notes."""
    return "/api/review/{token}" in path or "/api/rec/{token}" in path


def _share_http_ws_keys(routes: list[tuple[str, str]]) -> set[tuple[str, str]]:
    return {(method, path) for method, path in routes if _is_share_http_ws_path(path)}


def _share_route_note_errors(seen: set[tuple[str, str]]) -> list[str]:
    """Fail when any /api/rec/ or /api/review/ route (HTTP or WS) lacks a note."""
    errors: list[str] = []
    missing = sorted(seen - set(_ROUTE_NOTES))
    if missing:
        detail = ", ".join(f"{m} {p}" for m, p in missing)
        errors.append(f"share routes missing curated notes: {detail}")
    stale = sorted(set(_ROUTE_NOTES) - seen)
    if stale:
        detail = ", ".join(f"{m} {p}" for m, p in stale)
        errors.append(f"curated share route notes for missing routes: {detail}")
    return errors


def check_share_http_mcp_parity() -> list[str]:
    """Every share HTTP/WS route has a guest MCP twin or an explicit http-only note."""
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
    from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS

    errors: list[str] = []
    if set(_ROUTE_AGENT) != set(_ROUTE_NOTES):
        missing = sorted(set(_ROUTE_NOTES) - set(_ROUTE_AGENT))
        extra = sorted(set(_ROUTE_AGENT) - set(_ROUTE_NOTES))
        if missing:
            errors.append(f"share routes missing _ROUTE_AGENT: {missing}")
        if extra:
            errors.append(f"_ROUTE_AGENT for unknown routes: {extra}")

    errors.extend(_share_route_note_errors(_share_http_ws_keys(_iter_app_routes())))

    named = {v for v in _ROUTE_AGENT.values() if not v.startswith("http-only:")}
    covered = named | _PROJECT_VIEW_TOOLS
    for tool in sorted(ALL_GUEST_TOOLS):
        if tool not in covered:
            errors.append(f"guest MCP tool has no HTTP twin note: {tool}")
    for tool in sorted(named):
        if tool not in ALL_GUEST_TOOLS:
            errors.append(f"_ROUTE_AGENT names unknown guest tool: {tool}")
    for tool in sorted(ALL_GUEST_TOOLS):
        if tool not in TOOL_HANDLERS:
            errors.append(f"guest tool missing handler: {tool}")
    return errors


def _apply_markers(page: str, begin: str, end: str, generated: str) -> str:
    if begin not in page or end not in page:
        raise SystemExit(f"missing markers {begin!r} .. {end!r}")
    pattern = re.compile(re.escape(begin) + r"[\s\S]*?" + re.escape(end), re.MULTILINE)
    return pattern.sub(generated.strip(), page)


def _iter_websocket_paths(routes: list[Any]) -> list[str]:
    """Discover FastAPI ``APIWebSocketRoute`` paths, including included routers."""
    from fastapi.routing import APIWebSocketRoute

    paths: list[str] = []
    seen: set[int] = set()

    def walk(route_list: list[Any]) -> None:
        for route in route_list:
            ident = id(route)
            if ident in seen:
                continue
            seen.add(ident)
            if isinstance(route, APIWebSocketRoute):
                paths.append(route.path)
                continue
            included = getattr(route, "original_router", None)
            if included is not None:
                walk(list(included.routes))
                continue
            nested = getattr(route, "routes", None)
            if nested:
                walk(list(nested))

    walk(routes)
    return paths


def _iter_app_routes() -> list[tuple[str, str]]:
    """Return (METHOD, path) pairs for guest share surfaces (flattened)."""
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.gui.server import create_app

    app = create_app()
    rows: list[tuple[str, str]] = []
    openapi_paths = app.openapi().get("paths") or {}
    for path, item in openapi_paths.items():
        if not _is_guest_surface_path(path):
            continue
        for method in item:
            if method in {"get", "post", "put", "patch", "delete"}:
                rows.append((method.upper(), path))
    # WebSockets are not in OpenAPI; walk FastAPI APIWebSocketRoute entries
    # (including routers nested as FastAPI ``_IncludedRouter``).
    for path in _iter_websocket_paths(list(app.routes)):
        if not _is_guest_surface_path(path):
            continue
        rows.append(("WEBSOCKET", path))
    return sorted(set(rows), key=lambda r: (r[1], r[0]))


def _route_rows() -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for method, path in _iter_app_routes():
        if not _is_share_http_ws_path(path):
            continue
        key = (method, path)
        seen.add(key)
        caps, notes = _ROUTE_NOTES.get(
            key, ("(see code)", "Document me in export_docs_site_contract.py")
        )
        short = path.replace("/api/review/{token}", "…").replace("/api/rec/{token}", "…rec")
        rows.append((method, short, caps, notes))
    note_errors = _share_route_note_errors(seen)
    if note_errors:
        raise SystemExit("; ".join(note_errors))
    rows.sort(key=lambda r: (r[1], r[0]))
    return rows


def _render_share_routes() -> str:
    lines = [
        SHARE_BEGIN,
        "",
        "> **Auto-generated** from FastAPI guest routes + curated cap notes. "
        "Run `make schema-export`.",
        "",
        "### Guest Sharecut Studio / review routes",
        "",
        "| Method | Route | Cap | Notes |",
        "|--------|-------|-----|-------|",
    ]
    for method, short, caps, notes in _route_rows():
        lines.append(f"| `{method}` | `{short}` | `{caps}` | {notes} |")
    lines.extend(["", SHARE_END, ""])
    return "\n".join(lines)


def _render_remote_tools() -> str:
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.services.remote_mcp import allowlist as al

    def fmt(tools: frozenset[str]) -> str:
        return ", ".join(f"`{t}`" for t in sorted(tools))

    lines = [
        REMOTE_BEGIN,
        "",
        "> **Auto-generated** from `services/remote_mcp/allowlist.py`. Run `make schema-export`.",
        "",
        "### Tools by capability",
        "",
        "| Caps | Tools |",
        "|------|-------|",
        f"| `play` | {fmt(al.PLAY_TOOLS)} |",
        f"| `play` + `view` | {fmt(al.PLAY_AND_VIEW_TOOLS)} |",
        f"| `+view` | {fmt(al.VIEW_TOOLS - al.PLAY_TOOLS)} |",
        f"| `+comment` / `reply` | {fmt(al.COMMENT_TOOLS - al.PLAY_TOOLS)} |",
        f"| `+action` | {fmt(al.ACTION_TOOLS)} |",
        f"| `+suggest` / `+edit` | {fmt(al.SUGGEST_TOOLS)} |",
        f"| `+edit` only | {fmt(al.EDIT_TOOLS - al.SUGGEST_TOOLS)} |",
        "",
        REMOTE_END,
        "",
    ]
    return "\n".join(lines)


def _strip_unstable(obj: Any) -> Any:
    """Drop FastAPI fields that can churn between openapi() calls."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for key, value in obj.items():
            if key in {"operationId", "summary"}:
                continue
            if key == "title" and isinstance(value, str) and value.startswith("Response "):
                continue
            out[key] = _strip_unstable(value)
        return out
    if isinstance(obj, list):
        return [_strip_unstable(x) for x in obj]
    return obj


def _component_refs(obj: Any) -> set[str]:
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/components/"):
                found.add(ref)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(obj)
    return found


def _parse_component_ref(ref: str) -> tuple[str, str] | None:
    if not ref.startswith("#/components/"):
        return None
    rest = ref[len("#/components/") :]
    section, _, name = rest.partition("/")
    if not section or not name:
        return None
    return section, name


def _prune_openapi_components(components: dict[str, Any], roots: Any) -> dict[str, Any]:
    """Keep only component objects reachable via $ref from guest paths."""
    pending = _component_refs(roots)
    used: dict[str, set[str]] = {}
    seen: set[str] = set()
    while pending:
        ref = pending.pop()
        if ref in seen:
            continue
        seen.add(ref)
        parsed = _parse_component_ref(ref)
        if parsed is None:
            continue
        section, name = parsed
        bucket = components.get(section)
        if not isinstance(bucket, dict) or name not in bucket:
            continue
        used.setdefault(section, set()).add(name)
        pending.update(_component_refs(bucket[name]) - seen)
    pruned: dict[str, Any] = {}
    for section, bucket in components.items():
        if not isinstance(bucket, dict):
            pruned[section] = bucket
            continue
        names = used.get(section)
        if names:
            pruned[section] = {key: bucket[key] for key in bucket if key in names}
    return pruned


def _guest_openapi() -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.gui.server import create_app

    app = create_app()
    full = app.openapi()
    paths = {
        path: item
        for path, item in (full.get("paths") or {}).items()
        if _is_guest_surface_path(path)
    }
    components = _prune_openapi_components(full.get("components") or {}, paths)
    return _strip_unstable(
        {
            "openapi": full.get("openapi", "3.1.0"),
            "info": {
                "title": "Podcast MCP guest share HTTP",
                "version": "alpha",
                "description": (
                    "Static export of guest share / remote MCP HTTP paths from the host GUI app. "
                    "Not served on the public relay. Alpha — may change without notice. "
                    "Document commands: schemas/document-commands.schema.json"
                ),
            },
            "paths": paths,
            "components": components,
        }
    )


def _dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def _write() -> None:
    share = SHARE_PAGE.read_text(encoding="utf-8")
    SHARE_PAGE.write_text(
        _apply_markers(share, SHARE_BEGIN, SHARE_END, _render_share_routes()), encoding="utf-8"
    )
    remote = REMOTE_PAGE.read_text(encoding="utf-8")
    REMOTE_PAGE.write_text(
        _apply_markers(remote, REMOTE_BEGIN, REMOTE_END, _render_remote_tools()),
        encoding="utf-8",
    )
    GUEST_OPENAPI.parent.mkdir(parents=True, exist_ok=True)
    GUEST_OPENAPI.write_text(_dumps(_guest_openapi()), encoding="utf-8")
    print(f"wrote {SHARE_PAGE}")
    print(f"wrote {REMOTE_PAGE}")
    print(f"wrote {GUEST_OPENAPI}")


def _check() -> list[str]:
    errors: list[str] = []
    share = SHARE_PAGE.read_text(encoding="utf-8")
    expected_share = _apply_markers(share, SHARE_BEGIN, SHARE_END, _render_share_routes())
    if share != expected_share:
        errors.append(f"{SHARE_PAGE} route table is stale")
    remote = REMOTE_PAGE.read_text(encoding="utf-8")
    expected_remote = _apply_markers(remote, REMOTE_BEGIN, REMOTE_END, _render_remote_tools())
    if remote != expected_remote:
        errors.append(f"{REMOTE_PAGE} tool matrix is stale")
    expected_oa = _dumps(_guest_openapi())
    if not GUEST_OPENAPI.is_file():
        errors.append(f"missing {GUEST_OPENAPI}")
    elif GUEST_OPENAPI.read_text(encoding="utf-8") != expected_oa:
        errors.append(f"{GUEST_OPENAPI} is stale")
    errors.extend(check_share_http_mcp_parity())
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        errors = _check()
        if errors:
            for err in errors:
                print(err, file=sys.stderr)
            print("run: make schema-export", file=sys.stderr)
            return 1
        print(f"{SHARE_PAGE} OK")
        print(f"{REMOTE_PAGE} OK")
        print(f"{GUEST_OPENAPI} OK")
        return 0
    _write()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
