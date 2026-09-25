import { GEOMETRY_VALUES, premultiply, rowCoverage } from "./shade";
import type { Rgba } from "./types";

/**
 * CPU rasterizer (S6): `core·rc + edge·(pc − rc)` per device pixel from the
 * shared column geometry, premultiplied, then stored as straight-alpha RGBA
 * bytes for `ImageData`.
 */
export function rasterCpu(
  geom: Float32Array,
  cols: number,
  rows: number,
  core: Rgba,
  edge: Rgba,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(cols * rows * 4);
  const cp = premultiply(core);
  const ep = premultiply(edge);
  for (let c = 0; c < cols; c++) {
    const g = c * GEOMETRY_VALUES;
    const top = geom[g]!;
    const bot = geom[g + 1]!;
    if (bot <= top) {
      continue;
    }
    const rTop = geom[g + 2]!;
    const rBot = geom[g + 3]!;
    const y0 = Math.max(0, Math.floor(top));
    const y1 = Math.min(rows, Math.ceil(bot));
    for (let y = y0; y < y1; y++) {
      const pc = rowCoverage(y, top, bot);
      const rc = rowCoverage(y, rTop, rBot);
      const e = pc - rc;
      const a = cp[3]! * rc + ep[3]! * e;
      if (a <= 0) {
        continue;
      }
      const o = (y * cols + c) * 4;
      out[o] = Math.round(((cp[0]! * rc + ep[0]! * e) / a) * 255);
      out[o + 1] = Math.round(((cp[1]! * rc + ep[1]! * e) / a) * 255);
      out[o + 2] = Math.round(((cp[2]! * rc + ep[2]! * e) / a) * 255);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}
