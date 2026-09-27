import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import {
  QUEUED_NOTICE_POLL_MS,
  useQueuedReviewNotice,
} from "./useQueuedReviewNotice";

const { loadHostCommandCount, loadCommandQueue } = vi.hoisted(() => ({
  loadHostCommandCount: vi.fn(),
  loadCommandQueue: vi.fn(),
}));

vi.mock("../state/offlineStore", () => ({
  loadHostCommandCount,
  loadCommandQueue,
}));

async function poll(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(() => vi.advanceTimersByTimeAsync(QUEUED_NOTICE_POLL_MS));
  }
}

describe("useQueuedReviewNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadHostCommandCount.mockReset();
    loadCommandQueue.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears once the host queue is empty", async () => {
    loadHostCommandCount.mockResolvedValue(1);
    const { result } = renderHook(() => useQueuedReviewNotice("/tmp/p.json"));
    act(() => result.current.setQueued(true));
    await poll();
    expect(result.current.notice).not.toBeNull();
    loadHostCommandCount.mockResolvedValue(0);
    await poll();
    expect(result.current.notice).toBeNull();
    expect(loadHostCommandCount).toHaveBeenCalledWith("/tmp/p.json");
  });

  it("clears once the guest queue is empty", async () => {
    loadCommandQueue.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useQueuedReviewNotice(shareProjectKey("tok")),
    );
    act(() => result.current.setQueued(true));
    await poll();
    expect(result.current.notice).toBeNull();
    expect(loadCommandQueue).toHaveBeenCalledWith("tok");
  });

  it("keeps the notice when the queue is unreadable", async () => {
    loadHostCommandCount.mockRejectedValue(new Error("idb"));
    const { result } = renderHook(() => useQueuedReviewNotice("/tmp/p.json"));
    act(() => result.current.setQueued(true));
    await poll();
    expect(result.current.notice).not.toBeNull();
  });

  it("does not poll when nothing is queued", async () => {
    renderHook(() => useQueuedReviewNotice("/tmp/p.json"));
    await poll(3);
    expect(loadHostCommandCount).not.toHaveBeenCalled();
  });
});
