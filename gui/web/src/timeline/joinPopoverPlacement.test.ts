import { describe, expect, it } from "vitest";
import { placeJoinPopover } from "./joinPopoverPlacement";

const viewport = { width: 1000, height: 800 };
const panel = { width: 200, height: 100 };

describe("placeJoinPopover", () => {
  it("centres the panel below the badge", () => {
    const anchor = { left: 400, top: 100, bottom: 120, width: 20 };
    expect(placeJoinPopover(anchor, panel, viewport, 8)).toEqual({
      left: 310,
      top: 128,
    });
  });

  it("clamps at the left viewport edge", () => {
    const anchor = { left: 0, top: 100, bottom: 120, width: 20 };
    expect(placeJoinPopover(anchor, panel, viewport, 8).left).toBe(8);
  });

  it("clamps at the right viewport edge", () => {
    const anchor = { left: 990, top: 100, bottom: 120, width: 20 };
    expect(placeJoinPopover(anchor, panel, viewport, 8).left).toBe(
      viewport.width - 8 - panel.width,
    );
  });

  it("flips above the badge when there is no room below", () => {
    const anchor = { left: 400, top: 750, bottom: 770, width: 20 };
    const result = placeJoinPopover(anchor, panel, viewport, 8);
    expect(result.top).toBe(anchor.top - 8 - panel.height);
  });

  it("never places the top above marginPx", () => {
    const anchor = { left: 400, top: 10, bottom: 30, width: 20 };
    const tinyViewport = { width: 1000, height: 50 };
    expect(
      placeJoinPopover(anchor, panel, tinyViewport, 8).top,
    ).toBeGreaterThanOrEqual(8);
  });
});
