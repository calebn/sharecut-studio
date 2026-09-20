import { describe, expect, it } from "vitest";
import {
  pendingOverlayWidthPx,
  SPAN_OVERLAY_MIN_WIDTH_PX,
  SPLIT_OVERLAY_WIDTH_PX,
} from "./pendingOverlayWidth";

describe("pendingOverlayWidthPx", () => {
  it("keeps split blades at a fixed pixel width", () => {
    expect(pendingOverlayWidthPx("split", 0)).toBe(SPLIT_OVERLAY_WIDTH_PX);
    expect(pendingOverlayWidthPx("split", 80)).toBe(SPLIT_OVERLAY_WIDTH_PX);
    expect(SPLIT_OVERLAY_WIDTH_PX).toBe(2);
  });

  it("sizes mute and remove spans from their timeline width", () => {
    expect(pendingOverlayWidthPx("mute", 40)).toBe(40);
    expect(pendingOverlayWidthPx("remove", 1)).toBe(SPAN_OVERLAY_MIN_WIDTH_PX);
  });
});
