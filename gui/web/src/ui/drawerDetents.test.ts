import { describe, expect, it } from "vitest";
import { drawerDetentAfter } from "./drawerDetents";

const detents = ["peek", "half", "full"] as const;
const release = (
  current: (typeof detents)[number],
  dyPx: number,
  heightPx: number,
  velocity = 0,
) =>
  drawerDetentAfter({
    detents,
    current,
    dyPx,
    velocity,
    heightPx,
    slotPx: 600,
  });

describe("drawerDetentAfter", () => {
  it("snaps back from a short, slow drag", () => {
    expect(release("peek", -20, 140)).toBe("peek");
    expect(release("half", 20, 280)).toBe("half");
  });

  it("moves one detent the way a drag past the threshold went", () => {
    expect(release("peek", -60, 180)).toBe("half");
    expect(release("half", -60, 360)).toBe("full");
    expect(release("full", 60, 400)).toBe("half");
    expect(release("half", 60, 240)).toBe("peek");
  });

  it("follows a quick flick however short", () => {
    expect(release("peek", -8, 128, -0.8)).toBe("half");
    expect(release("full", 8, 592, 0.8)).toBe("half");
  });

  it("goes to an end a drag nearly reached, and never past one", () => {
    expect(release("peek", -400, 500)).toBe("full");
    expect(release("full", 480, 120)).toBe("peek");
    expect(release("full", -60, 600)).toBe("full");
    expect(release("peek", 60, 60)).toBe("peek");
  });
});
