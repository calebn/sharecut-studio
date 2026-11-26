import { describe, expect, it } from "vitest";
import {
  coveredTicks,
  FLAG_PX,
  flagSide,
  type PresenceFlag,
  playheadVisible,
  presenceFlags,
  presenceHitPx,
  presenceX,
  selectionBox,
  visiblePeople,
} from "./presenceMath";
import { rulerStep, rulerTicks, tickKey, xAtTime } from "./rulerMath";

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

const person = (id: string, playhead: number, name = id.toUpperCase()) => ({
  id,
  name,
  colorIndex: 0,
  playhead,
});
const at = (
  hit = 24,
  over: Partial<Parameters<typeof presenceFlags>[1]> = {},
) => ({
  start: 0,
  pxPerSecond: 10,
  width: 1000,
  hit,
  ...over,
});
const keys = (flags: readonly PresenceFlag[]) => flags.map((f) => f.key);

describe("presenceHitPx", () => {
  it("is 24 for a mouse and 44 for a finger at 16 px, and scales with the root font", () => {
    expect(presenceHitPx("fine")).toBe(24);
    expect(presenceHitPx("coarse")).toBe(44);
    expect(presenceHitPx("fine", 20)).toBe(30);
  });
});

describe("flagSide with a width", () => {
  it("flips a wider flag sooner", () => {
    expect(flagSide(340, 360, 22)).toBe("left");
    expect(flagSide(338, 360, 22)).toBe("right");
    expect(flagSide(344, 360)).toBe("right");
  });
});

