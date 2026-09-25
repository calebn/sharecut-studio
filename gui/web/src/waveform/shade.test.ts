import { describe, expect, it } from "vitest";
import { I16_SCALE, newEnvelope } from "./pyramidMath";
import {
  columnGeometry,
  GEOMETRY_VALUES,
  jobEnvelope,
  jobGeometry,
  premultiply,
  rowCoverage,
} from "./shade";
import type { RasterJob } from "./types";

function env(values: [number, number, number, number][]) {
  const e = newEnvelope(values.length);
  values.forEach(([mn, mx, rms, has], c) => {
    e.min[c] = mn;
    e.max[c] = mx;
    e.rms[c] = rms;
    e.has[c] = has;
  });
  return e;
}

const col = (g: Float32Array, c: number) => [
  ...g.subarray(c * GEOMETRY_VALUES, (c + 1) * GEOMETRY_VALUES),
];

describe("columnGeometry", () => {
  it("maps min/max/rms to rows around the midline", () => {
    // rows 100: mid 50, scale 45.
    const g = columnGeometry(env([[-0.5, 1, 0.2, 1]]), 1, 100, "pyramid");
    expect(col(g, 0)).toEqual([5, 72.5, 41, 59]);
  });

  it("clamps amp zoom to the lane", () => {
    const g = columnGeometry(env([[-0.8, 0.8, 0.9, 1]]), 4, 100, "pyramid");
    expect(col(g, 0)).toEqual([5, 95, 5, 95]);
  });

  it("skips columns without data and silence", () => {
    const g = columnGeometry(
      env([
        [-1, 1, 1, 0],
        [-0.001, 0.001, 0, 1],
      ]),
      1,
      100,
      "pyramid",
    );
    expect(col(g, 0)).toEqual([-1, -1, -1, -1]);
    expect(col(g, 1)).toEqual([-1, -1, -1, -1]);
  });

  it("widens thin columns to the mode's minimum thickness", () => {
    // 0.01 * 45 = 0.45 rows above the midline: kept, widened around its centre.
    const thin: [number, number, number, number] = [0.01, 0.01, 0, 1];
    const pyr = columnGeometry(env([thin]), 1, 100, "pyramid");
    expect(pyr[1]! - pyr[0]!).toBeCloseTo(1, 6);
    expect((pyr[0]! + pyr[1]!) / 2).toBeCloseTo(50 - 0.45, 5);
    const line = columnGeometry(env([thin]), 1, 100, "line");
    expect(line[1]! - line[0]!).toBeCloseTo(1.5, 6);
    // No RMS body: the column is all edge.
    expect(col(line, 0).slice(2)).toEqual([-1, -1]);
  });
});

describe("rowCoverage", () => {
  it("is the overlap of the row with the span", () => {
    expect(rowCoverage(5, 5.25, 9)).toBeCloseTo(0.75);
    expect(rowCoverage(5, 2, 9)).toBe(1);
    expect(rowCoverage(5, 5.2, 5.6)).toBeCloseTo(0.4);
    expect(rowCoverage(5, -1, -1)).toBe(0);
    expect(rowCoverage(0, -1, -1)).toBe(0);
  });
});

describe("premultiply", () => {
  it("scales channels by alpha", () => {
    expect([...premultiply(new Float32Array([1, 0.5, 0.25, 0.5]))]).toEqual([
      0.5, 0.25, 0.125, 0.5,
    ]);
  });
});

describe("jobGeometry", () => {
  const base = {
    cols: 2,
    rows: 10,
    mode: "pyramid" as const,
    frameStart: 0,
    sppDev: 64,
    ampZoom: 1,
    core: new Float32Array([1, 1, 1, 1]),
    edge: new Float32Array([1, 1, 1, 0.6]),
  };

  it("reduces pyramid bins", () => {
    const job: RasterJob = {
      ...base,
      source: {
        kind: "pyramid",
        bins: new Int16Array([-I16_SCALE, I16_SCALE, I16_SCALE, 0, 0, -1]),
        binStart: 0,
        spp: 64,
      },
    };
    const e = jobEnvelope(job);
    expect([...e.has]).toEqual([1, 0]);
    expect(col(jobGeometry(job), 0)).toEqual([0.5, 9.5, 0.5, 9.5]);
  });

  it("reduces host PCM", () => {
    const job: RasterJob = {
      ...base,
      mode: "pcm",
      sppDev: 1,
      source: {
        kind: "pcm",
        pcm: new Int16Array([-100, 100, -200, 200, -300, 300]),
        pcmStart: 0,
      },
    };
    expect([...jobEnvelope(job).has]).toEqual([1, 1]);
  });
});
