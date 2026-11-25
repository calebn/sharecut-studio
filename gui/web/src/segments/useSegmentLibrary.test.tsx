import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/segments";
import { deferred } from "../test/deferred";
import { ApiError } from "../utils/apiError";
import { HEALTHY, LIBRARY } from "./fixtures";
import { SEGMENT_BUSY_MESSAGE, useSegmentLibrary } from "./useSegmentLibrary";

vi.mock("../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/segments")>()),
  loadSegments: vi.fn(),
  removeSegment: vi.fn(),
}));

const load = vi.mocked(api.loadSegments);
const removeSegment = vi.mocked(api.removeSegment);

beforeEach(() => {
  load.mockReset().mockResolvedValue(LIBRARY);
  removeSegment.mockReset().mockResolvedValue(undefined);
});

describe("useSegmentLibrary", () => {
  it("reads once on mount and never polls", async () => {
    const { result } = renderHook(() => useSegmentLibrary());
    expect(result.current.rows).toBeNull();
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while disabled, and reads when enabled", async () => {
    const { result, rerender } = renderHook(({ on }) => useSegmentLibrary(on), {
      initialProps: { on: false },
    });
    expect(load).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
  });

  it("reports a failed read and recovers on reload", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.error).toBe("offline"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    expect(result.current.error).toBeNull();
  });

  it("clears the failure as soon as a new read starts", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.error).toBe("offline"));
    const pending = deferred<typeof LIBRARY>();
    load.mockReturnValueOnce(pending.promise);
    act(() => result.current.reload());
    expect(result.current.error).toBeNull();
    await act(async () => pending.resolve(LIBRARY));
    expect(result.current.rows).toEqual(LIBRARY);
  });

  it("ignores a read that finishes after a newer one started", async () => {
    const stale = deferred<typeof LIBRARY>();
    load.mockReturnValueOnce(stale.promise);
    const { result } = renderHook(() => useSegmentLibrary());
    load.mockResolvedValueOnce([HEALTHY]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual([HEALTHY]));
    await act(async () => stale.resolve(LIBRARY));
    expect(result.current.rows).toEqual([HEALTHY]);
  });

  it("aborts the read when it unmounts", async () => {
    let signal: AbortSignal | undefined;
    load.mockImplementation((s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useSegmentLibrary());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("removes, drops the row at once and reads the list again", async () => {
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    load.mockResolvedValue([HEALTHY]);
    let reason: string | null = "unset";
    await act(async () => {
      reason = await result.current.remove(LIBRARY[1].id);
    });
    expect(reason).toBeNull();
    expect(removeSegment).toHaveBeenCalledWith(LIBRARY[1].id);
    await waitFor(() => expect(result.current.rows).toEqual([HEALTHY]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("explains a busy segment and keeps the row", async () => {
    removeSegment.mockRejectedValue(new ApiError("busy", "segment_busy", 409));
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    let reason: string | null = null;
    await act(async () => {
      reason = await result.current.remove(LIBRARY[0].id);
    });
    expect(reason).toBe(SEGMENT_BUSY_MESSAGE);
    expect(result.current.rows).toEqual(LIBRARY);
  });

  it("treats an already-removed segment as removed", async () => {
    removeSegment.mockRejectedValue(
      new ApiError("gone", "segment_unknown", 404),
    );
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    load.mockResolvedValue(LIBRARY.slice(1));
    let reason: string | null = "unset";
    await act(async () => {
      reason = await result.current.remove(LIBRARY[0].id);
    });
    expect(reason).toBeNull();
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY.slice(1)));
  });

  it("returns the server's words for any other failure", async () => {
    removeSegment.mockRejectedValue(
      new ApiError("Disk is read-only.", "write_failed", 500),
    );
    const { result } = renderHook(() => useSegmentLibrary());
    await waitFor(() => expect(result.current.rows).toEqual(LIBRARY));
    let reason: string | null = null;
    await act(async () => {
      reason = await result.current.remove(LIBRARY[0].id);
    });
    expect(reason).toBe("Disk is read-only.");
  });
});