describe("presenceFlags", () => {
  it("makes one flag for one person, right of its line", () => {
    const [flag, ...rest] = presenceFlags(
      [person("a", 10, "Ada Lovelace")],
      at(),
    );
    expect(rest).toEqual([]);
    expect(flag).toMatchObject({
      key: "a",
      x: 100,
      side: "right",
      left: 101,
      width: 16,
      text: "A",
    });
    expect(flag?.people.map((p) => p.id)).toEqual(["a"]);
  });

  it("draws nobody without a playhead or outside the window", () => {
    expect(
      presenceFlags(
        [
          { id: "a", name: "A", colorIndex: 0 },
          person("b", -5),
          person("c", 1000),
        ],
        at(),
      ),
    ).toEqual([]);
  });

  it("merges two people at the same position, and each hit box then stands alone", () => {
    const flags = presenceFlags([person("b", 10), person("a", 10)], at());
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      key: "a,b",
      text: "+2",
      width: 22,
      x: 100,
    });
    expect(flags[0]?.people.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps two flags whose press areas only touch, and merges them one px closer", () => {
    expect(
      presenceFlags([person("a", 10), person("b", 12.4)], at()),
    ).toHaveLength(2);
    expect(
      presenceFlags([person("a", 10), person("b", 12.3)], at()),
    ).toHaveLength(1);
  });

  it("does not chain by the anchor: a, a+20 and a+40 at 24 px make a pair and a single", () => {
    const flags = presenceFlags(
      [person("a", 10), person("b", 12), person("c", 14)],
      at(),
    );
    expect(keys(flags)).toEqual(["a,b", "c"]);
    const apart = presenceFlags(
      [person("a", 10), person("b", 12.5), person("c", 15)],
      at(),
    );
    expect(keys(apart)).toEqual(["a", "b", "c"]);
  });

  it("merges a group with the single that its wider press area reaches", () => {
    const flags = presenceFlags(
      [person("a", 10), person("b", 10), person("c", 12.3)],
      at(),
    );
    expect(keys(flags)).toEqual(["a,b,c"]);
  });

  it("merges at 44 px what 24 px keeps apart", () => {
    const people = [person("a", 10), person("b", 13.5)];
    expect(presenceFlags(people, at(24))).toHaveLength(2);
    expect(presenceFlags(people, at(44))).toHaveLength(1);
    expect(presenceFlags(people, at(presenceHitPx("coarse", 20)))).toHaveLength(
      1,
    );
  });

  it("splits when zoomed in and merges when zoomed out", () => {
    const people = [person("a", 10), person("b", 11)];
    expect(
      presenceFlags(people, at(24, { pxPerSecond: 100, width: 2000 })),
    ).toHaveLength(2);
    expect(presenceFlags(people, at(24, { pxPerSecond: 20 }))).toHaveLength(1);
    expect(
      presenceFlags(people, at(24, { pxPerSecond: 0.05, width: 100 })),
    ).toHaveLength(1);
    expect(
      presenceFlags(people, at(24, { pxPerSecond: 48000, width: 1_000_000 })),
    ).toHaveLength(2);
  });

  it("never lets two press areas overlap, in any order, including at the right edge", () => {
    const edge = 1000;
    for (const hit of [24, 44]) {
      for (let gap = 0; gap < 70; gap += 3) {
        for (const base of [100, edge - 90, edge - 40, edge - 10]) {
          const people = [
            person("a", base / 10),
            person("b", base / 10),
            person("c", (base + gap) / 10),
            person("d", (base + gap + 7) / 10),
          ];
          const flags = presenceFlags(people, at(hit, { width: edge }));
          const spans = flags.map((f) => {
            const half = Math.max(f.width, hit) / 2;
            const centre = f.left + f.width / 2;
            return [centre - half, centre + half] as const;
          });
          for (let i = 0; i < spans.length - 1; i++) {
            expect(spans[i]?.[1]).toBeLessThanOrEqual(spans[i + 1]?.[0] ?? 0);
          }
          expect(flags.flatMap((f) => f.people)).toHaveLength(
            people.filter((p) => presenceX(p.playhead, 0, 10) <= edge + 6)
              .length,
          );
        }
      }
    }
  });

  it("flips a group's pill left of its line at the right edge, and a +2 beside a single there merges", () => {
    const flags = presenceFlags(
      [person("a", 98.5), person("b", 98.5), person("c", 99.2)],
      at(24, { width: 1000 }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      side: "left",
      x: 985,
      text: "+3",
      left: 962,
    });
    const alone = presenceFlags([person("a", 99.5)], at(24, { width: 1000 }));
    expect(alone[0]).toMatchObject({ side: "left", left: 995 - 1 - 16 });
  });

  it("flips a group by its own wider width: a single fits at 980 px, a +2 at the same spot does not", () => {
    const single = presenceFlags([person("a", 98)], at(24, { width: 1000 }));
    expect(single[0]).toMatchObject({ x: 980, side: "right" });
    const pair = presenceFlags(
      [person("a", 98), person("b", 98)],
      at(24, { width: 1000 }),
    );
    expect(pair[0]).toMatchObject({ x: 980, side: "left", text: "+2" });
  });

  it("is deterministic: input order does not change keys, members or order", () => {
    const people = [
      person("c", 30),
      person("a", 10),
      person("b", 10.5),
      person("d", 30),
    ];
    const first = presenceFlags(people, at());
    const second = presenceFlags([...people].reverse(), at());
    expect(second).toEqual(first);
    expect(keys(first)).toEqual(["a,b", "c,d"]);
  });

  it("keeps the same key while the members stay, wherever they stand in the group", () => {
    const a = presenceFlags([person("a", 10), person("b", 10.5)], at());
    const b = presenceFlags([person("a", 10.5), person("b", 10)], at());
    expect(keys(a)).toEqual(keys(b));
    expect(a[0]?.people.map((p) => p.id)).toEqual(["a", "b"]);
    expect(b[0]?.people.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("sorts left to right with a stable tie by key", () => {
    const flags = presenceFlags(
      [person("z", 50), person("m", 10), person("a", 30)],
      at(),
    );
    expect(keys(flags)).toEqual(["m", "a", "z"]);
  });

  it("caps the count at 99+", () => {
    const crowd = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        person(`p${String(i).padStart(3, "0")}`, 10),
      );
    expect(presenceFlags(crowd(3), at())[0]?.text).toBe("+3");
    expect(presenceFlags(crowd(99), at())[0]?.text).toBe("+99");
    const hundred = presenceFlags(crowd(100), at())[0];
    expect(hundred?.text).toBe("99+");
    expect(hundred?.people).toHaveLength(100);
    expect(hundred?.width).toBe(2 + 16 * (0.5 + 0.375 * 3));
  });

  it("sizes a group pill in rem: +2 is 22 px and +10 is 28 px at 16 px", () => {
    const two = presenceFlags([person("a", 10), person("b", 10)], at());
    expect(two[0]?.width).toBe(22);
    const ten = presenceFlags(
      Array.from({ length: 10 }, (_, i) => person(`p${i}`, 10)),
      at(),
    );
    expect(ten[0]?.width).toBe(28);
    expect(
      presenceFlags([person("a", 10), person("b", 10)], at(24, { rem: 20 }))[0]
        ?.width,
    ).toBe(2 + 20 * (0.5 + 0.375 * 2));
  });
});

describe("coveredTicks", () => {
  const rem = 16;
  const step = rulerStep(10, 40, rem);
  const ticks = rulerTicks(0, 10, 400, step, 40, rem);
  const flagAt = (x: number) =>
    presenceFlags([person("a", x / 10)], {
      start: 0,
      pxPerSecond: 10,
      width: 400,
      hit: 24,
    })[0] as PresenceFlag;
  const labelled = ticks.filter((t) => t.label !== "");

  it("is empty with no flags", () => {
    expect(coveredTicks(ticks, [], rem).size).toBe(0);
  });

  it("covers a label whose ink the flag overlaps, and no other", () => {
    const tick = labelled[1];
    expect(tick).toBeDefined();
    const x = Math.round(tick?.x ?? 0);
    const covered = coveredTicks(ticks, [flagAt(x)], rem);
    expect([...covered]).toEqual([tickKey(tick)]);
  });

  it("never covers a tick whose label was dropped", () => {
    const dropped = { time: 5, x: 50, label: "", align: "start" as const };
    expect(coveredTicks([dropped], [flagAt(50)], rem).size).toBe(0);
  });

  it("holds the boundary strictly at 4 px: touching is not covered", () => {
    const tick = labelled[1] as (typeof labelled)[number];
    const x = Math.round(tick.x);
    const inkRight = x + 5 + 0.6 * 0.6875 * 16 * tick.label.length;
    const flagFrom = (left: number): PresenceFlag => ({
      key: "a",
      people: [],
      x: left - 1,
      side: "right",
      left,
      width: 16,
      text: "A",
    });
    expect(
      coveredTicks(ticks, [flagFrom(inkRight + 4)], rem).has(tickKey(tick)),
    ).toBe(false);
    expect(
      coveredTicks(ticks, [flagFrom(inkRight + 3)], rem).has(tickKey(tick)),
    ).toBe(true);
    const inkLeft = x + 5;
    expect(
      coveredTicks(ticks, [flagFrom(inkLeft - 16 - 4)], rem).has(tickKey(tick)),
    ).toBe(false);
    expect(
      coveredTicks(ticks, [flagFrom(inkLeft - 16 - 3)], rem).has(tickKey(tick)),
    ).toBe(true);
  });

  it("scales the padding and the label with the root font", () => {
    const at20 = rulerTicks(0, 10, 400, rulerStep(10, 40, 20), 40, 20);
    const tick = at20.find(
      (t) => t.label !== "" && t.align === "start",
    ) as (typeof at20)[number];
    const x = Math.round(tick.x);
    const flag: PresenceFlag = {
      key: "a",
      people: [],
      x,
      side: "right",
      left: x + 5 + 0.6 * 0.6875 * 20 * tick.label.length + 4.5,
      width: 16,
      text: "A",
    };
    expect(coveredTicks(at20, [flag], 20).has(tickKey(tick))).toBe(true);
    expect(coveredTicks(at20, [flag], 16).has(tickKey(tick))).toBe(false);
  });

  it("covers an end-aligned label by its ink, left of the line", () => {
    const end = rulerTicks(0, 10, 400, 10, 40, rem).find(
      (t) => t.align === "end" && t.label !== "",
    );
    expect(end).toBeDefined();
    const x = Math.round(end?.x ?? 0);
    const flag = presenceFlags([person("a", (x - 8) / 10)], {
      start: 0,
      pxPerSecond: 10,
      width: 400,
      hit: 24,
    })[0] as PresenceFlag;
    expect(
      coveredTicks([end as (typeof ticks)[number]], [flag], rem).size,
    ).toBe(1);
    const far = presenceFlags([person("a", (x + 40) / 10)], {
      start: 0,
      pxPerSecond: 10,
      width: 500,
      hit: 24,
    })[0] as PresenceFlag;
    expect(coveredTicks([end as (typeof ticks)[number]], [far], rem).size).toBe(
      0,
    );
  });

  it("covers like a flag for a group pill's box", () => {
    const tick = labelled[2] as (typeof labelled)[number];
    const x = Math.round(tick.x);
    const group = presenceFlags([person("a", x / 10), person("b", x / 10)], {
      start: 0,
      pxPerSecond: 10,
      width: 400,
      hit: 24,
    })[0] as PresenceFlag;
    expect(group.people).toHaveLength(2);
    expect(coveredTicks(ticks, [group], rem).has(tickKey(tick))).toBe(true);
  });

  it("uses the wider 6 px pad to uncover and the 4 px pad to cover, so a boundary does not strobe", () => {
    const tick = labelled[1] as (typeof labelled)[number];
    const x = Math.round(tick.x);
    const inkRight = x + 5 + 0.6 * 0.6875 * 16 * tick.label.length;
    const flagAt2 = (gap: number): PresenceFlag => ({
      key: "a",
      people: [],
      x: 0,
      side: "right",
      left: inkRight + gap,
      width: 16,
      text: "A",
    });
    const key = tickKey(tick);
    let covered: ReadonlySet<string> = new Set();
    const trace: boolean[] = [];
    for (const gap of [
      8, 5, 3, 5, 4.5, 5.5, 5.9, 6.1, 5, 4.2, 3.9, 4.1, 5.9, 6.0, 6.1,
    ]) {
      covered = coveredTicks(ticks, [flagAt2(gap)], rem, covered);
      trace.push(covered.has(key));
    }
    expect(trace).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    const flips = trace.filter((v, i) => i > 0 && v !== trace[i - 1]).length;
    expect(flips).toBe(4);
  });

  it("changes once, not on every frame, when a flag oscillates 1 px around the cover boundary", () => {
    const tick = labelled[1] as (typeof labelled)[number];
    const inkRight =
      Math.round(tick.x) + 5 + 0.6 * 0.6875 * 16 * tick.label.length;
    const flag = (gap: number): PresenceFlag => ({
      key: "a",
      people: [],
      x: 0,
      side: "right",
      left: inkRight + gap,
      width: 16,
      text: "A",
    });
    let covered: ReadonlySet<string> = new Set();
    const trace: boolean[] = [];
    for (const gap of [5, 3.5, 4.5, 3.5, 4.5, 3.5, 4.5, 5.5, 3.5, 4.5, 7]) {
      covered = coveredTicks(ticks, [flag(gap)], rem, covered);
      trace.push(covered.has(tickKey(tick)));
    }
    expect(trace).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
