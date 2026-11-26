import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/kits";
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
});
