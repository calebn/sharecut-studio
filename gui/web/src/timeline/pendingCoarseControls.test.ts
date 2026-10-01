import { describe, expect, it } from "vitest";
import {
  canShowPendingCoarseHandles,
  pendingCoarseHandleCenters,
} from "./pendingCoarseControls";

describe("pending coarse handles", () => {
  it("requires enough true region width and vertical room for separate targets", () => {
    expect(canShowPendingCoarseHandles(44, 88, 44)).toBe(true);
    expect(canShowPendingCoarseHandles(43.99, 88, 44)).toBe(false);
    expect(canShowPendingCoarseHandles(44, 87.99, 44)).toBe(false);
    expect(canShowPendingCoarseHandles(8, 104, 44)).toBe(false);
  });

  it("contains coarse hitboxes within the selected region and canvas", () => {
    const centers = pendingCoarseHandleCenters(20, 64, 100, 44);
    expect(centers).toEqual({ start: 42, end: 42 });
    expect(centers!.start - 22).toBe(20);
    expect(centers!.end + 22).toBe(64);
    expect(pendingCoarseHandleCenters(0, 44, 44, 44)).toEqual({
      start: 22,
      end: 22,
    });
    expect(pendingCoarseHandleCenters(20, 63, 100, 44)).toBeNull();
    expect(pendingCoarseHandleCenters(60, 104, 100, 44)).toBeNull();
  });
});
