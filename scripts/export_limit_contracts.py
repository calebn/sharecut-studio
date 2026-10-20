#!/usr/bin/env python3
"""Generate the GUI's edit-geometry constants from the ``constants`` blocks in contracts/."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from biome_format import biome_format_ts

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "gui" / "web" / "src" / "edit" / "limits.generated.ts"

# (contract file, key under "constants", exported TS constant)
EXPORTS: tuple[tuple[str, str, str], ...] = (
    ("trim-edge-limits.json", "min_clip_span_sec", "MIN_EDGE_SPAN_SEC"),
    ("trim-edge-limits.json", "time_eps_sec", "TIME_EPS_SEC"),
    ("join-length-limits.json", "join_gap_tolerance_sec", "JOIN_GAP_TOLERANCE_SEC"),
    ("ripple-scope.json", "edge_eps_sec", "RIPPLE_EDGE_EPS_SEC"),
)


def generate() -> str:
    lines = ["/** Generated from the constants in contracts/*.json — do not edit by hand. */", ""]
    for contract, key, name in EXPORTS:
        data = json.loads((ROOT / "contracts" / contract).read_text(encoding="utf-8"))
        lines.append(f"/** `{contract}` `constants.{key}` */")
        lines.append(f"export const {name} = {data['constants'][key]!r};")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = biome_format_ts(generate())
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"edit limit constants out of date: {OUT}", flush=True)
            print("Run: uv run python scripts/export_limit_contracts.py", flush=True)
            return 1
        print("edit limit constants up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
