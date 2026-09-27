import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_STREAM_RECHECK_MS, startJobStatusRecheck } from "./api/pipeline";

describe("startJobStatusRecheck", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores rejections and null results, forwards values, and stops cleanly", async () => {
    vi.useFakeTimers();
    const check = vi
      .fn<() => Promise<number | null>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(42);
    const onResult = vi.fn();
    const stop = startJobStatusRecheck(check, onResult);

    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(42);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(JOB_STREAM_RECHECK_MS * 2);
    expect(check).toHaveBeenCalledTimes(3);
  });
});
