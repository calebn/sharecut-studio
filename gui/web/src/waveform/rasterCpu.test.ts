import { describe, expect, it } from "vitest";
import { newEnvelope } from "./pyramidMath";
import { rasterCpu } from "./rasterCpu";
import { columnGeometry, premultiply, rowCoverage } from "./shade";

const core = new Float32Array([0.2, 0.6, 0.4, 1]);
const edge = new Float32Array([0.8, 0.9, 1, 0.6]);

function geometry(rows: number) {
  const e = newEnvelope(4);
  const cols: [number, number, number][] = [
    [-0.9, 0.7, 0.3],
    [-0.2, 0.25, 0.1],
    [0, 0, 0],
    [-1, 1, 1],
  ];
  cols.forEach(([mn, mx, rms], c) => {
    e.min[c] = mn;
    e.max[c] = mx;
    e.rms[c] = rms;
    e.has[c] = 1;
  });
  return columnGeometry(e, 1.3, rows, "pyramid");
}

describe("rasterCpu", () => {
  it("paints core·rc + edge·(pc − rc) per device pixel, as straight alpha", () => {
    const rows = 37;
    const geom = geometry(rows);
    const px = rasterCpu(geom, 4, rows, core, edge);
    const cp = premultiply(core);
    const ep = premultiply(edge);
    for (let c = 0; c < 4; c++) {
      for (let y = 0; y < rows; y++) {
        const pc = rowCoverage(y, geom[c * 4]!, geom[c * 4 + 1]!);
        const rc = rowCoverage(y, geom[c * 4 + 2]!, geom[c * 4 + 3]!);
        const a = cp[3]! * rc + ep[3]! * (pc - rc);
        const o = (y * 4 + c) * 4;
        expect(px[o + 3]).toBe(Math.round(a * 255));
        if (a > 0) {
          const r = (cp[0]! * rc + ep[0]! * (pc - rc)) / a;
          expect(Math.abs(px[o]! - r * 255)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it("leaves silence and empty columns transparent", () => {
    const rows = 20;
    const px = rasterCpu(geometry(rows), 4, rows, core, edge);
    for (let y = 0; y < rows; y++) {
      expect(px[(y * 4 + 2) * 4 + 3]).toBe(0);
    }
  });

  it("fills the RMS body with the opaque core colour", () => {
    const rows = 100;
    const px = rasterCpu(geometry(rows), 4, rows, core, edge);
    // Column 3 is full scale with full RMS: its middle row is pure core.
    const o = (50 * 4 + 3) * 4;
    expect([...px.subarray(o, o + 4)]).toEqual([51, 153, 102, 255]);
    // Column 0's top rows are outside the RMS body: edge only.
    const top = (10 * 4 + 0) * 4;
    expect([...px.subarray(top, top + 4)]).toEqual([204, 230, 255, 153]);
  });
});
