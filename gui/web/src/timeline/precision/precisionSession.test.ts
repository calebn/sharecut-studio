import { describe, expect, it } from "vitest";
import {
  IDLE,
  type PrecisionAxis,
  type PrecisionEvent,
  type PrecisionState,
  precisionReducer,
} from "./precisionSession";

/** A trim end at 10 s, between hard limits 8 s and 12 s, with a neighbour edge at 10.5 s. */
const axis: PrecisionAxis = {
  clamp: (v) => Math.min(12, Math.max(8, v)),
  at: (v) => v,
  boundaries: [{ sec: 10.5, label: "a clip edge" }],
};

const target = {
  field: { kind: "trim", trackId: "t", clipId: "c", edge: "out" },
  name: "Trim end",
} as const;

function run(events: PrecisionEvent[], from: PrecisionState = IDLE) {
  return events.reduce((s, e) => precisionReducer(s, e, axis), from);
}

/** Armed at 10 s, with 100 finger px per second at full speed. */
const armed: PrecisionEvent[] = [
  { type: "arm", variant: "jog", target, origin: 10 },
  { type: "enter", pxPerSec: 100 },
];

const valueOf = (s: PrecisionState) =>
  s.phase === "precision" || s.phase === "committed" ? s.value : null;

describe("precision session", () => {
  it("goes idle → armed → precision at the origin, full speed", () => {
    const s = run(armed);
    expect(s).toMatchObject({
      phase: "precision",
      variant: "jog",
      origin: 10,
      value: 10,
      gain: 0,
    });
  });

  it("moves one 10 ms step for 1 px at full speed", () => {
    expect(valueOf(run([...armed, { type: "move", dx: 1 }]))).toBe(10.01);
  });

  it("needs 8 px for one step at the fine gain, and holds under half a step", () => {
    expect(valueOf(run([...armed, { type: "move", dx: 3, gain: 3 }]))).toBe(10);
    expect(valueOf(run([...armed, { type: "move", dx: 8, gain: 3 }]))).toBe(
      10.01,
    );
    expect(valueOf(run([...armed, { type: "move", dx: -16, gain: 3 }]))).toBe(
      9.98,
    );
  });

  it("keeps a fine step 8 px wide on a zoomed-out timeline", () => {
    const wide: PrecisionEvent[] = [
      { type: "arm", variant: "jog", target, origin: 10 },
      { type: "enter", pxPerSec: 10 },
    ];
    expect(valueOf(run([...wide, { type: "move", dx: 3, gain: 3 }]))).toBe(10);
    expect(valueOf(run([...wide, { type: "move", dx: 8, gain: 3 }]))).toBe(
      10.01,
    );
    expect(valueOf(run([...wide, { type: "move", dx: -8 }]))).toBe(9.2);
  });

  it("keeps the value when the gain changes mid-drag", () => {
    const s = run([
      ...armed,
      { type: "move", dx: 20 },
      { type: "move", dx: 0, gain: 3 },
      { type: "move", dx: 8, gain: 3 },
    ]);
    expect(valueOf(s)).toBe(10.21);
  });

  it("holds at a soft boundary until the finger pushes 16 px past it", () => {
    const caught = run([...armed, { type: "move", dx: 60 }]);
    expect(caught).toMatchObject({
      value: 10.5,
      stop: { kind: "boundary", boundary: { sec: 10.5 } },
    });
    const pushing = run([{ type: "move", dx: 15 }], caught);
    expect(valueOf(pushing)).toBe(10.5);
    const through = run([{ type: "move", dx: 3 }], pushing);
    expect(valueOf(through)).toBe(10.52);
    expect(through).toMatchObject({ held: null, stop: null });
  });

  it("frees a held value at once when the finger moves back", () => {
    const back = run([
      ...armed,
      { type: "move", dx: 60 },
      { type: "move", dx: -5 },
      { type: "move", dx: -10 },
    ]);
    expect(valueOf(back)).toBe(10.4);
  });

  it("stops at a hard limit and moves back from it at once", () => {
    const limited = run([...armed, { type: "move", dx: -500 }]);
    expect(limited).toMatchObject({ value: 8, stop: { kind: "limit" } });
    expect(valueOf(run([{ type: "move", dx: 2 }], limited))).toBe(8.02);
  });

  it("commits the value it shows", () => {
    expect(
      run([...armed, { type: "move", dx: 3 }, { type: "commit" }]),
    ).toEqual({
      phase: "committed",
      variant: "jog",
      target,
      origin: 10,
      value: 10.03,
    });
  });

  it("cancels back to the origin from any active phase, then resets", () => {
    const cancelled = run([
      ...armed,
      { type: "move", dx: 3 },
      { type: "cancel" },
    ]);
    expect(cancelled).toEqual({
      phase: "cancelled",
      variant: "jog",
      target,
      origin: 10,
    });
    expect(run([{ type: "reset" }], cancelled)).toEqual(IDLE);
    expect(
      run([
        { type: "arm", variant: "grip", target, origin: 10 },
        { type: "cancel" },
      ]).phase,
    ).toBe("cancelled");
  });

  it("ignores moves before entering and a second arm while active", () => {
    const early = run([
      { type: "arm", variant: "lens", target, origin: 10 },
      { type: "move", dx: 50 },
    ]);
    expect(early.phase).toBe("armed");
    const again = run([
      ...armed,
      { type: "arm", variant: "grip", target, origin: 3 },
    ]);
    expect(again).toMatchObject({ variant: "jog", origin: 10 });
  });

  it("moves a fade-out corner right by shortening the fade", () => {
    const fade = {
      field: { kind: "fade", trackId: "t", clipId: "c", edge: "out" },
      name: "Fade out",
    } as const;
    const fadeAxis: PrecisionAxis = {
      clamp: (v) => Math.min(2000, Math.max(0, v)),
      at: (v) => 20 - v / 1000,
      boundaries: [],
    };
    const s = [
      { type: "arm", variant: "grip", target: fade, origin: 300 },
      { type: "enter", pxPerSec: 200 },
      { type: "move", dx: 4 },
    ] as const satisfies PrecisionEvent[];
    const end = s.reduce<PrecisionState>(
      (state, e) => precisionReducer(state, e, fadeAxis),
      IDLE,
    );
    expect(valueOf(end)).toBe(280);
  });
});
