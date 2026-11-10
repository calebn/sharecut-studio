import { describe, expect, it } from "vitest";
import {
  clippingGate,
  MUTED_SPEECH_INITIAL,
  type MutedSpeechState,
  mutedSpeechGate,
} from "./alertGates";

const at = (...seconds: number[]) =>
  seconds.map((s) => ({ startMs: s * 1000 }));

describe("clippingGate", () => {
  it("stays quiet with no regions and with two", () => {
    expect(clippingGate([])).toBe(false);
    expect(clippingGate(at(1, 2))).toBe(false);
  });

  it("fires on the third region inside 30 s", () => {
    expect(clippingGate(at(1, 10, 20))).toBe(true);
  });

  it("fires when the three starts span exactly 30 s", () => {
    expect(clippingGate(at(5, 20, 35))).toBe(true);
  });

  it("stays quiet when the three starts span more than 30 s", () => {
    expect(clippingGate(at(5, 20, 35.001))).toBe(false);
    expect(clippingGate(at(0, 31, 62))).toBe(false);
  });

  it("finds a qualifying run after earlier spread-out clips", () => {
    expect(clippingGate(at(0, 100, 110, 120))).toBe(true);
  });

  it("sorts unsorted regions before windowing", () => {
    expect(clippingGate(at(20, 1, 10))).toBe(true);
    expect(clippingGate(at(62, 0, 31))).toBe(false);
  });

  it("does not mutate its input", () => {
    const regions = at(20, 1, 10);
    clippingGate(regions);
    expect(regions.map((r) => r.startMs)).toEqual([20000, 1000, 10000]);
  });
});

describe("mutedSpeechGate", () => {
  const LOUD = -30;
  const MID = -48;
  const QUIET = -70;

  function run(
    steps: readonly { ms: number; db: number | null }[],
    options: { counting?: boolean } = {},
    from: MutedSpeechState = MUTED_SPEECH_INITIAL,
  ) {
    let state = from;
    let nowMs = state.lastTickMs ?? 0;
    for (const { ms, db } of steps) {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        nowMs += 100;
        state = mutedSpeechGate(state, {
          nowMs,
          levelDb: db,
          counting: options.counting ?? true,
        });
      }
    }
    return state;
  }

  it("fires at 10 s of speech and not at 9.9 s", () => {
    expect(run([{ ms: 9_900, db: LOUD }]).fired).toBe(false);
    expect(run([{ ms: 10_000, db: LOUD }]).fired).toBe(false);
    expect(run([{ ms: 10_100, db: LOUD }]).fired).toBe(true);
  });

  it("never fires on a short burst or on silence", () => {
    expect(
      run([
        { ms: 9_000, db: LOUD },
        { ms: 60_000, db: QUIET },
      ]).fired,
    ).toBe(false);
    expect(run([{ ms: 60_000, db: QUIET }]).fired).toBe(false);
    expect(run([{ ms: 60_000, db: null }]).fired).toBe(false);
  });

  it("accumulates speech across pauses shorter than 4 s", () => {
    const pause = { ms: 1_000, db: QUIET };
    const talk = { ms: 3_000, db: LOUD };
    expect(run([talk, pause, talk, pause, talk, pause, talk]).fired).toBe(true);
  });

  it("drops the count after 4 s of quiet", () => {
    const state = run([
      { ms: 9_000, db: LOUD },
      { ms: 4_000, db: QUIET },
      { ms: 6_000, db: LOUD },
    ]);
    expect(state.fired).toBe(false);
  });

  it("clears a fired alert after 4 s of quiet", () => {
    const fired = run([{ ms: 11_000, db: LOUD }]);
    expect(fired.fired).toBe(true);
    expect(run([{ ms: 3_000, db: QUIET }], {}, fired).fired).toBe(true);
    expect(run([{ ms: 4_000, db: QUIET }], {}, fired).fired).toBe(false);
  });

  it("holds speech through the dip between enter and exit levels", () => {
    expect(
      run([
        { ms: 500, db: LOUD },
        { ms: 10_000, db: MID },
      ]).fired,
    ).toBe(true);
  });

  it("does not start speech from a level between exit and enter", () => {
    expect(run([{ ms: 60_000, db: MID }]).fired).toBe(false);
  });

  it("freezes while paused and resumes where it left off", () => {
    const early = run([{ ms: 6_000, db: LOUD }]);
    const paused = run([{ ms: 30_000, db: QUIET }], { counting: false }, early);
    expect(paused.speechMs).toBe(early.speechMs);
    expect(run([{ ms: 3_000, db: LOUD }], {}, paused).fired).toBe(false);
    expect(run([{ ms: 5_000, db: LOUD }], {}, paused).fired).toBe(true);
  });

  it("keeps a fired alert through a pause", () => {
    const fired = run([{ ms: 11_000, db: LOUD }]);
    expect(
      run([{ ms: 30_000, db: QUIET }], { counting: false }, fired).fired,
    ).toBe(true);
  });

  it("credits nothing for a tick gap over 500 ms", () => {
    const early = run([{ ms: 5_000, db: LOUD }]);
    const late = mutedSpeechGate(early, {
      nowMs: (early.lastTickMs ?? 0) + 20_000,
      levelDb: LOUD,
      counting: true,
    });
    expect(late.speechMs).toBe(early.speechMs);
    expect(late.fired).toBe(false);
  });
});
