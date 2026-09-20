#!/usr/bin/env python3
"""Discover long-running operations and report progress compliance.

Default mode is warn (exit 0). Set PODCAST_PROGRESS_COMPLIANCE=error to fail CI
when an operation is unwrapped or mute without an approved exemption or richness
registry entry.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXEMPTIONS = ROOT / "contracts" / "progress-exemptions.json"
RICHNESS = ROOT / "contracts" / "progress-richness.json"
SCHEMA = ROOT / "schemas" / "progress-exemptions.schema.json"
RICH_SCHEMA = ROOT / "schemas" / "progress-richness.schema.json"
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))


def _mode() -> str:
    raw = os.environ.get("PODCAST_PROGRESS_COMPLIANCE", "warn").strip().lower()
    return "error" if raw == "error" else "warn"


def _load_exemptions() -> dict[str, dict[str, Any]]:
    data = json.loads(EXEMPTIONS.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    # Lightweight required-field check (avoid jsonschema dep).
    if data.get("api_version") != schema["properties"]["api_version"]["const"]:
        raise SystemExit("progress-exemptions: api_version must be 1")
    out: dict[str, dict[str, Any]] = {}
    for row in data.get("exemptions", []):
        for key in ("id", "kind", "reason", "approved_by", "date"):
            if not row.get(key):
                raise SystemExit(f"progress-exemptions: missing {key} on {row!r}")
        if row["kind"] not in ("none", "minimal"):
            raise SystemExit(f"progress-exemptions: bad kind on {row['id']}")
        out[str(row["id"])] = row
    return out


def _load_richness() -> set[str]:
    data = json.loads(RICHNESS.read_text(encoding="utf-8"))
    schema = json.loads(RICH_SCHEMA.read_text(encoding="utf-8"))
    if data.get("api_version") != schema["properties"]["api_version"]["const"]:
        raise SystemExit("progress-richness: api_version must be 1")
    rich = {str(x) for x in data.get("rich", []) if str(x).strip()}
    return rich


def _mcp_tools() -> set[str]:
    from mcp_tool_discovery import discover_mcp_tool_names

    return discover_mcp_tool_names()


def _cli_commands() -> set[str]:
    from podcast_mcp.cli.main import app

    names: set[str] = set()

    def walk(typer_app, prefix: str = "") -> None:
        for cmd in getattr(typer_app, "registered_commands", []) or []:
            name = getattr(cmd, "name", None)
            if not name:
                cb = getattr(cmd, "callback", None)
                name = getattr(cb, "__name__", None)
            if name:
                names.add(f"{prefix}{name}" if prefix else str(name))
        for group in getattr(typer_app, "registered_groups", []) or []:
            gname = getattr(group, "name", None) or ""
            inner = getattr(group, "typer_instance", None)
            if inner is None:
                continue
            next_prefix = f"{prefix}{gname}." if gname else prefix
            walk(inner, next_prefix)

    walk(app)
    return names


def _pipeline_steps() -> set[str]:
    from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES

    return set(ORDERED_STEP_NAMES)


def _guest_tools() -> set[str]:
    from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS

    return set(TOOL_HANDLERS)


def _gui_jobs() -> set[str]:
    return {"pipeline", "render_preview", "bootstrap", "agent", "bounce", "export", "diagnostics"}


def main() -> int:
    mode = _mode()
    exemptions = _load_exemptions()
    rich = _load_richness()
    discovered: dict[str, str] = {}
    for oid in sorted(_mcp_tools()):
        discovered[oid] = "mcp"
    for oid in sorted(_cli_commands()):
        discovered[oid] = "cli"
    for oid in sorted(_pipeline_steps()):
        discovered[oid] = "pipeline"
    for oid in sorted(_guest_tools()):
        discovered[oid] = "guest"
    for oid in sorted(_gui_jobs()):
        discovered[oid] = "gui"

    warnings: list[str] = []
    errors: list[str] = []

    for oid, surface in discovered.items():
        if oid in exemptions:
            continue
        if oid in rich:
            continue
        warnings.append(
            f"{surface}:{oid}: no approved exemption and not marked rich — "
            f"add set_phase/advance via progress_task, mark in "
            f"contracts/progress-richness.json, or a user-approved exemption"
        )

    for oid in exemptions:
        if oid not in discovered:
            errors.append(f"exemption for unknown id: {oid}")
    for oid in rich:
        if oid not in discovered:
            errors.append(f"richness for unknown id: {oid}")

    lines = list(warnings)
    for line in errors:
        print(f"ERROR: {line}", file=sys.stderr)
    for line in lines:
        tag = "ERROR" if mode == "error" else "WARN"
        print(f"{tag}: {line}", file=sys.stderr)

    print(
        f"progress-check: {len(discovered)} operations, "
        f"{len(exemptions)} exemptions, {len(rich)} rich, "
        f"{len(warnings)} mute/unexempted, "
        f"{len(errors)} dead ids (mode={mode})"
    )
    if errors:
        return 1
    if mode == "error" and warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
