import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackPoll } from "./fallbackPoll";

describe("createFallbackPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every interval only between start and stop", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const poll = createFallbackPoll(tick, 1000);
    vi.advanceTimersByTime(3000);
    expect(tick).not.toHaveBeenCalled();
    expect(poll.active).toBe(false);

    poll.start();
    expect(poll.active).toBe(true);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);

    poll.stop();
    expect(poll.active).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("start is idempotent while active and immediate ticks once now", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const poll = createFallbackPoll(tick, 1000);
    poll.start({ immediate: true });
    expect(tick).toHaveBeenCalledTimes(1);
    poll.start({ immediate: true });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    poll.stop();
    poll.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
