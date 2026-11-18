import { describe, expect, it } from "vitest";
import { barSignals } from "./barSignals";

const base = { time: "12:04.250" };
const following = { name: "Rosa", colorIndex: 1, detail: "in Pipeline" };

describe("barSignals", () => {
  it("counts each Status pill the bar draws", () => {
    expect(barSignals(base).pills).toBe(0);
    expect(barSignals({ ...base, solo: "Rosa" }).pills).toBe(1);
    expect(barSignals({ ...base, state: "mix-updating" }).pills).toBe(1);
    expect(barSignals({ ...base, status: "Mix out of date" }).pills).toBe(1);
    expect(barSignals({ ...base, following }).pills).toBe(1);
    expect(
      barSignals({ ...base, following, solo: "Rosa", state: "mix-updating" })
        .pills,
    ).toBe(3);
  });

  it("leaves out what the bar does not draw", () => {
    expect(barSignals({ ...base, solo: "Rosa", guest: true }).pills).toBe(0);
    expect(
      barSignals({ ...base, following: { name: "Rosa", colorIndex: 1 } }).pills,
    ).toBe(0);
  });

  it("counts an Audio error as a pill and not the status text beside it", () => {
    expect(barSignals({ ...base, state: "error" }).pills).toBe(1);
    expect(
      barSignals({ ...base, state: "error", status: "No mix yet" }).pills,
    ).toBe(1);
  });

  it("counts a Playback rate as a pill", () => {
    expect(barSignals({ ...base, rate: 2 }).pills).toBe(1);
    expect(barSignals({ ...base, rate: 2, state: "error" }).pills).toBe(2);
  });

  it("flags a left column longer than the usual clock", () => {
    expect(barSignals(base).longClock).toBe(false);
    expect(barSignals({ ...base, time: "1:02:03.250" }).longClock).toBe(true);
    expect(barSignals({ ...base, rate: 2 }).longClock).toBe(true);
  });
});
