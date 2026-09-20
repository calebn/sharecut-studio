#!/usr/bin/env python3
"""Generate gui/web/src/capabilities/copy.ts from capabilities.manifest.json."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from biome_format import biome_format_ts

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contracts" / "capabilities.manifest.json"
OUT = ROOT / "gui" / "web" / "src" / "capabilities" / "copy.ts"


def generate() -> str:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    by_id: dict[str, dict[str, str | bool]] = {}
    by_gui: dict[str, str] = {}
    for cap in data.get("capabilities") or []:
        cid = str(cap["id"])
        entry: dict[str, str | bool] = {
            "label": str(cap.get("label") or cid),
        }
        if cap.get("tooltip"):
            entry["tooltip"] = str(cap["tooltip"])
        if cap.get("tooltip_pressed"):
            entry["tooltip_pressed"] = str(cap["tooltip_pressed"])
        if cap.get("toggle"):
            entry["toggle"] = True
        by_id[cid] = entry
        for gui in (cap.get("surfaces") or {}).get("gui") or []:
            by_gui[str(gui)] = cid

    lines = [
        "/** Generated from contracts/capabilities.manifest.json — do not edit by hand. */",
        "",
        "export type CapabilityCopy = {",
        "  label: string;",
        "  tooltip?: string;",
        "  tooltip_pressed?: string;",
        "  toggle?: boolean;",
        "};",
        "",
        "export const CAPABILITY_COPY: Record<string, CapabilityCopy> = "
        + json.dumps(by_id, indent=2, ensure_ascii=False)
        + ";",
        "",
        "export const GUI_SURFACE_TO_CAPABILITY: Record<string, string> = "
        + json.dumps(by_gui, indent=2, ensure_ascii=False)
        + ";",
        "",
        "export function capabilityTooltip(",
        "  idOrGui: string,",
        "  opts?: { pressed?: boolean },",
        "): string {",
        "  const id = CAPABILITY_COPY[idOrGui] ? idOrGui : GUI_SURFACE_TO_CAPABILITY[idOrGui];",
        "  const row = id ? CAPABILITY_COPY[id] : undefined;",
        "  if (!row) return idOrGui;",
        "  if (opts?.pressed && row.tooltip_pressed) return row.tooltip_pressed;",
        "  return row.tooltip ?? row.label;",
        "}",
        "",
        "export function capabilityLabel(idOrGui: string): string {",
        "  const id = CAPABILITY_COPY[idOrGui] ? idOrGui : GUI_SURFACE_TO_CAPABILITY[idOrGui];",
        "  const row = id ? CAPABILITY_COPY[id] : undefined;",
        "  return row?.label ?? idOrGui;",
        "}",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = biome_format_ts(generate())
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"capabilities copy out of date: {OUT}", flush=True)
            print("Run: uv run python scripts/export_capabilities_copy.py", flush=True)
            return 1
        print("capabilities copy up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
