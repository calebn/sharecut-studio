import { describe, expect, it } from "vitest";
import { toastDockBottomPx } from "./toastDock";

/** 390×844 phone: transport 0–52, mode nav 792–844, toast 62 tall, 12px gap. */
const phone = {
  viewportHeight: 844,
  ceilingPx: 52,
  navTopPx: 792,
  toastHeightPx: 62,
  gapPx: 12,
};

describe("toastDockBottomPx (phone)", () => {
  it("sits just above the mode nav when nothing else is docked", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792] })).toBe(
      844 - 792 + 12,
    );
  });

  it("sits above the Timeline tool rail instead of covering it", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 732] })).toBe(
      844 - 732 + 12,
    );
  });

  it("sits above a half sheet, over the timeline, under the transport", () => {
    const bottom = toastDockBottomPx({
      ...phone,
      floorTopsPx: [792, 732, 396],
    });
    expect(bottom).toBe(844 - 396 + 12);
    const toastTop = 844 - bottom - phone.toastHeightPx;
    expect(toastTop).toBeGreaterThanOrEqual(phone.ceilingPx);
  });

  it("falls back above the mode nav when a full sheet leaves no free band", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 732, 0] })).toBe(
      844 - 792 + 12,
    );
  });

  it("falls back when the band above a tall sheet cannot fit the toast", () => {
    expect(toastDockBottomPx({ ...phone, floorTopsPx: [792, 100] })).toBe(
      844 - 792 + 12,
    );
  });
});
