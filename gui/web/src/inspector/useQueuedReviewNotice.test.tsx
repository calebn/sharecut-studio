import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import type { QueuedCommand } from "../state/offlineStore";
import {
  QUEUED_NOTICE_POLL_MS,
  useQueuedReviewNotice,
} from "./useQueuedReviewNotice";

const {
  loadHostCommandCount,
  loadCommandQueue,
  loadHostCommandQueue,
  loadHostConflicts,
  loadConflicts,
} = vi.hoisted(() => ({
  loadHostCommandCount: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandQueue: vi.fn(),
  loadHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => ({
  loadHostCommandCount,
  loadCommandQueue,
  loadHostCommandQueue,
  loadHostConflicts,
  loadConflicts,
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
    loadCommandQueue.mockReset().mockResolvedValue([]);
    loadHostCommandQueue.mockReset().mockResolvedValue([]);
    loadHostConflicts.mockReset().mockResolvedValue([]);
    loadConflicts.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears once the host queue is empty", async () => {
    loadHostCommandCount.mockResolvedValue(1);
    const { result } = renderHook(() => useQueuedReviewNotice("/tmp/p.json"));
    act(() => result.current.setQueued(true));
    expect(result.current.queued).toBe(true);
    await poll();
    expect(result.current.notice).not.toBeNull();
    loadHostCommandCount.mockResolvedValue(0);
    await poll();
    expect(result.current.notice).toBeNull();
    expect(result.current.queued).toBe(false);
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

const timingCommand: QueuedCommand = {
  command_id: "timing-1",
  client_seq: 1,
  created_at: 0,
  type: "UpdatePendingEdit",
  payload: { id: "ed1", start: 10, end: 14 },
};

describe("durable pending timing queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadHostCommandQueue.mockReset().mockResolvedValue([]);
    loadCommandQueue.mockReset().mockResolvedValue([]);
    loadHostConflicts.mockReset().mockResolvedValue([]);
    loadConflicts.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it("blocks the initial lookup and restores a queued edit after remount", async () => {
    loadHostCommandQueue.mockResolvedValue([timingCommand]);
    const first = renderHook(() => useQueuedReviewNotice("/tmp/p.json", "ed1"));
    expect(first.result.current.checking).toBe(true);
    await act(async () => {});
    expect(first.result.current.queued).toBe(true);
    first.unmount();
    const next = renderHook(() => useQueuedReviewNotice("/tmp/p.json", "ed1"));
    expect(next.result.current.checking).toBe(true);
    await act(async () => {});
    expect(next.result.current.queued).toBe(true);
    act(() => next.result.current.setQueued(false));
    expect(next.result.current.queued).toBe(true);
    loadHostCommandQueue.mockResolvedValue([]);
    await poll();
    expect(next.result.current.queued).toBe(false);
    expect(next.result.current.notice).toBeNull();
  });

  it.each(["edit", "project"])(
    "requires a new lookup after the %s changes and ignores unrelated edits",
    async (change) => {
      loadHostCommandQueue.mockResolvedValue([timingCommand]);
      const { result, rerender } = renderHook(
        ({ path, editId }) => useQueuedReviewNotice(path, editId),
        { initialProps: { path: "/tmp/p.json", editId: "ed1" } },
      );
      await act(async () => {});
      expect(result.current.queued).toBe(true);
      let finish: (queue: QueuedCommand[]) => void = () => {};
      loadHostCommandQueue.mockReturnValueOnce(
        new Promise<QueuedCommand[]>((resolve) => {
          finish = resolve;
        }),
      );
      rerender({
        path: change === "project" ? "/tmp/other.json" : "/tmp/p.json",
        editId: change === "edit" ? "ed2" : "ed1",
      });
      expect(result.current.checking).toBe(true);
      await act(async () => finish(change === "edit" ? [timingCommand] : []));
      expect(result.current.checking).toBe(false);
      expect(result.current.queued).toBe(false);
    },
  );

  it("discards an old lookup when the target changes before it resolves", async () => {
    let finish: (queue: QueuedCommand[]) => void = () => {};
    loadHostCommandQueue.mockReturnValueOnce(
      new Promise<QueuedCommand[]>((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ editId }) => useQueuedReviewNotice("/tmp/p.json", editId),
      { initialProps: { editId: "ed1" } },
    );
    rerender({ editId: "ed2" });
    await act(async () => {});
    expect(result.current.checking).toBe(false);
    await act(async () => finish([timingCommand]));
    expect(result.current.queued).toBe(false);
    expect(result.current.checking).toBe(false);
  });

  it("keeps the initial gate when storage is unreadable and retries", async () => {
    loadHostCommandQueue.mockRejectedValue(new Error("idb"));
    const { result } = renderHook(() =>
      useQueuedReviewNotice("/tmp/p.json", "ed1"),
    );
    await act(async () => {});
    expect(result.current.checking).toBe(true);
    loadHostCommandQueue.mockResolvedValue([]);
    await poll();
    expect(result.current.checking).toBe(false);
  });

  it.each([
    ["host", "applied"],
    ["host", "rejected"],
    ["guest", "applied"],
    ["guest", "rejected"],
  ])(
    "settles the exact %s command as %s without waiting for another edit",
    async (kind, outcome) => {
      const loadQueue =
        kind === "host" ? loadHostCommandQueue : loadCommandQueue;
      const loadRejections =
        kind === "host" ? loadHostConflicts : loadConflicts;
      const path = kind === "host" ? "/tmp/p.json" : shareProjectKey("tok");
      loadQueue.mockResolvedValue([timingCommand]);
      const { result } = renderHook(() => useQueuedReviewNotice(path, "ed1"));
      await act(async () => {});
      act(() => result.current.setQueued(true, timingCommand.command_id));
      await act(async () => {});
      loadQueue.mockResolvedValue([
        { ...timingCommand, command_id: "other", payload: { id: "ed2" } },
      ]);
      loadRejections.mockResolvedValue(
        outcome === "rejected"
          ? [{ command: timingCommand, reason: "stale" }]
          : [
              {
                command: { ...timingCommand, command_id: "older" },
                reason: "stale",
              },
            ],
      );
      await poll();
      expect(result.current.queued).toBe(false);
      expect(result.current.settlement).toEqual({
        commandId: "timing-1",
        outcome,
      });
      expect(loadRejections).toHaveBeenCalledWith(
        kind === "host" ? path : "tok",
      );
    },
  );

  it("does not acknowledge a drained command until its conflict lookup succeeds", async () => {
    loadHostCommandQueue.mockResolvedValue([timingCommand]);
    const { result } = renderHook(() =>
      useQueuedReviewNotice("/tmp/p.json", "ed1"),
    );
    await act(async () => {});
    act(() => result.current.setQueued(true, timingCommand.command_id));
    await act(async () => {});
    loadHostCommandQueue.mockResolvedValue([]);
    loadHostConflicts.mockRejectedValue(new Error("idb"));
    await poll();
    expect(result.current.queued).toBe(true);
    expect(result.current.settlement).toBeNull();
    loadHostConflicts.mockResolvedValue([
      { command: timingCommand, reason: "stale" },
    ]);
    await poll();
    expect(result.current.queued).toBe(false);
    expect(result.current.settlement?.outcome).toBe("rejected");
  });
});
