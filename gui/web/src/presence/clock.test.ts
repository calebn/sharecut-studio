import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { applyServerClock, serverNowMs, updateClockOffset } from "./clock";

describe("presence clock", () => {
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
    expect(serverNowMs(40, 100)).toBe(140);
  });

  it("applyServerClock skips non-positive timestamps", () => {
    useDawStore.setState({ serverClockOffsetMs: 7 });
    applyServerClock(0);
    applyServerClock(undefined);
    expect(useDawStore.getState().serverClockOffsetMs).toBe(7);
  });
});

describe("presence clock", () => {
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
    expect(serverNowMs(40, 100)).toBe(140);
  });
});
