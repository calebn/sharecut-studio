import { afterEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  applyServerClock,
  currentServerClockOffsetMs,
  resetServerClock,
  serverNowMs,
  setServerClockOffsetForTests,
  updateClockOffset,
} from "./clock";

describe("presence clock", () => {
  afterEach(() => {
    resetServerClock();
  });

  it("EMA-updates offset from server_time_ns", () => {
    const now = 1_000_000;
    const serverNs = (now + 250) * 1e6;
    const next = updateClockOffset(0, serverNs, now);
    expect(next).toBeCloseTo(50, 5);
    const again = updateClockOffset(next, serverNs, now);
    expect(again).toBeCloseTo(90, 5);
  });

  it("ignores non-finite server times", () => {
    expect(updateClockOffset(12, Number.NaN, 1)).toBe(12);
    expect(updateClockOffset(12, -1, 1)).toBe(12);
  });

  it("serverNowMs adds the offset", () => {
    setServerClockOffsetForTests(40);
    expect(serverNowMs(100)).toBe(140);
  });

  it("applyServerClock skips non-positive timestamps", () => {
    setServerClockOffsetForTests(7);
    applyServerClock(0);
    applyServerClock(undefined);
    expect(currentServerClockOffsetMs()).toBe(7);
  });

  it("applyServerClock updates module state without a store notify", () => {
    resetServerClock();
    const unsub = useDawStore.subscribe(() => {
      throw new Error("clock module must not notify the DAW store");
    });
    try {
      const now = 1_000_000;
      applyServerClock((now + 250) * 1e6, now);
      expect(currentServerClockOffsetMs()).toBeCloseTo(50, 5);
    } finally {
      unsub();
    }
  });
});
