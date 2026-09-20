#!/usr/bin/env python3
"""Generate GUI zoom constants from contracts/timeline-zoom.json."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from biome_format import biome_format_ts

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "timeline-zoom.json"
OUT = ROOT / "gui" / "web" / "src" / "utils" / "timelineZoom.generated.ts"
BUNDLED = ROOT / "src" / "podcast_mcp" / "util" / "timeline-zoom.json"


def generate() -> str:
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    peaks = data["peaks"]
    min_z = data["min_zoom_px_per_sec"]
    max_z = data["max_zoom_px_per_sec"]
    step = data["zoom_step"]
    decode_hz = peaks["overview_decode_hz"]
    overview_bins = peaks["overview_bins_per_sec"]
    dpr_headroom = peaks["dpr_headroom"]
    paint_dpr_cap = peaks["paint_dpr_cap"]
    tile_sec = peaks["tile_sec"]
    edit_focus_sec = peaks["edit_focus_sec"]
    edit_focus_mult = peaks["edit_focus_multiplier"]
    finest = max_z * dpr_headroom
    overview_spp = max(1, round(decode_hz / overview_bins))
    return "\n".join(
        [
            "/** Generated from contracts/timeline-zoom.json — do not edit by hand. */",
            "",
            f"export const MIN_ZOOM_PX_PER_SEC = {min_z};",
            f"export const MAX_ZOOM_PX_PER_SEC = {max_z};",
            f"export const ZOOM_STEP = {step};",
            f"export const OVERVIEW_DECODE_HZ = {decode_hz};",
            f"export const OVERVIEW_BINS_PER_SEC = {overview_bins};",
            f"export const OVERVIEW_SAMPLES_PER_PIXEL = {overview_spp};",
            f"export const DPR_HEADROOM = {dpr_headroom};",
            f"export const PAINT_DPR_CAP = {paint_dpr_cap};",
            f"export const TILE_SEC = {tile_sec};",
            f"export const EDIT_FOCUS_SEC = {edit_focus_sec};",
            f"export const EDIT_FOCUS_MULTIPLIER = {edit_focus_mult};",
            f"export const FINEST_BINS_PER_SEC = {finest};",
            "",
            "export function paintDpr(devicePixelRatio: number): number {",
            "  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0",
            "    ? devicePixelRatio",
            "    : 1;",
            "  return Math.min(Math.max(dpr, 1), PAINT_DPR_CAP);",
            "}",
            "",
            "export function detailBinsPerSec(",
            "  zoomPxPerSec: number,",
            "  devicePixelRatio: number,",
            "): number {",
            "  return Math.min(zoomPxPerSec * paintDpr(devicePixelRatio), FINEST_BINS_PER_SEC);",
            "}",
            "",
            "export function editFocusBinsPerSec(",
            "  zoomPxPerSec: number,",
            "  devicePixelRatio: number,",
            "): number {",
            "  return Math.min(",
            "    detailBinsPerSec(zoomPxPerSec, devicePixelRatio) * EDIT_FOCUS_MULTIPLIER,",
            "    OVERVIEW_DECODE_HZ,",
            "  );",
            "}",
            "",
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = biome_format_ts(generate())
    bundled = CONTRACT.read_text(encoding="utf-8")
    if args.check:
        ok = True
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"timeline zoom copy out of date: {OUT}", flush=True)
            ok = False
        if not BUNDLED.exists() or BUNDLED.read_text(encoding="utf-8") != bundled:
            print(f"bundled timeline-zoom.json out of date: {BUNDLED}", flush=True)
            ok = False
        if not ok:
            print("Run: uv run python scripts/export_timeline_zoom.py", flush=True)
            return 1
        print("timeline zoom contract up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    BUNDLED.parent.mkdir(parents=True, exist_ok=True)
    BUNDLED.write_text(bundled, encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"wrote {BUNDLED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
