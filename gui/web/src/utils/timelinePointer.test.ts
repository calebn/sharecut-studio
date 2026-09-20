import { describe, expect, it } from "vitest";
import { clientXToTimelineSec } from "./timelinePointer";

describe("clientXToTimelineSec", () => {
  it("maps the left edge to zero", () => {
    expect(clientXToTimelineSec(100, { left: 100 }, 0, 100, 60)).toBe(0);
  });

  it("maps mid-timeline with scroll offset", () => {
    // Viewport-stable origin at 100; content scrolled 50; click at 200 → x=150 → 1.5s
    expect(clientXToTimelineSec(200, { left: 100 }, 50, 100, 60)).toBe(1.5);
  });

  it("does not add scrollLeft for a canvas element whose rect already moved", () => {
    const canvas = {
      getBoundingClientRect: () => ({ left: 50 }),
    } as HTMLElement;
    // Same click as above: origin was 100, scroll 50 → rect.left is 50.
    expect(clientXToTimelineSec(200, canvas, 50, 100, 60)).toBe(1.5);
  });

  it("maps a playhead hover after pan without double-counting scroll", () => {
    // Measured: 10s needle at content 398.76px, scrollLeft 280, lanes.left -100, clientX 298.75.
    const lanes = {
      getBoundingClientRect: () => ({ left: -100 }),
    } as HTMLElement;
    const zoom = 398.763 / 10;
    expect(clientXToTimelineSec(298.75, lanes, 280, zoom, 60)).toBeCloseTo(
      10,
      1,
    );
  });

  it("clamps to duration", () => {
    expect(clientXToTimelineSec(10_000, { left: 0 }, 0, 100, 5)).toBe(5);
  });

  it("clamps below zero", () => {
    expect(clientXToTimelineSec(0, { left: 100 }, 0, 100, 60)).toBe(0);
  });
});
