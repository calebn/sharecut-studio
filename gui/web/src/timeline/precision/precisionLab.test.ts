import { afterEach, describe, expect, it } from "vitest";
import { decisionLog, lastMode, logDecision } from "./decisionLog";
import { decidePrecision } from "./precisionDecision";
import {
  applyPrecisionQuery,
  PRECISION_STORAGE_KEY,
  precisionLab,
  setPrecisionAuto,
  setPrecisionStyle,
} from "./precisionLab";

afterEach(() => {
  setPrecisionAuto(false);
  setPrecisionStyle("jog");
});

describe("precision lab switch", () => {
  it("is off until chosen", () => {
    expect(precisionLab()).toEqual({ auto: false, style: "jog" });
  });

  it("turns Auto on from ?lab=precision:auto", () => {
    applyPrecisionQuery("?project=/ep&lab=precision:auto");
    expect(precisionLab()).toEqual({ auto: true, style: "jog" });
    expect(localStorage.getItem(PRECISION_STORAGE_KEY)).toBe("auto");
  });

  it("picks a style and turns Auto on from ?lab=precision:lens", () => {
    applyPrecisionQuery("?lab=precision:lens");
    expect(precisionLab()).toEqual({ auto: true, style: "lens" });
  });

  it("turns Auto off from ?lab=-precision and ?lab=precision:off, keeping the style", () => {
    applyPrecisionQuery("?lab=precision:grip");
    applyPrecisionQuery("?lab=-precision");
    expect(precisionLab()).toEqual({ auto: false, style: "grip" });
    applyPrecisionQuery("?lab=precision:auto&lab=precision:off");
    expect(precisionLab().auto).toBe(false);
  });
});

describe("Auto decision log", () => {
  it("keeps the last 20, newest first, and remembers each target's last mode", () => {
    const precision = decidePrecision({
      targetPx: 8,
      gapPx: null,
      fingerPx: 44,
      stepPx: 0.1,
    });
    const direct = decidePrecision({
      targetPx: 8,
      gapPx: null,
      fingerPx: 44,
      stepPx: 6,
    });
    for (let i = 0; i < 25; i += 1) {
      logDecision({
        at: i,
        target: `trim-out:c${i}`,
        name: "Trim end",
        decision: i % 2 ? direct : precision,
      });
    }
    expect(decisionLog().map((e) => e.at)).toEqual(
      Array.from({ length: 20 }, (_, i) => 24 - i),
    );
    expect(lastMode("trim-out:c24")).toBe("precision");
    expect(lastMode("trim-out:c23")).toBe("direct");
    expect(lastMode("trim-out:c2")).toBe(null);
  });
});
