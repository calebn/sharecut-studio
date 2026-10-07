import { describe, expect, it } from "vitest";
import {
  decidePrecision,
  decisionText,
  fingerWidthPx,
  velocityGain,
} from "./precisionDecision";

/** An 8 px trim handle under a 44 px finger, at 10 px/s (0.1 px per step). */
const narrow = { targetPx: 8, gapPx: null, fingerPx: 44, stepPx: 0.1 };

describe("Auto precision decision", () => {
  it("drags directly once a step is 4 px wide, whatever the target", () => {
    const d = decidePrecision({ ...narrow, stepPx: 4 });
    expect([d.mode, d.reason, d.thresholdPx]).toEqual([
      "direct",
      "zoom-fine",
      4,
    ]);
    expect(decidePrecision({ ...narrow, stepPx: 3.9 }).mode).toBe("precision");
  });

  it("goes into precision for a target narrower than the finger", () => {
    const d = decidePrecision(narrow);
    expect([d.mode, d.reason, d.thresholdPx, d.sticky]).toEqual([
      "precision",
      "target-narrow",
      44,
      false,
    ]);
  });

  it("goes into precision for a wide target with a neighbour closer than the finger", () => {
    const d = decidePrecision({ ...narrow, targetPx: 60, gapPx: 18 });
    expect([d.mode, d.reason]).toEqual(["precision", "neighbour-close"]);
  });

  it("drags a wide target with room around it directly", () => {
    const d = decidePrecision({ ...narrow, targetPx: 60, gapPx: 120 });
    expect([d.mode, d.reason]).toEqual(["direct", "roomy"]);
    expect(decidePrecision({ ...narrow, targetPx: 44 }).mode).toBe("direct");
  });

  it("keeps a target's last mode until a measure clears the threshold by 25%", () => {
    const edge = { ...narrow, targetPx: 50 };
    expect(decidePrecision(edge).mode).toBe("direct");
    // Armed in precision before: 50 px is under 44 × 1.25 = 55, so it stays.
    const kept = decidePrecision(edge, "precision");
    expect([kept.mode, kept.thresholdPx, kept.sticky]).toEqual([
      "precision",
      55,
      true,
    ]);
    expect(decidePrecision({ ...edge, targetPx: 56 }, "precision").mode).toBe(
      "direct",
    );
    // Armed directly before: 40 px is not under 44 / 1.25 = 35.2, so it stays.
    expect(decidePrecision({ ...edge, targetPx: 40 }, "direct").mode).toBe(
      "direct",
    );
    expect(decidePrecision({ ...edge, targetPx: 35 }, "direct").mode).toBe(
      "precision",
    );
    // The zoom threshold leans the same way: 5 px after precision, 3.2 after direct.
    expect(decidePrecision({ ...narrow, stepPx: 4.5 }, "precision").mode).toBe(
      "precision",
    );
    expect(decidePrecision({ ...narrow, stepPx: 3.3 }, "direct").mode).toBe(
      "direct",
    );
  });

  it("takes the finger's larger side, or 44 px when the browser reports none", () => {
    expect(fingerWidthPx(30, 38)).toBe(38);
    expect(fingerWidthPx(10, 4)).toBe(10);
    expect(fingerWidthPx(1, 1)).toBe(44);
    expect(fingerWidthPx(0, 0)).toBe(44);
    expect(fingerWidthPx(2, 2)).toBe(44);
  });

  it("reads out what it chose and why", () => {
    expect(decisionText(decidePrecision(narrow))).toBe(
      "Precision · target 8 px < finger 44 px",
    );
    expect(
      decisionText(decidePrecision({ ...narrow, targetPx: 60, gapPx: 18.25 })),
    ).toBe("Precision · neighbour 18.3 px < finger 44 px");
    expect(decisionText(decidePrecision({ ...narrow, stepPx: 6 }))).toBe(
      "Direct · 6 px per step ≥ 4 px",
    );
    expect(
      decisionText(decidePrecision({ ...narrow, targetPx: 60, gapPx: 120 })),
    ).toBe("Direct · target 60 px, neighbour 120 px ≥ finger 44 px");
    expect(
      decisionText(decidePrecision({ ...narrow, targetPx: 50 }, "precision")),
    ).toBe("Precision · target 50 px < finger 55 px (sticky)");
  });
});

describe("direct drag ballistics", () => {
  it("moves a slow finger one step per 4 px and a fast one 1:1", () => {
    // 0.1 px per step: a slow finger gets 0.025, so 4 px make one step.
    expect(velocityGain(0, 0.1)).toBe(0.025);
    expect(velocityGain(0.05, 0.1)).toBe(0.025);
    expect(velocityGain(0.275, 0.1)).toBeCloseTo(0.5125, 9);
    expect(velocityGain(0.5, 0.1)).toBe(1);
    expect(velocityGain(3, 0.1)).toBe(1);
  });

  it("leaves a drag 1:1 when a step is already 4 px wide", () => {
    expect(velocityGain(0, 4)).toBe(1);
    expect(velocityGain(0.2, 12)).toBe(1);
  });

  it("never falls as the finger speeds up, and never passes 1:1", () => {
    const speeds = Array.from({ length: 41 }, (_, i) => i * 0.02);
    const gains = speeds.map((v) => velocityGain(v, 0.3));
    for (let i = 1; i < gains.length; i += 1) {
      expect(gains[i]).toBeGreaterThanOrEqual(gains[i - 1]);
    }
    expect(Math.max(...gains)).toBe(1);
    expect(Math.min(...gains)).toBeCloseTo(0.075, 9);
  });
});
