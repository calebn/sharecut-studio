import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineConflict } from "../../test/fixtures";
import {
  ATTENTION_POLL_MS,
  dismissAllConflicts,
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
