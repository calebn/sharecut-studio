import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/kits";
import { HIGHLIGHT_MS } from "../segments/useSegmentLibrary";
import { deferred } from "../test/deferred";
import { KITS } from "./fixtures";
import { useKitLibrary } from "./useKitLibrary";

vi.mock("../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/kits")>()),
  loadKits: vi.fn(),
}));

const load = vi.mocked(api.loadKits);

beforeEach(() => {
  load.mockReset().mockResolvedValue(KITS);
});

describe("useKitLibrary", () => {
  it("reads once on mount", async () => {
    const { result } = renderHook(() => useKitLibrary(true));
    expect(result.current.rows).toBeNull();
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never reads while disabled, and reads once enabled", async () => {
    const { result, rerender } = renderHook(({ on }) => useKitLibrary(on), {
      initialProps: { on: false },
    });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.rows).toBeNull();
    rerender({ on: true });
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
  });

  it("reports a failed read and recovers on reload", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useKitLibrary(true));
    await waitFor(() => expect(result.current.error).toBe("offline"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    expect(result.current.error).toBeNull();
  });

  it("reads again when it is enabled again", async () => {
    const { result, rerender } = renderHook(({ on }) => useKitLibrary(on), {
      initialProps: { on: true },
    });
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    rerender({ on: false });
    load.mockResolvedValue(KITS.slice(0, 1));
    rerender({ on: true });
    await waitFor(() => expect(result.current.rows).toEqual(KITS.slice(0, 1)));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows a kit removed elsewhere as gone after reload", async () => {
    const { result } = renderHook(() => useKitLibrary(true));
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    load.mockResolvedValue(KITS.slice(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual(KITS.slice(1)));
  });

  it("drops the stale rows when a reload fails, and recovers on the next", async () => {
    const { result } = renderHook(() => useKitLibrary(true));
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    load.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("offline"));
    expect(result.current.rows).toBeNull();
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual(KITS));
    expect(result.current.error).toBeNull();
  });

  it("aborts the read when it unmounts", () => {
    let signal: AbortSignal | undefined;
    load.mockImplementation((s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useKitLibrary(true));
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("ignores the answer of a read that a newer one replaced", async () => {
    const first = deferred<typeof KITS>();
    const second = deferred<typeof KITS>();
    load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useKitLibrary(true));
    act(() => result.current.reload());
    await act(async () => second.resolve(KITS.slice(1)));
    expect(result.current.rows).toEqual(KITS.slice(1));
    await act(async () => first.resolve(KITS));
    expect(result.current.rows).toEqual(KITS.slice(1));
  });

  it("ignores the failure of a read that a newer one replaced", async () => {
    const first = deferred<typeof KITS>();
    const second = deferred<typeof KITS>();
    load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useKitLibrary(true));
    act(() => result.current.reload());
    await act(async () => second.resolve(KITS));
    await act(async () => first.reject(new Error("late")));
    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual(KITS);
  });

  describe("reveal", () => {
    afterEach(() => vi.useRealTimers());

    it("reads again and marks the kit only once the list has been read", async () => {
      const second = deferred<typeof KITS>();
      const { result } = renderHook(() => useKitLibrary(true));
      await waitFor(() => expect(result.current.rows).toEqual(KITS));
      load.mockReturnValueOnce(second.promise);
      act(() => result.current.reveal("new-kit-1"));
      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.highlightId).toBeNull();
      await act(async () => second.resolve(KITS));
      expect(result.current.highlightId).toBe("new-kit-1");
    });

    it("clears the mark by itself", async () => {
      const { result } = renderHook(() => useKitLibrary(true));
      await waitFor(() => expect(result.current.rows).toEqual(KITS));
      vi.useFakeTimers();
      await act(async () => {
        result.current.reveal("new-kit-1");
        await Promise.resolve();
      });
      expect(result.current.highlightId).toBe("new-kit-1");
      act(() => {
        vi.advanceTimersByTime(HIGHLIGHT_MS);
      });
      expect(result.current.highlightId).toBeNull();
    });

    it("keeps the mark waiting through a failed read until a read succeeds", async () => {
      const { result } = renderHook(() => useKitLibrary(true));
      await waitFor(() => expect(result.current.rows).toEqual(KITS));
      load.mockRejectedValueOnce(new Error("down"));
      act(() => result.current.reveal("new-kit-1"));
      await waitFor(() => expect(result.current.error).toBe("down"));
      expect(result.current.highlightId).toBeNull();
      act(() => result.current.reload());
      await waitFor(() => expect(result.current.highlightId).toBe("new-kit-1"));
    });
  });
});
