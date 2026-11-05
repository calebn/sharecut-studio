import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROGRESS_RESUMED,
  PROGRESS_STALLED,
  useStallAnnouncement,
} from "./useStallAnnouncement";

type Props = { at: number | null; now: number; running?: boolean };

function setup(initial: Props) {
  return renderHook(
    ({ at, now, running = true }: Props) =>
      useStallAnnouncement([{ running, lastProgressAt: at }], now),
    { initialProps: initial },
  );
}

describe("useStallAnnouncement", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays silent on mount, fresh or already stale", () => {
    expect(setup({ at: 100, now: 105 }).result.current.message).toBe("");
    expect(setup({ at: 100, now: 200 }).result.current).toEqual({
      message: "",
      seq: 0,
    });
  });

  it("announces once when stale, again only on resume", () => {
    const { result, rerender } = setup({ at: 100, now: 105 });
    rerender({ at: 100, now: 116 });
    expect(result.current).toEqual({ message: PROGRESS_STALLED, seq: 1 });
    act(() => rerender({ at: 100, now: 117 }));
    rerender({ at: 100, now: 130 });
    expect(result.current.seq).toBe(1);
    rerender({ at: 129, now: 131 });
    expect(result.current).toEqual({ message: PROGRESS_RESUMED, seq: 2 });
    rerender({ at: 129, now: 140 });
    expect(result.current.seq).toBe(2);
  });

  it("treats a stopped job as resumed and never stale", () => {
    const { result, rerender } = setup({ at: 100, now: 120 });
    rerender({ at: 100, now: 130 });
    expect(result.current.seq).toBe(0);
    rerender({ at: 100, now: 116 });
    rerender({ at: 100, now: 117, running: false });
    expect(result.current.message).toBe(PROGRESS_RESUMED);
  });

  it("ignores a job with no progress timestamp", () => {
    const { result, rerender } = setup({ at: null, now: 10 });
    rerender({ at: null, now: 500 });
    expect(result.current.seq).toBe(0);
  });
});
