import { describe, expect, it } from "vitest";
import {
  corePoint,
  type HitTarget,
  hitRadiusPx,
  rankHitTargets,
} from "./hitCandidates";

// Clip B starts at x = 200 in a lane whose top is y = 100 and whose clips sit
// 6 px below it: every target below shares that one timeline time.
const trimIn: HitTarget = {
  kind: "trim-in",
  id: "clip-b",
  rect: { left: 200, top: 106, right: 208, bottom: 174 },
  selected: false,
};
const trimOut: HitTarget = {
  kind: "trim-out",
  id: "clip-a",
  rect: { left: 192, top: 106, right: 200, bottom: 174 },
  selected: false,
};
const fadeIn: HitTarget = {
  kind: "fade-in",
  id: "clip-b",
  rect: { left: 200, top: 106, right: 212, bottom: 118 },
  selected: false,
};
const point: HitTarget = {
  kind: "envelope-point",
  id: "pt-1",
  rect: { left: 195, top: 115, right: 205, bottom: 125 },
  selected: false,
};
const join: HitTarget = {
  kind: "join",
  id: "clip-b",
  rect: { left: 192, top: 100, right: 208, bottom: 106 },
  selected: false,
};
const seam: HitTarget = {
  kind: "roll",
  id: "clip-b",
  rect: { left: 188, top: 128, right: 212, bottom: 152 },
  selected: false,
};
const chapter: HitTarget = {
  kind: "chapter",
  id: "200-Intro",
  rect: { left: 192, top: 40, right: 208, bottom: 56 },
  selected: false,
};
const cluster = [seam, chapter, join, point, fadeIn, trimOut, trimIn];
const finger = { x: 203, y: 116 };

function ranked(
  targets: readonly HitTarget[],
  radius: number,
  hit: HitTarget | null = null,
) {
  return rankHitTargets(targets, finger, radius, hit).map((r) => r.candidate);
}

describe("rankHitTargets", () => {
  it("ranks a same-time cluster at a clip edge: the roll first, as it outranks the trims (#1135), then by core distance and priority", () => {
    expect(ranked(cluster, 22)).toEqual([
      {
        kind: "roll",
        id: "clip-b",
        x: 200,
        y: 140,
        distance: Math.hypot(3, 24),
        priority: 6,
        selected: false,
      },
      {
        kind: "trim-in",
        id: "clip-b",
        x: 204,
        y: 116,
        distance: 1,
        priority: 4,
        selected: false,
      },
      {
        kind: "envelope-point",
        id: "pt-1",
        x: 200,
        y: 120,
        distance: 5,
        priority: 9,
        selected: false,
      },
      {
        kind: "fade-in",
        id: "clip-b",
        x: 206,
        y: 112,
        distance: 5,
        priority: 5,
        selected: false,
      },
      {
        kind: "trim-out",
        id: "clip-a",
        x: 196,
        y: 116,
        distance: 7,
        priority: 4,
        selected: false,
      },
      {
        kind: "join",
        id: "clip-b",
        x: 203,
        y: 103,
        distance: 13,
        priority: 10,
        selected: false,
      },
    ]);
  });

  it("puts the selected target first even when another is nearer", () => {
    const selectedFade = { ...fadeIn, selected: true };
    expect(
      ranked([trimIn, point, selectedFade, seam], 22).map(
        (c) => `${c.kind}:${c.selected}`,
      ),
    ).toEqual([
      "fade-in:true",
      "roll:false",
      "trim-in:false",
      "envelope-point:false",
    ]);
  });

  it("gives a mouse only the targets under it", () => {
    expect(ranked(cluster, 0).map((c) => c.kind)).toEqual([
      "trim-in",
      "envelope-point",
      "fade-in",
    ]);
  });

  it("keeps the target the browser hit even outside its box", () => {
    // The envelope circle's hit stroke reaches past its geometry box.
    const below = {
      ...point,
      rect: { left: 195, top: 125, right: 205, bottom: 135 },
    };
    expect(ranked([below, chapter], 0, below).map((c) => c.kind)).toEqual([
      "envelope-point",
    ]);
  });

  it("returns one candidate for an isolated target", () => {
    expect(ranked([chapter], 22)).toEqual([]);
    expect(ranked([trimIn, chapter], 22).map((c) => c.kind)).toEqual([
      "trim-in",
    ]);
  });
});

describe("corePoint", () => {
  it("is the centre of a square and the centre line of a strip", () => {
    expect(corePoint(seam.rect, { x: 0, y: 0 })).toEqual({ x: 200, y: 140 });
    expect(corePoint(trimIn.rect, { x: 0, y: 150 })).toEqual({
      x: 204,
      y: 150,
    });
  });
});

describe("hitRadiusPx", () => {
  it("reaches 22 px for touch and nothing beyond the pointer otherwise", () => {
    expect(hitRadiusPx("touch")).toBe(22);
    expect(hitRadiusPx("mouse")).toBe(0);
    expect(hitRadiusPx("pen")).toBe(0);
  });
});
