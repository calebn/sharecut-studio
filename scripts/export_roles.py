#!/usr/bin/env python3
"""Generate gui/web/src/types/roles.generated.ts from share_capabilities.py.

The output is emitted already Biome-formatted (80 columns, double quotes, trailing
commas), so the check needs no node_modules and runs in the pytest job. Biome's
format check over gui/web/src/types in the frontend suite still gates the layout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "gui" / "web" / "src" / "types" / "roles.generated.ts"
SOURCE = "podcast_mcp/services/collaboration/share_capabilities.py"
LINE_WIDTH = 80

_SRC = str(ROOT / "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

HEADER = f"""\
/**
 * Generated from {SOURCE} by scripts/export_roles.py. Do not edit by hand.
 *
 * `CAPABILITIES` are the review and record capability bits. The host is not a
 * role here: it holds every capability, and the document-command capabilities
 * are not in these tables. `roleHolds` is a fixed template, not derived from the
 * source: it matches the listed capabilities exactly and applies no aliases
 * (view => play, comment => reply). That agrees with the server because every
 * table lists both halves of each alias pair; tests/test_export_roles.py pins it.
 */
"""

ROLE_HOLDS_TS = """\
export function roleHolds(role: ReviewRole, cap: Capability): boolean {
  return REVIEW_ROLE_CAPABILITIES[role].includes(cap);
}
"""


def _model() -> dict[str, Any]:
    from podcast_mcp.services.collaboration import share_capabilities as sc

    capabilities = list(sc.ALL_CAPABILITIES)
    review = {role.value: list(caps) for role, caps in sc.REVIEW_ROLE_CAPABILITIES.items()}
    record = {role: list(caps) for role, caps in sc.RECORD_ROLE_PRESETS.items()}
    overlap = sorted(set(review) & set(record))
    stray = sorted(
        {cap for caps in (*review.values(), *record.values()) for cap in caps} - set(capabilities)
    )
    if overlap or stray:
        raise ValueError(
            f"export_roles: roles in both tables {overlap}; "
            f"capabilities outside ALL_CAPABILITIES {stray}"
        )
    return {"capabilities": capabilities, "review": review, "record": record}


def _array(items: list[str]) -> str:
    return "[" + ", ".join(json.dumps(item) for item in items) + "]"


def _wrap(head: str, items: list[str], tail: str, indent: str = "") -> str:
    one_line = f"{indent}{head}{_array(items)}{tail}"
    if len(one_line) <= LINE_WIDTH:
        return one_line + "\n"
    inner = "".join(f"{indent}  {json.dumps(item)},\n" for item in items)
    return f"{indent}{head}[\n{inner}{indent}]{tail}\n"


def _table(name: str, role_type: str, table: dict[str, list[str]]) -> str:
    rows = "".join(_wrap(f"{role}: ", caps, ",", "  ") for role, caps in table.items())
    return f"export const {name}: CapabilityTable<{role_type}> = {{\n{rows}}};\n"


def generate(model: dict[str, Any] | None = None) -> str:
    m = model or _model()
    sections = [
        HEADER,
        _wrap("export const CAPABILITIES = ", m["capabilities"], " as const;")
        + "export type Capability = (typeof CAPABILITIES)[number];\n",
        _wrap("export const REVIEW_ROLE_IDS = ", list(m["review"]), " as const;")
        + "export type ReviewRole = (typeof REVIEW_ROLE_IDS)[number];\n",
        _wrap("export const RECORD_ROLE_IDS = ", list(m["record"]), " as const;")
        + "export type RecordPresetRole = (typeof RECORD_ROLE_IDS)[number];\n",
        "type CapabilityTable<Role extends string> = Readonly<\n"
        "  Record<Role, readonly Capability[]>\n"
        ">;\n",
        _table("REVIEW_ROLE_CAPABILITIES", "ReviewRole", m["review"]),
        _table("RECORD_ROLE_CAPABILITIES", "RecordPresetRole", m["record"]),
        ROLE_HOLDS_TS,
    ]
    return "\n".join(sections)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = generate()
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"roles copy out of date: {OUT}", flush=True)
            print("Run: uv run python scripts/export_roles.py", flush=True)
            return 1
        print("roles copy up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
