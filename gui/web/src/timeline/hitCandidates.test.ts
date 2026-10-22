import { describe, expect, it } from "vitest";
import {
  corePoint,
  type HitTarget,
  hitRadiusPx,
  rankHitTargets,
  reachRect,
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
  const band: HitTarget = {
    kind: "bleed-attenuation",
    id: "region-key",
    rect: { left: 180, top: 110, right: 400, bottom: 122 },
    selected: true,
  };

  it.each([trimIn, trimOut, fadeIn, point, join, seam])(
    "keeps a selected band out of a $kind press even inside its bounds",
    (handle) => {
      expect(ranked([band, handle], 22, handle).map((c) => c.kind)).toEqual([
        handle.kind,
      ]);
    },
  );

  it("does not turn a selected band into a neighbour of a clip body or empty space", () => {
    const body: HitTarget = { ...band, kind: "clip", id: "clip-b" };
    expect(ranked([band, body], 22, body).map((c) => c.kind)).toEqual(["clip"]);
    expect(ranked([band], 22)).toEqual([]);
  });

  it("keeps nearby editing controls ahead of a directly hit selected band in the chooser", () => {
    expect(ranked([band, trimIn, fadeIn], 22, band).map((c) => c.kind)).toEqual(
      ["trim-in", "fade-in", "bleed-attenuation"],
    );
    expect(ranked([band], 0, band).map((c) => c.kind)).toEqual([
      "bleed-attenuation",
    ]);
  });

  it("keeps a reachable flat-envelope point ahead of its full-width line without overriding selection", () => {
    const line: HitTarget = {
      kind: "envelope-line",
      id: "line",
      rect: { left: 100, top: 114, right: 400, bottom: 126 },
      selected: false,
    };
    const at = { x: 203, y: 116 };
    const ranked = (
      targets: HitTarget[],
      radius: number,
      hit: HitTarget | null = null,
    ) =>
      rankHitTargets(targets, at, radius, hit).map(
        ({ candidate }) => candidate.kind,
      );
    expect(ranked([line, point], 22, point)).toEqual([
      "envelope-point",
      "envelope-line",
    ]);
    expect(ranked([line, point], 0, point)).toEqual([
      "envelope-point",
      "envelope-line",
    ]);
    expect(ranked([{ ...line, selected: true }, point], 22)).toEqual([
      "envelope-line",
      "envelope-point",
    ]);
    expect(
      rankHitTargets([line, point], { x: 300, y: 120 }, 22).map(
        ({ candidate }) => candidate.kind,
      ),
    ).toEqual(["envelope-line"]);
  });
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

describe("a comment pin's reach", () => {
  // A 44 px wide pin in the 24 px comments row at y 76..100; clip B starts below at y 109.
  const pin: HitTarget = {
    kind: "comment",
    id: "c1",
    rect: { left: 181, top: 76, right: 225, bottom: 100 },
    selected: false,
  };
  const clipBody: HitTarget = {
    kind: "clip",
    id: "clip-b",
    rect: { left: 100, top: 109, right: 400, bottom: 195 },
    selected: false,
  };
  const kinds = (at: { x: number; y: number }, selected = false) =>
    rankHitTargets([{ ...pin, selected }, clipBody], at, 22, clipBody).map(
      (r) => r.candidate.kind,
    );

  it("reaches sideways along its row", () => {
    expect(
      rankHitTargets([pin], { x: 240, y: 88 }, 22, null).map(
        (r) => r.candidate.kind,
      ),
    ).toEqual(["comment"]);
  });

  it("picks the nearer of two neighbouring pins even when the farther is selected", () => {
    const b: HitTarget = {
      ...pin,
      id: "c2",
      selected: true,
      rect: { left: 211, top: 76, right: 255, bottom: 100 },
    };
    const a = { ...pin, rect: { left: 181, top: 76, right: 225, bottom: 100 } };
    const ids = (hit: HitTarget) =>
      rankHitTargets([a, b], { x: 190, y: 88 }, 22, hit).map(
        (r) => r.candidate.id,
      );
    expect(ids(a)).toEqual(["c1", "c2"]);
  });

  it("keeps the selected pin first among pins at the same distance", () => {
    const stacked = [pin, { ...pin, id: "c2", selected: true }];
    expect(
      rankHitTargets(stacked, { x: 203, y: 88 }, 22, pin).map(
        (r) => r.candidate.id,
      )[0],
    ).toBe("c2");
  });

  it("keeps row distance ordering ahead of a directly hit selected activation band", () => {
    const farther = {
      ...pin,
      id: "c2",
      selected: true,
      rect: { left: 211, top: 76, right: 255, bottom: 100 },
    };
    const band: HitTarget = {
      ...pin,
      kind: "bleed-attenuation",
      id: "region-key",
      selected: true,
    };
    expect(
      rankHitTargets([band, farther, pin], { x: 190, y: 88 }, 22, band).map(
        ({ candidate }) => candidate.id,
      ),
    ).toEqual(["c1", "c2", "region-key"]);
    expect(
      rankHitTargets([band, farther, pin], { x: 190, y: 88 }, 22, pin).map(
        ({ candidate }) => candidate.id,
      ),
    ).toEqual(["c1", "c2"]);
  });

  it("keeps off-row pins out of a directly hit activation band", () => {
    const band: HitTarget = {
      ...clipBody,
      kind: "bleed-attenuation",
      id: "region-key",
      selected: true,
    };
    expect(
      rankHitTargets([pin, band], { x: 203, y: 118 }, 22, band).map(
        ({ candidate }) => candidate.kind,
      ),
    ).toEqual(["bleed-attenuation"]);
  });

  it("leaves a finger on the clip below to the clip, selected or not", () => {
    expect(kinds({ x: 203, y: 118 })).toEqual(["clip"]);
    expect(kinds({ x: 203, y: 118 }, true)).toEqual(["clip"]);
  });

  it("leaves a finger on the ruler above to the ruler", () => {
    expect(rankHitTargets([pin], { x: 203, y: 60 }, 22, null)).toEqual([]);
  });
});

describe("a body", () => {
  // Clip B's body, under every target at its start.
  const body: HitTarget = {
    kind: "clip",
    id: "clip-b",
    rect: { left: 200, top: 106, right: 600, bottom: 206 },
    selected: true,
  };

  it("is the one candidate, where the pointer is, when the pointer is on it and nothing else is in reach", () => {
    expect(
      rankHitTargets([body, chapter], { x: 400, y: 150 }, 22, body).map(
        (r) => r.candidate,
      ),
    ).toEqual([
      {
        kind: "clip",
        id: "clip-b",
        x: 400,
        y: 150,
        distance: 0,
        priority: 1,
        selected: true,
      },
    ]);
  });

  it("gives way to any target in reach, though it is selected", () => {
    expect(ranked([body, trimIn], 22, body).map((c) => c.kind)).toEqual([
      "trim-in",
    ]);
  });

  it("is still the one candidate when every target in reach is out of reach", () => {
    expect(
      rankHitTargets([body, trimIn], { x: 204, y: 150 }, 22, body, () => false),
    ).toEqual([
      {
        target: body,
        candidate: {
          kind: "clip",
          id: "clip-b",
          x: 204,
          y: 150,
          distance: 0,
          priority: 1,
          selected: true,
        },
      },
    ]);
  });

  it("keeps the target the browser hit though the reach test refuses it", () => {
    expect(ranked([body, trimIn], 22, trimIn).map((c) => c.kind)).toEqual([
      "trim-in",
    ]);
    expect(
      rankHitTargets([trimIn], { x: 204, y: 150 }, 22, trimIn, () => false).map(
        (r) => r.candidate.kind,
      ),
    ).toEqual(["trim-in"]);
  });

  it("counts only as the element the browser hit, never by reach", () => {
    expect(ranked([body], 22)).toEqual([]);
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

describe("reachRect", () => {
  const glyph = { left: 192, top: 100, right: 208, bottom: 108 };

  it("grows a join glyph about its centre to 24 px for a pointer and 44 px for a finger", () => {
    expect(reachRect(glyph, "join", "mouse")).toEqual({
      left: 188,
      top: 92,
      right: 212,
      bottom: 116,
    });
    expect(reachRect(glyph, "join", "touch")).toEqual({
      left: 178,
      top: 82,
      right: 222,
      bottom: 126,
    });
  });

  it("leaves a kind with no minimum box, and a box already larger, as painted", () => {
    expect(reachRect(glyph, "fade-in", "touch")).toEqual(glyph);
    const wide = { left: 0, top: 0, right: 60, bottom: 50 };
    expect(reachRect(wide, "join", "touch")).toEqual(wide);
  });

  it("reaches a finger 20 px beside the glyph's painted box", () => {
    const target: HitTarget = {
      kind: "join",
      id: "clip-b",
      rect: reachRect(glyph, "join", "touch"),
      selected: false,
    };
    const beside = { x: glyph.right + 20, y: 104 };
    expect(
      rankHitTargets([target], beside, hitRadiusPx("touch")).map(
        ({ candidate }) => candidate.id,
      ),
    ).toEqual(["clip-b"]);
  });
});
