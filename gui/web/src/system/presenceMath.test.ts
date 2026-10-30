import { describe, expect, it } from "vitest";
import {
  FLAG_PX,
  flagSide,
  playheadVisible,
  presenceX,
  selectionBox,
  visiblePeople,
} from "./presenceMath";
import { xAtTime } from "./rulerMath";

describe("presenceX", () => {
  it("is the ruler's x in whole pixels", () => {
    expect(presenceX(12.5, 0, 24)).toBe(300);
    expect(presenceX(0.1, 0, 6)).toBe(1);
  });

  it("stays within half a pixel of the ruler's playhead", () => {
    for (const time of [0.1, 12.5, 99.97, 604.123]) {
      const drift = Math.abs(presenceX(time, 3.3, 17) - xAtTime(time, 3.3, 17));
      expect(drift).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("playheadVisible", () => {
  it("allows a 6 px bleed either side of the window", () => {
    expect(playheadVisible(-6, 360)).toBe(true);
    expect(playheadVisible(-6.5, 360)).toBe(false);
    expect(playheadVisible(366, 360)).toBe(true);
    expect(playheadVisible(366.5, 360)).toBe(false);
  });
});

describe("flagSide", () => {
  it("flips left when the flag would pass the right edge", () => {
    expect(FLAG_PX).toBe(16);
    expect(flagSide(350, 360)).toBe("left");
    expect(flagSide(100, 360)).toBe("right");
    expect(flagSide(344, 360)).toBe("right");
    expect(flagSide(345, 360)).toBe("left");
  });
});

describe("selectionBox", () => {
  it("clips a span that began before the window", () => {
    expect(selectionBox(-5, 10, 0, 24, 360)).toEqual({
      left: 0,
      right: 240,
      startVisible: false,
      endVisible: true,
    });
  });

  it("keeps a span inside the window whole", () => {
    expect(selectionBox(0, 10, 0, 24, 360)).toEqual({
      left: 0,
      right: 240,
      startVisible: true,
      endVisible: true,
    });
    expect(selectionBox(2, 15, 0, 24, 360)).toEqual({
      left: 48,
      right: 360,
      startVisible: true,
      endVisible: true,
    });
  });

  it("clips a span that runs past the right edge", () => {
    expect(selectionBox(10, 20, 0, 24, 360)).toEqual({
      left: 240,
      right: 360,
      startVisible: true,
      endVisible: false,
    });
  });

  it("is null when empty or wholly outside", () => {
    expect(selectionBox(-10, -1, 0, 24, 360)).toBeNull();
    expect(selectionBox(15, 15, 0, 24, 360)).toBeNull();
    expect(selectionBox(20, 10, 0, 24, 360)).toBeNull();
    expect(selectionBox(400, 410, 0, 24, 360)).toBeNull();
  });
});

describe("visiblePeople", () => {
  const people = [{ id: "maya" }, { id: "anneke" }];

  it("drops the followed person", () => {
    expect(visiblePeople(people, "maya")).toEqual([{ id: "anneke" }]);
  });

  it("keeps everyone when no one is followed", () => {
    expect(visiblePeople(people, null)).toEqual(people);
    expect(visiblePeople(people, undefined)).toEqual(people);
  });
});
