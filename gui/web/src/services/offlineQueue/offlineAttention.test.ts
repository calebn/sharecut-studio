import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attentionRegionLabel } from "../../stage/frame/attentionLabel";
import {
  getStorageHealth,
  reportStorageFailure,
  reportStorageOk,
  resetStorageHealth,
} from "../../state/storageHealth";
import { offlineConflict } from "../../test/fixtures";
import {
  ATTENTION_POLL_MS,
  activeConflictIds,
  conflictByCommandId,
  dismissAllConflicts,
  dismissOneConflict,
  refreshOfflineAttention,
  useOfflineAttention,
} from "./offlineAttention";

const store = vi.hoisted(() => ({
  loadGuestAttention: vi.fn(),
  dismissConflicts: vi.fn(),
  loadHostAttention: vi.fn(),
  dismissHostConflicts: vi.fn(),
}));
vi.mock("./offlineStore", () => store);

const KEY = "share:tok";
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("a failed dismissal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.loadGuestAttention
      .mockReset()
      .mockResolvedValue({ pending: 0, conflicts: [offlineConflict()] });
    store.dismissConflicts.mockReset().mockRejectedValue(new Error("no"));
  });
  afterEach(() => vi.useRealTimers());

  it("stays until Retry, through polls", async () => {
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    expect(result.current.status).toBe("ready");
    act(() => dismissAllConflicts(KEY));
    await flush();
    expect(result.current.status).toBe("dismiss-failed");
    await act(() => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS * 3));
    expect(result.current.status).toBe("dismiss-failed");
    expect(store.loadGuestAttention.mock.calls.length).toBeGreaterThan(2);
    act(() => refreshOfflineAttention(KEY));
    await flush();
    expect(result.current.status).toBe("ready");
  });
});

