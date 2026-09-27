import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAbortTimeout } from "./abortTimeout";

describe("withAbortTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with a TimeoutError carrying the message", async () => {
    const p = withAbortTimeout(
      100,
      "slow",
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const e = (await caught) as DOMException;
    expect(e).toBeInstanceOf(DOMException);
    expect(e.name).toBe("TimeoutError");
    expect(e.message).toBe("slow");
  });

  it("clears the timer when fn settles", async () => {
    await expect(withAbortTimeout(100, "x", async () => 7)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);

    await expect(
      withAbortTimeout(100, "x", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
