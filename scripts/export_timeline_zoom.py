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

# (contract key under "waveform", exported TS constant). paint_dpr_cap is
# emitted separately as PAINT_DPR_CAP (client-only; Python has no getter).
WAVEFORM_EXPORTS: tuple[tuple[str, str], ...] = (
    ("format_version", "WAVEFORM_FORMAT_VERSION"),
    ("base_samples_per_bin", "BASE_SAMPLES_PER_BIN"),
    ("level_factor", "LEVEL_FACTOR"),
    ("bins_per_data_tile", "BINS_PER_DATA_TILE"),
    ("max_tiles_per_request", "MAX_TILES_PER_REQUEST"),
    ("pcm_block_frames", "PCM_BLOCK_FRAMES"),
    ("render_tile_css_px", "RENDER_TILE_CSS_PX"),
    ("overscan_css_px", "OVERSCAN_CSS_PX"),
    ("min_clip_css_px", "MIN_CLIP_CSS_PX"),
    ("line_mode_max_samples_per_px", "LINE_MODE_MAX_SAMPLES_PER_PX"),
    ("quiet_amp", "QUIET_AMP"),
    ("quiet_min_duration_sec", "QUIET_MIN_DURATION_SEC"),
    ("quiet_wash_min_zoom_px_per_sec", "QUIET_WASH_MIN_ZOOM_PX_PER_SEC"),
)


def generate() -> str:
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    waveform = data["waveform"]
    min_z = data["min_zoom_px_per_sec"]
    max_z = data["max_zoom_px_per_sec"]
    max_content_px = data["max_content_px"]
    step = data["zoom_step"]
    return "\n".join(
        [
            "/** Generated from contracts/timeline-zoom.json — do not edit by hand. */",
            "",
            f"export const MIN_ZOOM_PX_PER_SEC = {min_z};",
            f"export const MAX_ZOOM_PX_PER_SEC = {max_z};",
            f"export const MAX_CONTENT_PX = {max_content_px};",
            f"export const ZOOM_STEP = {step};",
            f"export const MIN_VIEWPORT_SPAN_SEC = {data['min_viewport_span_sec']};",
            f"export const SNAP_TICK_DECIMALS = {data['snap_tick_decimals']};",
            f"export const PAINT_DPR_CAP = {waveform['paint_dpr_cap']};",
            *[f"export const {name} = {waveform[key]};" for key, name in WAVEFORM_EXPORTS],
            "",
            "/** Paint DPR on a 1/8 grid, so `RENDER_TILE_CSS_PX * paintDpr(d)` is an integer. */",
            "export function paintDpr(devicePixelRatio: number): number {",
            "  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0",
            "    ? devicePixelRatio",
            "    : 1;",
            "  return Math.min(Math.max(Math.round(dpr * 8) / 8, 1), PAINT_DPR_CAP);",
            "}",
            "",
            "/** Zoom ceiling that keeps the timeline content under MAX_CONTENT_PX. */",
            "export function effectiveMaxZoomPxPerSec(sessionSec: number): number {",
            "  return Math.min(MAX_ZOOM_PX_PER_SEC, MAX_CONTENT_PX / Math.max(sessionSec, 1));",
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
