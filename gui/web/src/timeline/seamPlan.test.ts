import { describe, expect, it } from "vitest";
import type { AppliedTick } from "./appliedEditTicks";
import { planSeams } from "./seamPlan";

const tick = (sec: number): AppliedTick => ({
  key: `t${sec}`,
  recordId: `r${sec}`,
  kind: "seam",
  mute: false,
  sec,
});

describe("planSeams", () => {
  it("keeps seams 24 px apart or more as separate marks", () => {
    const plan = planSeams([tick(1), tick(2)], 24, 60);
    expect(plan.map((p) => p.kind)).toEqual(["seam", "seam"]);
  });

  it("folds seams closer than 24 px into one chip centred on the group", () => {
    const plan = planSeams([tick(1), tick(1.5), tick(2)], 20, 60);
    expect(plan).toHaveLength(1);
    const chip = plan[0];
    expect(chip.kind).toBe("chip");
    if (chip.kind === "chip") {
      expect(chip.ticks).toHaveLength(3);
      expect(chip.xPx).toBe(30);
      expect(chip.zoomTo).toBeGreaterThan(20);
    }
  });
});
