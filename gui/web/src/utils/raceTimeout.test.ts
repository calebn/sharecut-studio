import { afterEach, describe, expect, it, vi } from "vitest";
import { raceTimeout } from "./raceTimeout";

describe("raceTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with the promise and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(raceTimeout(Promise.resolve(1), 1000, () => 0)).resolves.toBe(
      1,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with onTimeout's value when time runs out", async () => {
    vi.useFakeTimers();
    const pending = raceTimeout(new Promise<number>(() => {}), 1000, () => 0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(0);
  });

  it("rejects with what onTimeout throws", async () => {
    vi.useFakeTimers();
    const pending = raceTimeout(new Promise<number>(() => {}), 1000, () => {
      throw new Error("stalled");
    });
    const assertion = expect(pending).rejects.toThrow("stalled");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
