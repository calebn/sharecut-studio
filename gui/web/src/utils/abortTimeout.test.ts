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

  it("rejects with the TimeoutError when fn fails with a generic abort", async () => {
    const p = withAbortTimeout(
      100,
      "slow",
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Fetch is aborted", "AbortError")),
          );
        }),
    );
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const e = (await caught) as DOMException;
    expect(e.name).toBe("TimeoutError");
    expect(e.message).toBe("slow");
  });

  it("keeps fn's own failure when the timeout never fired", async () => {
    const failure = new DOMException("Cancelled", "AbortError");
    await expect(
      withAbortTimeout(100, "slow", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
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

  describe("with a caller signal", () => {
    const settleOnAbort = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });

    it("hands fn one signal that fires on the timeout", async () => {
      const caller = new AbortController();
      const anySpy = vi.spyOn(AbortSignal, "any");
      const p = withAbortTimeout(100, "slow", settleOnAbort, caller.signal);
      const caught = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(((await caught) as DOMException).name).toBe("TimeoutError");
      expect(anySpy).not.toHaveBeenCalled();
      anySpy.mockRestore();
    });

    it("aborts fn's signal with the caller's reason when the caller cancels", async () => {
      const caller = new AbortController();
      const p = withAbortTimeout(100, "slow", settleOnAbort, caller.signal);
      const caught = p.catch((e: unknown) => e);
      caller.abort();
      expect(((await caught) as DOMException).name).toBe("AbortError");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("aborts at once when the caller already cancelled", async () => {
      const caller = new AbortController();
      caller.abort();
      await expect(
        withAbortTimeout(100, "slow", settleOnAbort, caller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("stops listening to the caller once fn settles", async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      await withAbortTimeout(100, "x", async () => 1, caller.signal);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });
});
