import { describe, expect, it } from "vitest";
import { dbToGain, gainToDb } from "../system/envelopeMath";
import {
  editFor,
  selectedPointId,
  toHitAttrs,
  toLeafPoints,
  withPreview,
} from "./envelopePoints";
import { hitTargetProps, OWN_TAP_HIT_SURFACE_PROPS } from "./hitTargets";

const stored = { id: "p", time: 4, value: 0.8 };

describe("toLeafPoints", () => {
  it("turns gain into dB and keeps id and time", () => {
    expect(toLeafPoints([stored])).toEqual([
      { id: "p", time: 4, db: gainToDb(0.8) },
    ]);
    expect(toLeafPoints([{ id: "z", time: 1, value: 0 }])[0]!.db).toBe(-60);
  });

  it("leaves out a point whose time or level is not finite", () => {
    expect(
      toLeafPoints([
        { id: "a", time: Number.NaN, value: 1 },
        { id: "b", time: 1, value: Number.POSITIVE_INFINITY },
        { id: "c", time: 2, value: 1 },
      ]).map((p) => p.id),
    ).toEqual(["c"]);
  });
});

describe("selectedPointId", () => {
  it("is the id only for this track's point", () => {
    const sel = { kind: "envelopePoint", trackId: "t", pointId: "p" } as const;
    expect(selectedPointId(sel, "t")).toBe("p");
    expect(selectedPointId(sel, "other")).toBeNull();
    expect(selectedPointId({ kind: "track", trackId: "t" }, "t")).toBeNull();
    expect(selectedPointId(null, "t")).toBeNull();
  });
});

describe("withPreview", () => {
  it("replaces only the previewed point's time and level", () => {
    const base = [
      { id: "a", time: 1, db: 0 },
      { id: "b", time: 2, db: -3 },
    ];
    const next = withPreview(base, { id: "b", time: 2.5, db: -6 });
    expect(next).toEqual([base[0], { id: "b", time: 2.5, db: -6 }]);
    expect(next[0]).toBe(base[0]);
  });
});

describe("editFor", () => {
  it("never rewrites the level of a time-only change", () => {
    expect(editFor({ timeSeconds: 6 }, stored)).toEqual({ time: 6 });
  });

  it("never rewrites the time of a level-only change, and stores the exact gain", () => {
    expect(editFor({ db: -3 }, stored)).toEqual({ value: dbToGain(-3) });
  });

  it("is null for a change that lands on the stored values", () => {
    expect(editFor({ timeSeconds: 4 }, stored)).toBeNull();
    expect(editFor({ timeSeconds: 4 + 5e-7 }, stored)).toBeNull();
    expect(editFor({ db: gainToDb(0.8) }, stored)).toBeNull();
    expect(editFor({ db: gainToDb(0.8) + 0.004 }, stored)).toBeNull();
    expect(editFor({}, stored)).toBeNull();
  });

  it("is null at the top bound, where the leaf's 3.52 is the stored 1.5", () => {
    expect(editFor({ db: 3.52 }, { id: "p", time: 1, value: 1.5 })).toBeNull();
  });

  it("carries both axes when both changed", () => {
    expect(editFor({ timeSeconds: 5, db: -12 }, stored)).toEqual({
      time: 5,
      value: dbToGain(-12),
    });
  });
});

describe("toHitAttrs", () => {
  it("drops the absent optionals of a hit target and keeps the strings", () => {
    const attrs = toHitAttrs({
      ...hitTargetProps("envelope-point", "p", 4, { detail: "0.80" }),
      "data-hit-selected": undefined,
    });
    expect(attrs).toEqual({
      "data-hit-kind": "envelope-point",
      "data-hit-id": "p",
      "data-hit-time": "4",
      "data-hit-detail": "0.80",
    });
    expect(
      Object.values(toHitAttrs(hitTargetProps("envelope-point", "p", 1))),
    ).not.toContain(undefined);
  });

  it("passes the own-tap surface properties through", () => {
    expect(toHitAttrs(OWN_TAP_HIT_SURFACE_PROPS as never)).toEqual(
      OWN_TAP_HIT_SURFACE_PROPS,
    );
  });
});
