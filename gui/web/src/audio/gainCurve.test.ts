import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  effectiveGainAt,
  envelopeGainAt,
  fadeGainAt,
  gainBreakpoints,
  renderedFadeSec,
} from "./gainCurve";

interface Case {
  name: string;
  points: { time: number; value: number }[];
  clip: { start: number; end: number; fade_in: number; fade_out: number };
  samples: [number, number][];
}

/** FFmpeg evaluates `volume=eval=frame` once per 1024-sample frame at 48 kHz: the render lags a slope by up to this. */
const FRAME_SEC = 1024 / 48000;
const TOLERANCE = 0.005;

const fixture = JSON.parse(
  readFileSync(
    `${process.cwd()}/../../tests/fixtures/gain_curve/cases.json`,
    "utf8",
  ),
) as { cases: Case[] };

const clipOf = (c: Case) => ({
  timelineStartSec: c.clip.start,
  timelineEndSec: c.clip.end,
  fadeInSec: c.clip.fade_in,
  fadeOutSec: c.clip.fade_out,
});

describe("gain curve", () => {
  it.each(fixture.cases)("$name matches what the render produces", (c) => {
    for (const [at, expected] of c.samples) {
      const lagged = Array.from({ length: 9 }, (_, step) =>
        effectiveGainAt(c.points, clipOf(c), at - (step * FRAME_SEC) / 8),
      );
      expect(expected, `${c.name} at ${at}`).toBeGreaterThanOrEqual(
        Math.min(...lagged) - TOLERANCE,
      );
      expect(expected, `${c.name} at ${at}`).toBeLessThanOrEqual(
        Math.max(...lagged) + TOLERANCE,
      );
    }
  });

  it("starts a fade at the envelope's level and returns to it", () => {
    const clip = {
      timelineStartSec: 1,
      timelineEndSec: 3,
      fadeInSec: 0.2,
      fadeOutSec: 0.2,
    };
    const flat = [{ time: 0, value: 0.5 }];
    expect(effectiveGainAt(flat, clip, 1)).toBe(0);
    expect(effectiveGainAt(flat, clip, 1.2)).toBeCloseTo(0.5);
    expect(effectiveGainAt(flat, clip, 2)).toBeCloseTo(0.5);
    expect(effectiveGainAt(flat, clip, 3)).toBe(0);
  });

  it("clamps a fade to half its clip, as the render does", () => {
    expect(renderedFadeSec(0.1, 0.2)).toBeCloseTo(0.05);
    expect(
      fadeGainAt(
        {
          timelineStartSec: 0,
          timelineEndSec: 0.1,
          fadeInSec: 0.2,
          fadeOutSec: 0,
        },
        0.025,
      ),
    ).toBeCloseTo(0.5);
  });

  it("reads no envelope as unity and holds the ends", () => {
    expect(envelopeGainAt([], 5)).toBe(1);
    const line = [
      { time: 1, value: 0.2 },
      { time: 3, value: 1 },
    ];
    expect(envelopeGainAt(line, 0)).toBe(0.2);
    expect(envelopeGainAt(line, 2)).toBeCloseTo(0.6);
    expect(envelopeGainAt(line, 9)).toBe(1);
  });

  it("breaks at every envelope point and fade corner inside the span", () => {
    const clip = {
      timelineStartSec: 0,
      timelineEndSec: 2,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
    };
    const times = gainBreakpoints([{ time: 1, value: 1 }], clip, 0, 2);
    expect(times).toContain(0.5);
    expect(times).toContain(1);
    expect(times).toContain(1.5);
    expect(times.every((t) => t > 0 && t < 2)).toBe(true);
  });
});