describe("dismissing one conflict", () => {
  const first = offlineConflict({ command: { command_id: "cut-1" } });
  const second = offlineConflict({ command: { command_id: "cut-2" } });

  beforeEach(() => {
    vi.useFakeTimers();
    store.loadGuestAttention
      .mockReset()
      .mockResolvedValue({ pending: 0, conflicts: [first, second] });
    store.dismissConflicts.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("finds a conflict by command id and lists the ids still showing", async () => {
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    expect(conflictByCommandId(KEY, "cut-2")).toBe(second);
    expect(conflictByCommandId(KEY, "missing")).toBeUndefined();
    expect(activeConflictIds(KEY)).toEqual(new Set(["cut-1", "cut-2"]));
    expect(result.current.conflicts).toHaveLength(2);
  });

  it("dismisses only that conflict and leaves the group status alone", async () => {
    let finish!: (value: unknown) => void;
    store.dismissConflicts.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    let done: Promise<boolean> | undefined;
    act(() => {
      done = dismissOneConflict(KEY, first);
    });
    expect(store.dismissConflicts).toHaveBeenCalledWith("tok", [first]);
    expect(result.current.status).toBe("ready");
    await act(async () => {
      finish({
        pending: 0,
        conflicts: [{ ...first, dismissed: true }, second],
      });
      await done;
    });
    await expect(done).resolves.toBe(true);
    expect(result.current.status).toBe("ready");
    expect(
      result.current.conflicts.filter((conflict) => !conflict.dismissed),
    ).toEqual([second]);
    expect(conflictByCommandId(KEY, "cut-1")).toBeUndefined();
  });

  it("acts once when the same conflict is dismissed twice at once", async () => {
    store.dismissConflicts.mockResolvedValue({
      pending: 0,
      conflicts: [{ ...first, dismissed: true }, second],
    });
    renderHook(() => useOfflineAttention(KEY));
    await flush();
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([
        dismissOneConflict(KEY, first),
        dismissOneConflict(KEY, first),
      ]);
    });
    expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
    expect(results).toEqual([true, false]);
  });

  it("keeps the conflict when the store refuses", async () => {
    store.dismissConflicts.mockRejectedValue(new Error("no"));
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    let kept = true;
    await act(async () => {
      kept = await dismissOneConflict(KEY, first);
    });
    expect(kept).toBe(false);
    expect(result.current.status).toBe("ready");
    expect(conflictByCommandId(KEY, "cut-1")).toBe(first);
  });
  it("lets an in-flight Dismiss all finish when one row is dropped meanwhile", async () => {
    let finishAll!: (value: unknown) => void;
    store.dismissConflicts.mockReturnValueOnce(
      new Promise((resolve) => {
        finishAll = resolve;
      }),
    );
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    act(() => dismissAllConflicts(KEY));
    expect(result.current.status).toBe("dismissing");
    store.dismissConflicts.mockResolvedValueOnce({
      pending: 0,
      conflicts: [{ ...first, dismissed: true }, second],
    });
    await act(async () => {
      await dismissOneConflict(KEY, first);
    });
    await act(async () => {
      finishAll({
        pending: 0,
        conflicts: [
          { ...first, dismissed: true },
          { ...second, dismissed: true },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.conflicts.every((c) => c.dismissed)).toBe(true);
  });

  it("clears a failed-dismissal banner once one row is dropped from a fresh read", async () => {
    store.dismissConflicts.mockRejectedValueOnce(new Error("no"));
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    act(() => dismissAllConflicts(KEY));
    await flush();
    expect(result.current.status).toBe("dismiss-failed");
    store.dismissConflicts.mockResolvedValueOnce({
      pending: 0,
      conflicts: [{ ...first, dismissed: true }, second],
    });
    await act(async () => {
      await dismissOneConflict(KEY, first);
    });
    expect(result.current.status).toBe("ready");
  });
});

describe("a device that will not open its saved edits", () => {
  const blocked = new DOMException("blocked", "SecurityError");
  const label = (status: string) =>
    attentionRegionLabel({
      pending: 0,
      conflictCount: 0,
      unreadable: status === "unreadable",
      dismissFailed: false,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    resetStorageHealth();
    store.loadGuestAttention.mockReset();
    store.loadHostAttention.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("is not saved edits that could not be read, for a guest", async () => {
    store.loadGuestAttention.mockRejectedValue(blocked);
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.loaded).toBe(true);
    expect(result.current.conflicts).toEqual([]);
    expect(label(result.current.status)).not.toContain(
      "Saved edits could not be read",
    );
    expect(getStorageHealth()).toEqual({ queue: "blocked" });
  });

  it("clears a refused read once a read works again", async () => {
    store.loadGuestAttention.mockRejectedValueOnce(blocked);
    store.loadGuestAttention.mockResolvedValue({ pending: 0, conflicts: [] });
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    expect(getStorageHealth()).toEqual({ queue: "blocked" });
    await act(() => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS));
    expect(result.current.status).toBe("ready");
    expect(getStorageHealth()).toEqual({});
  });

  it("holds a refused write across later reads that work", async () => {
    store.loadGuestAttention.mockResolvedValue({ pending: 0, conflicts: [] });
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    reportStorageFailure(
      "queue",
      new DOMException("full", "QuotaExceededError"),
    );
    for (let i = 0; i < 3; i++)
      await act(() => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS));
    expect(result.current.status).toBe("ready");
    expect(getStorageHealth()).toEqual({ queue: "full" });
    reportStorageOk("queue");
    expect(getStorageHealth()).toEqual({});
  });

  it("still calls damaged data on a guest's device unreadable", async () => {
    store.loadGuestAttention.mockRejectedValue(new Error("damaged"));
    const { result } = renderHook(() => useOfflineAttention(KEY));
    await flush();
    expect(result.current.status).toBe("unreadable");
    expect(getStorageHealth()).toEqual({});
  });

  it("still calls it unreadable for a host, who has lost a real queue", async () => {
    store.loadHostAttention.mockRejectedValue(blocked);
    const { result } = renderHook(() => useOfflineAttention("/tmp/p.json"));
    await flush();
    expect(result.current.status).toBe("unreadable");
    expect(getStorageHealth()).toEqual({});
  });
});
