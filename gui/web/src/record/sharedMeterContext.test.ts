import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMeterContext } from "./sharedMeterContext";

describe("acquireMeterContext", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops a context whose worklet failed so the next acquirer retries", async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    let failNext = true;
    class FakeContext {
      audioWorklet: { addModule: () => Promise<void> };
      close = vi.fn(() => Promise.resolve());
      constructor() {
        const fail = failNext;
        failNext = false;
        this.audioWorklet = {
          addModule: () =>
            fail
              ? Promise.reject(new Error("worklet fetch failed"))
              : Promise.resolve(),
        };
        closes.push(this.close);
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const first = acquireMeterContext();
    if (!first) throw new Error("no context");
    await expect(first.ready).rejects.toThrow("worklet fetch failed");
    const second = acquireMeterContext();
    if (!second) throw new Error("no context");
    expect(second.ctx).not.toBe(first.ctx);
    await expect(second.ready).resolves.toBeUndefined();
    first.release();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    second.release();
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });
});
